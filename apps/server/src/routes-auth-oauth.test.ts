/**
 * OAuth manual-callback and cancellation tests.
 *
 * These import the production helpers. The retry channel is stateful: a
 * test-only copy of the old single Deferred would stay green while malformed
 * callback retries spin on the same value.
 */
import { describe, expect, test } from "bun:test";
import {
	abortFlow,
	closeManualCodeChannel,
	createManualCodeChannel,
	offerManualCode,
	submitManualCode,
	takeManualCode,
	validateManualCallbackInput,
	type ActiveFlow,
} from "./routes-auth-oauth.ts";

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

function makeFlow(): ActiveFlow {
	const consentReady = deferred<{ url: string; instructions?: string }>();
	const flow: ActiveFlow = {
		flowId: "test-flow",
		provider: "test-provider",
		ac: new AbortController(),
		consentReady,
		manualCode: createManualCodeChannel(),
		promptResolvers: new Map(),
		status: "awaiting-consent",
		startedAt: Date.now(),
		expirationTimer: setTimeout(() => undefined, 60_000),
	};
	flow.consentReady.promise.catch(() => {});
	return flow;
}

describe("manual OAuth callback channel", () => {
	test("delivers a value offered before a take", async () => {
		const channel = createManualCodeChannel();
		expect(offerManualCode(channel, "first")).toBe(true);
		await expect(takeManualCode(channel)).resolves.toBe("first");
	});

	test("delivers a value offered after a take", async () => {
		const channel = createManualCodeChannel();
		const waiting = takeManualCode(channel);
		expect(channel.waiters).toHaveLength(1);
		expect(offerManualCode(channel, "first")).toBe(true);
		await expect(waiting).resolves.toBe("first");
	});

	test("preserves FIFO order across multiple retries", async () => {
		const channel = createManualCodeChannel();
		expect(offerManualCode(channel, "bad-1")).toBe(true);
		expect(offerManualCode(channel, "bad-2")).toBe(true);
		await expect(takeManualCode(channel)).resolves.toBe("bad-1");
		await expect(takeManualCode(channel)).resolves.toBe("bad-2");

		const third = takeManualCode(channel);
		const fourth = takeManualCode(channel);
		expect(offerManualCode(channel, "good-3")).toBe(true);
		expect(offerManualCode(channel, "good-4")).toBe(true);
		await expect(third).resolves.toBe("good-3");
		await expect(fourth).resolves.toBe("good-4");
	});

	test("close rejects waiters, drops queued input, and refuses new offers", async () => {
		const channel = createManualCodeChannel();
		expect(offerManualCode(channel, "queued")).toBe(true);
		await expect(takeManualCode(channel)).resolves.toBe("queued");

		const waiting = takeManualCode(channel);
		waiting.catch(() => {});
		closeManualCodeChannel(channel, new Error("closed"));

		await expect(waiting).rejects.toThrow("closed");
		await expect(takeManualCode(channel)).rejects.toThrow("closed");
		expect(offerManualCode(channel, "late")).toBe(false);
		expect(channel.queued).toEqual([]);
		expect(channel.waiters).toEqual([]);
	});
});

describe("manual OAuth callback validation", () => {
	test("accepts supported callback forms", () => {
		expect(validateManualCallbackInput("http://localhost:1455/auth/callback?code=abc&state=123")).toBeNull();
		expect(validateManualCallbackInput("?code=abc&state=123")).toBeNull();
		expect(validateManualCallbackInput("raw-authorization-code")).toBeNull();
	});

	test("rejects blank, malformed, and empty-code callbacks", () => {
		expect(validateManualCallbackInput("   ")).not.toBeNull();
		expect(validateManualCallbackInput("https://localhost:1455/auth/callback?state=123")).not.toBeNull();
		expect(validateManualCallbackInput("?code=&state=123")).not.toBeNull();
		expect(validateManualCallbackInput("not a code")).not.toBeNull();
	});

	test("invalid input never enters the channel", () => {
		const channel = createManualCodeChannel();
		const result = submitManualCode(channel, "https://localhost:1455/auth/callback?state=missing-code");
		expect(result).toMatchObject({ ok: false, kind: "invalid-callback" });
		expect(channel.queued).toEqual([]);
		expect(channel.waiters).toEqual([]);
	});

	test("valid input is trimmed and enters the channel once", async () => {
		const channel = createManualCodeChannel();
		expect(submitManualCode(channel, "  raw-code  ")).toEqual({ ok: true });
		await expect(takeManualCode(channel)).resolves.toBe("raw-code");
	});

	test("a closed channel reports flow-closed", () => {
		const channel = createManualCodeChannel();
		closeManualCodeChannel(channel, new Error("closed"));
		expect(submitManualCode(channel, "raw-code")).toMatchObject({ ok: false, kind: "flow-closed" });
	});
});

describe("abortFlow cleanup", () => {
	test("rejects pending consentReady promise", async () => {
		const flow = makeFlow();
		abortFlow(flow, "cancelled");
		await expect(flow.consentReady.promise).rejects.toThrow("cancelled");
	});

	test("rejects pending manual-code waiters", async () => {
		const flow = makeFlow();
		const waiting = takeManualCode(flow.manualCode);
		waiting.catch(() => {});
		abortFlow(flow, "cancelled");
		await expect(waiting).rejects.toThrow("cancelled");
	});

	test("resolves all promptResolvers with empty strings", () => {
		const flow = makeFlow();
		const promptAnswers: string[] = [];
		flow.promptResolvers.set("p1", (answer) => promptAnswers.push(`p1:${answer}`));
		flow.promptResolvers.set("p2", (answer) => promptAnswers.push(`p2:${answer}`));
		flow.promptResolvers.set("p3", (answer) => promptAnswers.push(`p3:${answer}`));
		abortFlow(flow, "cancelled");
		expect(promptAnswers.sort()).toEqual(["p1:", "p2:", "p3:"]);
		expect(flow.promptResolvers.size).toBe(0);
	});

	test("aborts the AbortController", () => {
		const flow = makeFlow();
		expect(flow.ac.signal.aborted).toBe(false);
		abortFlow(flow, "cancelled");
		expect(flow.ac.signal.aborted).toBe(true);
	});

	test("is idempotent", () => {
		const flow = makeFlow();
		abortFlow(flow, "cancelled");
		abortFlow(flow, "cancelled-again");
		expect(flow.ac.signal.aborted).toBe(true);
	});

	test("survives a prompt resolver that throws", () => {
		const flow = makeFlow();
		flow.promptResolvers.set("throws", () => {
			throw new Error("resolver blew up");
		});
		const fineCalls: string[] = [];
		flow.promptResolvers.set("fine", (answer) => fineCalls.push(answer));
		expect(() => abortFlow(flow, "cancelled")).not.toThrow();
		expect(fineCalls).toEqual([""]);
	});
});
