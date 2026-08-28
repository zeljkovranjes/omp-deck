# syntax=docker/dockerfile:1.7
#
# omp-deck — single-image build.
#
# Stage 1 builds the web bundle with Vite. Stage 2 is a slim runtime that runs
# the Bun server (which natively executes .ts), serves the built web bundle as
# static files, and bridges into the embedded @oh-my-pi/pi-coding-agent SDK.
#
# Build:
#   docker build -t omp-deck .
#
# Run (loopback, expose via Tailscale Funnel / SSH tunnel on host):
#   docker run --rm -p 127.0.0.1:8787:8787 \
#     -v omp-deck-agent:/root/.omp/agent \
#     -e OMP_DECK_HOST=0.0.0.0 \
#     -e OMP_DECK_PORT=8787 \
#     omp-deck

# ─── Stage 1: build web ────────────────────────────────────────────────────
#
# `oven/bun:<ver>` is the Debian-slim variant (glibc). We avoid `-alpine`
# because `@oh-my-pi/pi-natives` ships prebuilt `.node` binaries linked
# against glibc's `ld-linux-x86-64.so.2`; Alpine's musl libc would fail
# to load them at runtime (no `linux-x64-musl` variant exists).
FROM oven/bun:1.3.14 AS web-build
WORKDIR /app

ARG OMP_DECK_BASE_PATH=/
ENV OMP_DECK_BASE_PATH=${OMP_DECK_BASE_PATH}

# Workspace manifests first for cache-friendly install. All five must be
# present so bun's frozen-lockfile resolver sees the same workspace graph
# the lockfile was generated against — including the telegram bridge,
# whose runtime is opt-in but whose manifest is part of the lockfile.
COPY package.json bun.lock* tsconfig.base.json ./
COPY packages/protocol/package.json packages/protocol/
COPY apps/web/package.json apps/web/
COPY apps/server/package.json apps/server/
COPY apps/bridges/telegram/package.json apps/bridges/telegram/
RUN bun install --frozen-lockfile

# Web sources + protocol (referenced as workspace:*).
COPY packages/protocol packages/protocol
COPY apps/web apps/web

WORKDIR /app/apps/web
RUN bun run build

# ─── Stage 2: runtime ──────────────────────────────────────────────────────
FROM oven/bun:1.3.14 AS runtime
WORKDIR /app

ARG DOTNET_SDK_VERSION=10.0.302
ENV DOTNET_ROOT=/usr/share/dotnet \
    PATH=/usr/share/dotnet:${PATH}

# The MotionBricks OMP workspace owns its Linux validation and exact-commit
# Windows handoff. Install the repository-declared toolchain in the immutable
# image; authentication and mutable state remain on the persistent mounts.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        bash \
        ca-certificates \
        curl \
        gh \
        git \
        git-lfs \
        jq \
        libicu76 \
        openssh-client \
        ripgrep \
        rsync \
        tar \
    && curl -fsSL https://dot.net/v1/dotnet-install.sh -o /tmp/dotnet-install.sh \
    && bash /tmp/dotnet-install.sh \
        --version "${DOTNET_SDK_VERSION}" \
        --install-dir "${DOTNET_ROOT}" \
        --architecture x64 \
        --os linux \
        --no-path \
    && rm -f /tmp/dotnet-install.sh \
    && git lfs install --system --skip-repo \
    && test "$(dotnet --version)" = "${DOTNET_SDK_VERSION}" \
    && git --version \
    && git-lfs --version \
    && gh --version \
    && ssh -V \
    && rsync --version | head -1 \
    && jq --version \
    && rg --version | head -1 \
    && rm -rf /var/lib/apt/lists/*

# Login shells reset the image PATH on Debian. Keep the SDK reachable from the
# standard login-shell path used by repository validation and agent commands.
RUN ln -s "${DOTNET_ROOT}/dotnet" /usr/local/bin/dotnet


# Re-install with only server-relevant workspace (still pulls protocol).
COPY package.json bun.lock* tsconfig.base.json ./
COPY packages/protocol/package.json packages/protocol/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY apps/bridges/telegram/package.json apps/bridges/telegram/

RUN bun install --frozen-lockfile --production

# The upstream OAuth client advertises localhost:1455 (required by OpenAI) and
# also binds only to container-local localhost. For this remote deployment,
# retain the advertised URI but allow the listener to bind on the container
# interface so a loopback-only host port plus SSH tunnel can reach it.
COPY scripts/patch-openai-oauth-listener.mjs scripts/
RUN bun scripts/patch-openai-oauth-listener.mjs

# Sources for runtime (Bun executes TS natively — no transpile step).
COPY packages/protocol packages/protocol
COPY apps/server apps/server
COPY starter-skills starter-skills
COPY starter-extensions starter-extensions

# Built web assets.
COPY --from=web-build /app/apps/web/dist /app/apps/web/dist

# Server resolves OMP_DECK_WEB_DIST or auto-discovers ../web/dist relative to
# its cwd. Pin it explicitly here.
ENV OMP_DECK_WEB_DIST=/app/apps/web/dist \
    OMP_DECK_HOST=0.0.0.0 \
    OMP_DECK_PORT=8787 \
    NODE_ENV=production

WORKDIR /app/apps/server
EXPOSE 8787
CMD ["bun", "src/index.ts"]
