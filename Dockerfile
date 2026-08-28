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
#     -v omp-deck-agent:/home/bun/.omp/agent \
#     -e OMP_DECK_HOST=0.0.0.0 \
#     -e OMP_DECK_PORT=8787 \
#     omp-deck

# ─── Stage 1: build web ────────────────────────────────────────────────────
#
# `oven/bun:<ver>` is the Debian-slim variant (glibc). We avoid `-alpine`
# because `@oh-my-pi/pi-natives` ships prebuilt `.node` binaries linked
# against glibc's `ld-linux-x86-64.so.2`; Alpine's musl libc would fail
# to load them at runtime (no `linux-x64-musl` variant exists).
FROM mcr.microsoft.com/dotnet/sdk:10.0.302-noble-amd64@sha256:7a91ccecc26d71bf7688c627a6b5eae2e27bb2cd1e37e8abe738348904245692 AS dotnet-sdk

FROM oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4 AS web-build
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
FROM oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4 AS runtime
WORKDIR /app

ARG DOTNET_SDK_VERSION=10.0.302
ENV DOTNET_ROOT=/usr/share/dotnet \
    PATH=/usr/share/dotnet:${PATH}

# The MotionBricks OMP workspace owns its Linux validation and exact-commit
# Copy the exact SDK from Microsoft's digest-pinned official image.
COPY --from=dotnet-sdk /usr/share/dotnet /usr/share/dotnet
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

# Bare-image runs need writable defaults even when the image executes as uid
# 1000. Compose overrides these paths with persistent bind mounts.
RUN install -d -o bun -g bun -m 0700 /home/bun/.omp /home/bun/.local/share/omp-deck

# Server resolves OMP_DECK_WEB_DIST or auto-discovers ../web/dist relative to
# its cwd. Pin it explicitly here.
ENV OMP_DECK_WEB_DIST=/app/apps/web/dist \
    OMP_DECK_HOST=0.0.0.0 \
    OMP_DECK_PORT=8787 \
    OMP_DECK_DATA_DIR=/home/bun/.local/share/omp-deck \
    OMP_DECK_DB_PATH=/home/bun/.local/share/omp-deck/deck.db \
    OMP_DECK_UPLOADS_ROOT=/home/bun/.local/share/omp-deck/uploads \
    OMP_AGENT_DIR=/home/bun/.omp/agent \
    NODE_ENV=production

WORKDIR /app/apps/server
USER bun
EXPOSE 8787
CMD ["bun", "src/index.ts"]
