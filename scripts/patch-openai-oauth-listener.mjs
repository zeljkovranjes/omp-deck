#!/usr/bin/env bun

/**
 * Make the SDK's OpenAI callback listener reachable through a loopback-only
 * Docker port and SSH tunnel while keeping the registered OAuth redirect URI
 * exactly `http://localhost:1455/auth/callback`.
 *
 * @oh-my-pi/pi-ai does not expose this bind address as a login option yet.
 * Keep this fail-closed build patch small and exact so an upstream source
 * change cannot silently produce a partially patched image.
 */
import { readFile, writeFile } from "node:fs/promises";

const glob = new Bun.Glob(
	"node_modules/.bun/@oh-my-pi+pi-ai@*/node_modules/@oh-my-pi/pi-ai/src/utils/oauth/openai-codex.ts",
);
const matches = [...glob.scanSync({ cwd: process.cwd(), onlyFiles: true, dot: true })];

if (matches.length !== 1) {
	throw new Error(`Expected exactly one pi-ai OpenAI OAuth source file, found ${matches.length}`);
}

const path = matches[0];
const source = await readFile(path, "utf8");
const needle = "\t\tsuper(ctrl, CALLBACK_PORT, CALLBACK_PATH);";
const replacement = `\t\tsuper(\n\t\t\tctrl,\n\t\t\tprocess.env.OMP_DECK_OAUTH_BIND_HOST\n\t\t\t\t? {\n\t\t\t\t\tpreferredPort: CALLBACK_PORT,\n\t\t\t\t\tcallbackPath: CALLBACK_PATH,\n\t\t\t\t\tcallbackHostname: process.env.OMP_DECK_OAUTH_BIND_HOST,\n\t\t\t\t\tredirectUri: \`http://localhost:\${CALLBACK_PORT}\${CALLBACK_PATH}\`,\n\t\t\t\t}\n\t\t\t\t: CALLBACK_PORT,\n\t\t\tCALLBACK_PATH,\n\t\t);`;

if (!source.includes(needle)) {
	throw new Error("pi-ai OpenAI OAuth constructor changed; refusing to apply an unsafe patch");
}

await writeFile(path, source.replace(needle, replacement));
console.log(`Patched OpenAI OAuth callback bind address in ${path}`);
