#!/usr/bin/env bash
set -euo pipefail

gateway_url="${1:?usage: smoke-motion-bricks-gateway.sh http://gateway-host:port}"
gateway_url="${gateway_url%/}"
prefix="/agents/omp"

tmp_dir="$(mktemp -d)"
cleanup() {
	rm -rf -- "$tmp_dir"
}
trap cleanup EXIT

html="$(curl -fsS "${gateway_url}${prefix}/")"
asset_path="$(printf '%s' "$html" | grep -oE "${prefix}/assets/[^\" ]+\\.(js|css)" | head -1)"
if [[ -z "$asset_path" ]]; then
	echo "FAIL: the SPA did not advertise a prefixed JavaScript or CSS asset" >&2
	exit 1
fi

asset_headers="$tmp_dir/asset.headers"
asset_body="$tmp_dir/asset.body"
curl -fsS -D "$asset_headers" -o "$asset_body" "${gateway_url}${asset_path}"
if ! grep -qiE '^content-type: (application|text)/(javascript|css)' "$asset_headers"; then
	echo "FAIL: prefixed asset has an unexpected content type" >&2
	sed -n '1,20p' "$asset_headers" >&2
	exit 1
fi
if grep -qi '<!doctype html' "$asset_body"; then
	echo "FAIL: prefixed asset resolved to the SPA fallback" >&2
	exit 1
fi

health="$(curl -fsS "${gateway_url}/api/health")"
if ! grep -q '"ok":true' <<<"$health"; then
	echo "FAIL: /api/health did not report ok" >&2
	exit 1
fi

ws_headers="$tmp_dir/ws.headers"
curl --http1.1 -sS --max-time 2 -D "$ws_headers" -o /dev/null 	-H 'Connection: Upgrade' 	-H 'Upgrade: websocket' 	-H 'Sec-WebSocket-Version: 13' 	-H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' 	"${gateway_url}/ws" 2>/dev/null || true
if ! grep -qE '^HTTP/[0-9.]+ 101 ' "$ws_headers"; then
	echo "FAIL: /ws did not complete a WebSocket upgrade" >&2
	sed -n '1,20p' "$ws_headers" >&2
	exit 1
fi

upload_status="$(curl -sS -o /dev/null -w '%{http_code}' "${gateway_url}/uploads/__omp_gateway_smoke_missing__")"
if [[ "$upload_status" != "404" ]]; then
	echo "FAIL: /uploads/* did not reach the backend (HTTP $upload_status)" >&2
	exit 1
fi

printf 'PASS: MotionBricks gateway (%s, %s, API, WebSocket, uploads)\n' "$prefix" "$asset_path"
