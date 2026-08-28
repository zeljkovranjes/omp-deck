import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, normalize } from "node:path";

import { patchOpenAiOAuthListener } from "./patch-openai-oauth-listener.mjs";

const roots: string[] = [];

async function fixture(relativePath: string, source: string): Promise<{
	root: string;
	filePath: string;
}> {
	const root = await mkdtemp(join(tmpdir(), "omp-oauth-patch-"));
	roots.push(root);
	const filePath = join(root, relativePath);
	await mkdir(dirname(filePath), { recursive: true });
	await writeFile(filePath, source);
	return { root, filePath };
}

afterEach(async () => {
	await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe("patchOpenAiOAuthListener", () => {
	test("patches the SDK 16 registry layout without changing its advertised redirect URI", async () => {
		const relativePath =
			"node_modules/.bun/@oh-my-pi+pi-ai@16.0.1/node_modules/@oh-my-pi/pi-ai/src/registry/oauth/openai-codex.ts";
		const { root, filePath } = await fixture(
			relativePath,
			[
				"\t\tsuper(ctrl, {",
				"\t\t\tpreferredPort: CALLBACK_PORT,",
				"\t\t\tcallbackPath: CALLBACK_PATH,",
				"\t\t\t// Enforce the fixed port: OpenAI only allows http://localhost:1455/auth/callback.",
				"\t\t\t// Without this, a busy port 1455 falls back to a random port, and the token",
				"\t\t\t// exchange would fail with 403 because the redirect_uri no longer matches the",
				"\t\t\t// registered allowlist entry.",
				"\t\t\tredirectUri: `http://localhost:${CALLBACK_PORT}${CALLBACK_PATH}`,",
				"\t\t} satisfies OAuthCallbackFlowOptions);",
			].join("\n"),
		);

		expect(await patchOpenAiOAuthListener(root)).toBe(normalize(relativePath));
		const patched = await readFile(filePath, "utf8");
		expect(patched).toContain(
			'callbackHostname: process.env.OMP_DECK_OAUTH_BIND_HOST ?? "localhost"',
		);
		expect(patched).toContain(
			"redirectUri: `http://localhost:${CALLBACK_PORT}${CALLBACK_PATH}`",
		);
	});

	test("keeps the supported SDK 15 constructor layout fail-closed and patchable", async () => {
		const relativePath =
			"node_modules/.bun/@oh-my-pi+pi-ai@15.1.7/node_modules/@oh-my-pi/pi-ai/src/utils/oauth/openai-codex.ts";
		const { root, filePath } = await fixture(
			relativePath,
			"\t\tsuper(ctrl, CALLBACK_PORT, CALLBACK_PATH);\n",
		);

		expect(await patchOpenAiOAuthListener(root)).toBe(normalize(relativePath));
		const patched = await readFile(filePath, "utf8");
		expect(patched).toContain("process.env.OMP_DECK_OAUTH_BIND_HOST");
		expect(patched).toContain(
			"redirectUri: `http://localhost:${CALLBACK_PORT}${CALLBACK_PATH}`",
		);
	});

	test("refuses missing and changed SDK sources", async () => {
		const emptyRoot = await mkdtemp(join(tmpdir(), "omp-oauth-patch-"));
		roots.push(emptyRoot);
		await expect(patchOpenAiOAuthListener(emptyRoot)).rejects.toThrow("found 0");

		const relativePath =
			"node_modules/.bun/@oh-my-pi+pi-ai@16.0.1/node_modules/@oh-my-pi/pi-ai/src/registry/oauth/openai-codex.ts";
		const { root } = await fixture(relativePath, "constructor changed");
		await writeFile(
			join(root, relativePath),
			[
				"\t\tsuper(ctrl, {",
				"\t\t\tpreferredPort: CALLBACK_PORT,",
				"\t\t\tcallbackPath: CALLBACK_PATH,",
				'\t\t\tcallbackHostname: "127.0.0.1",',
				"\t\t\t// Enforce the fixed port: OpenAI only allows http://localhost:1455/auth/callback.",
				"\t\t\t// Without this, a busy port 1455 falls back to a random port, and the token",
				"\t\t\t// exchange would fail with 403 because the redirect_uri no longer matches the",
				"\t\t\t// registered allowlist entry.",
				"\t\t\tredirectUri: `http://localhost:${CALLBACK_PORT}${CALLBACK_PATH}`,",
				"\t\t} satisfies OAuthCallbackFlowOptions);",
			].join("\n"),
		);
		await expect(patchOpenAiOAuthListener(root)).rejects.toThrow("constructor changed");
	});
});
