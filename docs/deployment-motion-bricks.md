# MotionBricks deployment

This repository's MotionBricks profile runs omp-deck in Docker and publishes the
browser UI at `/agents/omp/`. It does not start an OMP session automatically:
`OMP_DECK_AUTO_START` is deliberately empty.

## Request-routing contract

The Vite bundle is built with `OMP_DECK_BASE_PATH=/agents/omp`, so its HTML
references assets below `/agents/omp/assets/`. The Bun server still owns its
runtime routes at the origin root:

- `/api/*`
- `/ws`
- `/uploads/*`

The gateway must therefore strip `/agents/omp` for page and asset requests,
while forwarding the three root runtime routes unchanged. The public hostname
must be protected by an authentication layer such as Cloudflare Access; omp-deck
does not provide authentication itself. When a remote tunnel connector requires
a LAN origin, Caddy must strictly allowlist only that connector and the gateway
host; all other LAN peers must be denied before any OMP route is handled.

The deployed Caddy contract is:

```caddyfile
(omp_upstream) {
	header {
		X-Content-Type-Options nosniff
		X-Frame-Options DENY
		Referrer-Policy same-origin
		Permissions-Policy "camera=(), geolocation=(), microphone=()"
	}
	reverse_proxy http://omp-deck:8787
}

:8092 {
	route {
	@omp_untrusted {
		path /agents/omp /agents/omp/* /api/* /ws /uploads/*
		not remote_ip <cloudflare-connector-lan-ip> <gateway-host-lan-ip>
	}
	respond @omp_untrusted "Forbidden" 403

	@omp_missing_access_assertion {
		path /agents/omp /agents/omp/* /api/* /ws /uploads/*
		remote_ip <cloudflare-connector-lan-ip>
		not header Cf-Access-Jwt-Assertion *
	}
	respond @omp_missing_access_assertion "Forbidden" 403

	@omp_base path /agents/omp
	redir @omp_base /agents/omp/ 308

	handle_path /agents/omp/* {
		import omp_upstream
	}

	@omp_runtime path /api/* /ws /uploads/*
	handle @omp_runtime {
		import omp_upstream
	}
	}
}
```

The `route` block preserves order so the deny responses run before the proxy
handlers. The allowlist uses the immediate peer address (`remote_ip`), not
forwarded headers. The remote connector is also required to present Cloudflare
Access's JWT assertion header. The gateway host remains allowlisted so it can
run local health and routing smoke tests without fabricating an Access
assertion. Treat both allowlisted machines as trusted origin infrastructure and
update the allowlist if either address changes.

Both Caddy and `omp-deck` must join the external Docker network named
`sys-gateway_default`, which is declared in `docker-compose.yml`.

The loopback publication `127.0.0.1:8788 -> 8787` is a direct backend endpoint
for health checks and SSH tunnels. A browser using the prefixed build must enter
through the gateway; the backend intentionally does not serve
`/agents/omp/assets/*` directly.

## Verification

After starting the compose service and gateway, run this on the gateway host:

```sh
./scripts/smoke-motion-bricks-gateway.sh http://<gateway-host-lan-ip>:8092
```

The smoke verifies:

1. `/agents/omp/` returns the SPA and advertises a prefixed asset.
2. The asset is served with a JavaScript or CSS content type, not the SPA fallback.
3. `/api/health` reaches the backend and reports `"ok": true`.
4. `/ws` completes a WebSocket upgrade.
5. A missing `/uploads/*` object reaches the backend and returns 404.

From a separate, non-allowlisted LAN peer, verify the same origin is denied:

```sh
curl -sS -o /dev/null -w '%{http_code}\n' \
  http://<gateway-host-lan-ip>:8092/agents/omp/
# expected: 403
```

For the public deployment, separately verify that the unauthenticated
`https://<hostname>/agents/omp/` request is redirected to the configured access
provider rather than exposing the deck.
