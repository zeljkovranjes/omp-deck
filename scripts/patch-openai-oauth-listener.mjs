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

const legacyNeedle = "\t\tsuper(ctrl, CALLBACK_PORT, CALLBACK_PATH);";
const legacyReplacement = `\t\tsuper(
\t\t\tctrl,
\t\t\tprocess.env.OMP_DECK_OAUTH_BIND_HOST
\t\t\t\t? {
\t\t\t\t\tpreferredPort: CALLBACK_PORT,
\t\t\t\t\tcallbackPath: CALLBACK_PATH,
\t\t\t\t\tcallbackHostname: process.env.OMP_DECK_OAUTH_BIND_HOST,
\t\t\t\t\tredirectUri: \`http://localhost:\${CALLBACK_PORT}\${CALLBACK_PATH}\`,
\t\t\t\t}
\t\t\t\t: CALLBACK_PORT,
\t\t\tCALLBACK_PATH,
\t\t);`;

const registryNeedle = "\t\t\tcallbackPath: CALLBACK_PATH,\n";
const registryReplacement =
	registryNeedle +
	'\t\t\tcallbackHostname: process.env.OMP_DECK_OAUTH_BIND_HOST ?? "localhost",\n';

const variants = [
	{
		glob: "node_modules/.bun/@oh-my-pi+pi-ai@*/node_modules/@oh-my-pi/pi-ai/src/registry/oauth/openai-codex.ts",
		needle: registryNeedle,
		replacement: registryReplacement,
	},
	{
		glob: "node_modules/.bun/@oh-my-pi+pi-ai@*/node_modules/@oh-my-pi/pi-ai/src/utils/oauth/openai-codex.ts",
		needle: legacyNeedle,
		replacement: legacyReplacement,
	},
];

export async function patchOpenAiOAuthListener(root = process.cwd()) {
	const matches = variants.flatMap(variant =>
		[...new Bun.Glob(variant.glob).scanSync({ cwd: root, onlyFiles: true, dot: true })].map(
			path => ({ ...variant, path }),
		),
	);
	if (matches.length !== 1) {
		throw new Error(
			`Expected exactly one supported pi-ai OpenAI OAuth source file, found ${matches.length}`,
		);
	}

	const { path, needle, replacement } = matches[0];
	const source = await readFile(`${root}/${path}`, "utf8");
	if (!source.includes(needle)) {
		throw new Error("pi-ai OpenAI OAuth constructor changed; refusing to apply an unsafe patch");
	}

	await writeFile(`${root}/${path}`, source.replace(needle, replacement));
	return path;
}

if (import.meta.main) {
	const path = await patchOpenAiOAuthListener();
	console.log(`Patched OpenAI OAuth callback bind address in ${path}`);
}
