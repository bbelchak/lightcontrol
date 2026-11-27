import { afterEach, describe, expect, test } from "bun:test";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { hashKey, type HookIntent, interpretHook } from "../src/hooks.ts";
import { detectTargets, installTarget, uninstallTarget } from "../src/install.ts";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
	const dir = await mkdtemp(path.join(tmpdir(), "lightcontrol-test-"));
	tempDirs.push(dir);
	return dir;
}

async function fileExists(p: string): Promise<boolean> {
	try {
		await access(p);
		return true;
	} catch {
		return false;
	}
}

afterEach(async () => {
	while (tempDirs.length > 0) {
		await rm(tempDirs.pop()!, { recursive: true, force: true });
	}
});

describe("interpretHook", () => {
	test("agy events map correctly with required stdout decisions", () => {
		expect(interpretHook("agy", { hookEventName: "SessionStart", conversationId: "c1" })).toEqual({
			key: "agy:c1",
			action: { type: "clear" },
			stdout: {},
		});
		expect(interpretHook("agy", { hookEventName: "PreInvocation", conversationId: "c1" })).toEqual({
			key: "agy:c1",
			action: { type: "clear" },
			stdout: {},
		});
		expect(
			interpretHook("agy", {
				hookEventName: "PreToolUse",
				conversationId: "c1",
				toolCall: { name: "ask_question" },
			}),
		).toEqual({
			key: "agy:c1",
			action: { type: "set", reason: "input" },
			stdout: { decision: "allow" },
			agyConversationId: "c1",
		});
		expect(
			interpretHook("agy", {
				hookEventName: "PreToolUse",
				conversationId: "c1",
				toolCall: { name: "run_command" },
			}),
		).toEqual({
			key: "agy:c1",
			action: { type: "noop" },
			stdout: { decision: "allow" },
		});
		expect(
			interpretHook("agy", {
				hookEventName: "PostToolUse",
				conversationId: "c1",
				toolCall: { name: "ask_question" },
			}),
		).toEqual({
			key: "agy:c1",
			action: { type: "clear-if", reason: "input" },
			stdout: {},
		});
		expect(
			interpretHook("agy", {
				hookEventName: "Stop",
				conversationId: "c1",
				terminationReason: "NO_TOOL_CALL",
				fullyIdle: true,
			}),
		).toEqual({
			key: "agy:c1",
			action: { type: "set", reason: "done", delayed: true },
			stdout: { decision: "stop" },
			agyConversationId: "c1",
		});
		expect(
			interpretHook("agy", {
				hookEventName: "Stop",
				conversationId: "c1",
				terminationReason: "USER_CANCELED",
				fullyIdle: true,
			}),
		).toEqual({
			key: "agy:c1",
			action: { type: "noop" },
			stdout: { decision: "stop" },
		});
		expect(
			interpretHook("agy", {
				hookEventName: "Stop",
				conversationId: "c1",
				terminationReason: "NO_TOOL_CALL",
				fullyIdle: false,
			}),
		).toEqual({
			key: "agy:c1",
			action: { type: "noop" },
			stdout: { decision: "stop" },
		});
	});

	test("claude events handle permissions, questions, notifications, stop, and subagents", () => {
		expect(interpretHook("claude", { hook_event_name: "UserPromptSubmit", session_id: "s1" })).toEqual({
			key: "claude:s1",
			action: { type: "clear" },
		});
		expect(interpretHook("claude", { hook_event_name: "PermissionRequest", session_id: "s1" })).toEqual({
			key: "claude:s1",
			action: { type: "set", reason: "input" },
		});
		expect(
			interpretHook("claude", {
				hook_event_name: "Notification",
				session_id: "s1",
				notification_type: "permission_prompt",
			}),
		).toEqual({
			key: "claude:s1",
			action: { type: "set", reason: "input" },
		});
		expect(
			interpretHook("claude", {
				hook_event_name: "Notification",
				session_id: "s1",
				notification_type: "idle_prompt",
			}),
		).toEqual({
			key: "claude:s1",
			action: { type: "noop" },
		});
		expect(
			interpretHook("claude", {
				hook_event_name: "PreToolUse",
				session_id: "s1",
				tool_name: "AskUserQuestion",
			}),
		).toEqual({
			key: "claude:s1",
			action: { type: "set", reason: "input" },
		});
		expect(
			interpretHook("claude", {
				hook_event_name: "PreToolUse",
				session_id: "s1",
				tool_name: "ExitPlanMode",
			}),
		).toEqual({
			key: "claude:s1",
			action: { type: "set", reason: "input" },
		});
		expect(interpretHook("claude", { hook_event_name: "PostToolUse", session_id: "s1" })).toEqual({
			key: "claude:s1",
			action: { type: "clear-if", reason: "input" },
		});
		expect(interpretHook("claude", { hook_event_name: "Stop", session_id: "s1" })).toEqual({
			key: "claude:s1",
			action: { type: "set", reason: "done", delayed: true },
		});
		expect(interpretHook("claude", { hook_event_name: "SessionEnd", session_id: "s1" })).toEqual({
			key: "claude:s1",
			action: { type: "clear" },
		});
		// Subagents carry agent_id and must be ignored.
		expect(
			interpretHook("claude", {
				hook_event_name: "Stop",
				session_id: "s1",
				agent_id: "sub-42",
			}),
		).toEqual({ action: { type: "noop" } });
	});

	test("codex events handle permissions, questions, stop, and nested threads", () => {
		expect(interpretHook("codex", { hook_event_name: "UserPromptSubmit", session_id: "t1" }, {})).toEqual({
			key: "codex:t1",
			action: { type: "clear" },
		});
		expect(interpretHook("codex", { hook_event_name: "PermissionRequest", session_id: "t1" }, {})).toEqual({
			key: "codex:t1",
			action: { type: "set", reason: "input" },
		});
		expect(
			interpretHook(
				"codex",
				{ hook_event_name: "PreToolUse", session_id: "t1", tool_name: "request_user_input" },
				{},
			),
		).toEqual({
			key: "codex:t1",
			action: { type: "set", reason: "input" },
		});
		expect(interpretHook("codex", { hook_event_name: "PostToolUse", session_id: "t1" }, {})).toEqual({
			key: "codex:t1",
			action: { type: "clear-if", reason: "input" },
		});
		expect(interpretHook("codex", { hook_event_name: "Stop", session_id: "t1" }, {})).toEqual({
			key: "codex:t1",
			action: { type: "set", reason: "done", delayed: true },
		});
		// Nested codex session spawned inside another codex shell is ignored.
		expect(
			interpretHook("codex", { hook_event_name: "Stop", session_id: "t2" }, { CODEX_THREAD_ID: "t1" }),
		).toEqual({ action: { type: "noop" } });
	});
});

describe("install and uninstall", () => {
	test("detectTargets finds configured agent directories", async () => {
		const home = await makeTempDir();
		await mkdir(path.join(home, ".claude"), { recursive: true });
		await mkdir(path.join(home, ".gemini", "config"), { recursive: true });
		const detected = await detectTargets({ home, env: {}, which: () => null });
		expect(detected).toEqual(["agy", "claude"]);
	});

	test("omp installs and uninstalls cleanly", async () => {
		const home = await makeTempDir();
		const ctx = { home, env: {}, bunPath: "/usr/local/bin/bun" };
		const res = await installTarget("omp", ctx);
		expect(await fileExists(res.path)).toBe(true);
		expect(await readFile(res.path, "utf8")).toContain("export { default } from");

		const removed = await uninstallTarget("omp", ctx);
		expect(removed?.path).toBe(res.path);
		expect(await fileExists(res.path)).toBe(false);
	});

	test("agy installs a native plugin with valid hooks.json and uninstalls cleanly", async () => {
		const home = await makeTempDir();
		const ctx = { home, env: {}, bunPath: "/usr/local/bin/bun" };
		const res = await installTarget("agy", ctx);
		const manifest = JSON.parse(await readFile(path.join(res.path, "plugin.json"), "utf8"));
		const hooks = JSON.parse(await readFile(path.join(res.path, "hooks.json"), "utf8"));

		expect(manifest.name).toBe("lightcontrol");
		expect(hooks.lightcontrol.SessionStart[0].command).toContain("hook agy");
		expect(hooks.lightcontrol.PreToolUse[0].matcher).toBe("ask_question");
		expect(hooks.lightcontrol.PostToolUse[0].matcher).toBe("ask_question");
		expect(hooks.lightcontrol.Stop[0].command).toContain("hook agy");

		await uninstallTarget("agy", ctx);
		expect(await fileExists(res.path)).toBe(false);
	});

	test("claude merges non-destructively, is idempotent, and uninstalls cleanly", async () => {
		const home = await makeTempDir();
		const settingsPath = path.join(home, ".claude", "settings.json");
		await mkdir(path.dirname(settingsPath), { recursive: true });
		const existing = {
			model: "opus",
			hooks: {
				SessionStart: [
					{
						matcher: "^startup$",
						hooks: [{ type: "command", command: "bash /other/hook.sh", timeout: 10 }],
					},
				],
				Stop: [{ hooks: [{ type: "command", command: "bash /other/stop.sh" }] }],
			},
		};
		await writeFile(settingsPath, JSON.stringify(existing, null, 2));

		const ctx = { home, env: {}, bunPath: "/usr/local/bin/bun" };
		await installTarget("claude", ctx);
		await installTarget("claude", ctx); // idempotent

		const afterInstall = JSON.parse(await readFile(settingsPath, "utf8"));
		expect(afterInstall.model).toBe("opus");
		expect(afterInstall.hooks.SessionStart).toHaveLength(2);
		expect(afterInstall.hooks.Stop).toHaveLength(2);
		expect(afterInstall.hooks.PermissionRequest).toHaveLength(1);
		expect(afterInstall.hooks.Notification[0].matcher).toContain("permission_prompt");

		await uninstallTarget("claude", ctx);
		const afterUninstall = JSON.parse(await readFile(settingsPath, "utf8"));
		expect(afterUninstall).toEqual(existing);
	});

	test("codex merges non-destructively, checks config.toml, and uninstalls cleanly", async () => {
		const home = await makeTempDir();
		const codexDir = path.join(home, ".codex");
		const hooksPath = path.join(codexDir, "hooks.json");
		await mkdir(codexDir, { recursive: true });
		const existing = {
			hooks: {
				SessionStart: [{ hooks: [{ type: "command", command: "bash /other/codex.sh", timeout: 10 }] }],
			},
		};
		await writeFile(hooksPath, JSON.stringify(existing, null, 2));
		await writeFile(path.join(codexDir, "config.toml"), "[features]\nhooks = true\n");

		const ctx = { home, env: {}, bunPath: "/usr/local/bin/bun" };
		const res = await installTarget("codex", ctx);
		expect(res.note).toContain("/hooks");
		expect(res.note).not.toContain("enable [features]");

		await installTarget("codex", ctx); // idempotent
		const afterInstall = JSON.parse(await readFile(hooksPath, "utf8"));
		expect(afterInstall.hooks.SessionStart).toHaveLength(2);
		expect(afterInstall.hooks.PermissionRequest).toHaveLength(1);
		expect(afterInstall.hooks.Stop).toHaveLength(1);

		await uninstallTarget("codex", ctx);
		const afterUninstall = JSON.parse(await readFile(hooksPath, "utf8"));
		expect(afterUninstall).toEqual(existing);
	});
});

describe("cli hook subprocess", () => {
	const cliPath = path.resolve(import.meta.dir, "../src/cli.ts");

	test("agy hook returns valid JSON and records intent without blocking", async () => {
		const configDir = await makeTempDir();
		await writeFile(
			path.join(configDir, "config.json"),
			JSON.stringify({
				bridge: "127.0.0.1",
				username: "test-user",
				lights: ["1"],
				doneDelayMs: 60_000,
			}),
		);

		const run = (agent: string, payload: unknown) =>
			Bun.spawnSync([process.execPath, cliPath, "hook", agent], {
				stdin: new TextEncoder().encode(JSON.stringify(payload)),
				stdout: "pipe",
				stderr: "pipe",
				env: { ...process.env, LIGHTCONTROL_DIR: configDir, LIGHTCONTROL_NO_SPAWN: "1" },
			});

		// PreToolUse ask_question -> allow + input intent
		const ask = run("agy", {
			hookEventName: "PreToolUse",
			conversationId: "conv-1",
			toolCall: { name: "ask_question" },
		});
		expect(ask.exitCode).toBe(0);
		expect(JSON.parse(ask.stdout.toString("utf8"))).toEqual({ decision: "allow" });

		const intentFile = path.join(configDir, "intents", `${hashKey("agy:conv-1")}.json`);
		const askIntent = JSON.parse(await readFile(intentFile, "utf8")) as HookIntent;
		expect(askIntent.reason).toBe("input");

		// Stop -> stop decision + delayed done intent
		const stop = run("agy", {
			hookEventName: "Stop",
			conversationId: "conv-1",
			terminationReason: "NO_TOOL_CALL",
			fullyIdle: true,
		});
		expect(stop.exitCode).toBe(0);
		expect(JSON.parse(stop.stdout.toString("utf8"))).toEqual({ decision: "stop" });

		const stopIntent = JSON.parse(await readFile(intentFile, "utf8")) as HookIntent;
		expect(stopIntent.reason).toBe("done");
		expect(stopIntent.readyAt).toBeGreaterThan(Date.now());

		// Claude PostToolUse with no active input intent is a fast no-op (no intent file written)
		const noopPost = run("claude", { hook_event_name: "PostToolUse", session_id: "s-noop" });
		expect(noopPost.exitCode).toBe(0);
		expect(noopPost.stdout.toString("utf8")).toBe("");
		expect(await fileExists(path.join(configDir, "intents", `${hashKey("claude:s-noop")}.json`))).toBe(false);
	});
});

describe("blackout restore", () => {
	const attentionPath = path.resolve(import.meta.dir, "../src/attention.ts");

	// Runs in a child process: config.ts fixes LIGHTCONTROL_DIR at import, the bridge is a fetch fake,
	// and the clock is fixed so the active window (08:00 to 22:00) does not depend on when tests run.
	const scenario = `
import { setSystemTime } from "bun:test";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { refreshAttention, setAttention } from ${JSON.stringify(attentionPath)};

const [mode, restore] = process.argv.slice(2);
const lights = {
	"1": { on: true, bri: 120, ct: 400, xy: [0.45, 0.41], colormode: "ct" },
	"2": { on: true, bri: 200, ct: 250, xy: [0.4, 0.4], colormode: "ct" },
};
globalThis.fetch = async (url, init) => {
	const id = /\\/lights\\/(\\w+)\\/state$/.exec(new URL(url).pathname)?.[1];
	if (init?.method === "PUT") {
		const { transitiontime, alert, ...update } = JSON.parse(init.body);
		if (update.xy) update.colormode = "xy";
		else if (update.ct) update.colormode = "ct";
		Object.assign(lights[id], update);
		return Response.json([{ success: {} }]);
	}
	return Response.json(Object.fromEntries(Object.entries(lights).map(([k, state]) => [k, { name: k, type: "x", state: { ...state } }])));
};
await writeFile(
	path.join(process.env.LIGHTCONTROL_DIR, "config.json"),
	JSON.stringify({ bridge: "bridge.test", username: "u", lights: ["1", "2"], flash: false, restoreAfterBlackout: restore === "true" }),
);
const at = (day, h, m, s = 0) => setSystemTime(new Date(2026, 0, day, h, m, s));
const record = () => JSON.parse(JSON.stringify(lights));
const out = {};

// Someone switches light 2 on overnight.
const switchOn = () => Object.assign(lights["2"], { on: true, bri: 30, ct: 454, colormode: "ct" });
if (mode === "boundary") {
	// An alert is still showing when the window closes.
	at(1, 21, 0);
	await setAttention("evening", "done", { pid: null });
	at(1, 22, 0, 1);
	await refreshAttention("boundary");
	out.night = record();
	switchOn();
} else {
	// An event during blackout, then \`lights test\` near the window opening.
	at(1, 23, 0);
	await setAttention("night", "input", { pid: null });
	out.night = record();
	switchOn();
	if (mode === "overlap") {
		// Still showing when the morning alert joins it.
		at(2, 7, 59, 58);
		await setAttention("test", "input", { pid: null, force: true });
	} else {
		// Runs and ends inside the window, before any real alert.
		at(2, 8, 0, 1);
		await setAttention("test", "input", { pid: null, force: true });
		await setAttention("test", undefined, { pid: null });
		out.afterTest = record();
	}
}
at(2, 8, 30);
await setAttention("morning", "input", { pid: null });
out.alert = record();
await setAttention("test", undefined, { pid: null });
await setAttention("morning", undefined, { pid: null });
out.answered = record();
console.log(JSON.stringify(out));
`;

	async function run(mode: "boundary" | "overlap" | "testonly", restoreAfterBlackout: boolean) {
		const dir = await makeTempDir();
		const script = path.join(dir, "scenario.ts");
		await writeFile(script, scenario);
		const proc = Bun.spawnSync([process.execPath, script, mode, String(restoreAfterBlackout)], {
			stdout: "pipe",
			stderr: "pipe",
			env: { ...process.env, LIGHTCONTROL_DIR: dir },
		});
		expect(proc.stderr.toString("utf8")).toBe("");
		return JSON.parse(proc.stdout.toString("utf8"));
	}

	for (const mode of ["boundary", "overlap", "testonly"] as const) {
		test(`${mode}: the first alert of the next window restores the pre-blackout state`, async () => {
			const out = await run(mode, true);
			expect(out.night["1"].on).toBe(false);
			expect(out.night["2"].on).toBe(false);
			expect(out.alert["1"]).toMatchObject({ on: true, colormode: "xy" });
			// Light 1 was still off as blackout left it: back to its evening state, not the alert color.
			expect(out.answered["1"]).toMatchObject({ on: true, bri: 120, ct: 400, colormode: "ct" });
			// Light 2 was switched on overnight: its current state wins.
			expect(out.answered["2"]).toMatchObject({ on: true, bri: 30, ct: 454, colormode: "ct" });
		});
	}

	test("a forced test alone does not restore the pre-blackout state", async () => {
		const out = await run("testonly", true);
		expect(out.afterTest["1"].on).toBe(false);
		expect(out.afterTest["2"]).toMatchObject({ on: true, bri: 30, ct: 454 });
	});

	test("restoreAfterBlackout: false leaves blacked-out lights off", async () => {
		const out = await run("boundary", false);
		expect(out.answered["1"].on).toBe(false);
		expect(out.answered["2"]).toMatchObject({ on: true, bri: 30, ct: 454 });
	});
});
