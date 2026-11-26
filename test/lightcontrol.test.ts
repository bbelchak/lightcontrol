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
