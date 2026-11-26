/**
 * Lifecycle hook adapter for hook-based coding agents: Antigravity (`agy`), Claude Code (`claude`),
 * and OpenAI Codex (`codex`).
 *
 * Hooks execute synchronously inside each agent, so `handleHook` only parses stdin, atomically
 * records the latest intent for that session on disk, spawns a detached `sync-hook` worker to
 * reconcile with the Hue bridge, and exits immediately without blocking the agent loop.
 */
import { createHash, randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { ensureMonitor, syncAttention } from "./attention.ts";
import { configDir, loadConfig, type Reason, writeJsonAtomic } from "./config.ts";

export type HookAgent = "agy" | "claude" | "codex";

export type HookAction =
	| { type: "set"; reason: Reason; delayed?: boolean }
	| { type: "clear" }
	| { type: "clear-if"; reason: Reason }
	| { type: "noop" };

export interface HookPlan {
	/** Cross-process waiter key for this session/conversation. */
	key?: string;
	action: HookAction;
	/** JSON response required by the agent's hook contract, if any. */
	stdout?: Record<string, unknown>;
	/** Antigravity conversation ID, used by the background worker to skip subagents. */
	agyConversationId?: string;
}

export interface HookIntent {
	key: string;
	pid: number | null;
	reason: Reason | null;
	readyAt: number;
	seq: string;
	agyConversationId?: string;
}

const intentsDir = path.join(configDir, "intents");
const SHELL_NAMES = new Set(["sh", "bash", "zsh", "dash", "fish", "ksh", "csh", "tcsh", "env", "cmd.exe"]);

const CLAUDE_INPUT_NOTIFICATIONS = new Set(["permission_prompt", "elicitation_dialog", "elicitation_url_dialog"]);
const CLAUDE_INPUT_TOOLS = new Set(["AskUserQuestion", "ExitPlanMode"]);
const CODEX_INPUT_TOOLS = new Set(["request_user_input", "ask_user"]);

function asString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Maps a single hook event payload from `agy`, `claude`, or `codex` into a normalized action. */
export function interpretHook(
	agent: HookAgent,
	payload: Record<string, unknown>,
	env: Record<string, string | undefined> = process.env,
): HookPlan {
	switch (agent) {
		case "agy":
			return interpretAgy(payload);
		case "claude":
			return interpretClaude(payload);
		case "codex":
			return interpretCodex(payload, env);
	}
}

function interpretAgy(payload: Record<string, unknown>): HookPlan {
	const event = asString(payload.hookEventName);
	const conversationId = asString(payload.conversationId);
	const key = conversationId ? `agy:${conversationId}` : undefined;
	const toolName = isRecord(payload.toolCall) ? asString(payload.toolCall.name) : undefined;

	switch (event) {
		case "SessionStart":
		case "PreInvocation":
			return { key, action: { type: "clear" }, stdout: {} };
		case "PreToolUse":
			if (toolName === "ask_question") {
				return {
					key,
					action: { type: "set", reason: "input" },
					stdout: { decision: "allow" },
					agyConversationId: conversationId,
				};
			}
			return { key, action: { type: "noop" }, stdout: { decision: "allow" } };
		case "PostToolUse":
			if (toolName === "ask_question") {
				return { key, action: { type: "clear-if", reason: "input" }, stdout: {} };
			}
			return { key, action: { type: "noop" }, stdout: {} };
		case "Stop":
			if (payload.terminationReason === "USER_CANCELED" || payload.fullyIdle === false) {
				return { key, action: { type: "noop" }, stdout: { decision: "stop" } };
			}
			return {
				key,
				action: { type: "set", reason: "done", delayed: true },
				stdout: { decision: "stop" },
				agyConversationId: conversationId,
			};
		default:
			return { key, action: { type: "noop" }, stdout: {} };
	}
}

function interpretClaude(payload: Record<string, unknown>): HookPlan {
	// Subagents and agent team workers include `agent_id`; only the main session signals lights.
	if (asString(payload.agent_id)) return { action: { type: "noop" } };

	const event = asString(payload.hook_event_name);
	const sessionId = asString(payload.session_id);
	const key = sessionId ? `claude:${sessionId}` : undefined;
	const toolName = asString(payload.tool_name);

	switch (event) {
		case "SessionStart":
		case "UserPromptSubmit":
		case "SessionEnd":
			return { key, action: { type: "clear" } };
		case "PermissionRequest":
			return { key, action: { type: "set", reason: "input" } };
		case "Notification": {
			const type = asString(payload.notification_type);
			if (type && CLAUDE_INPUT_NOTIFICATIONS.has(type)) {
				return { key, action: { type: "set", reason: "input" } };
			}
			return { key, action: { type: "noop" } };
		}
		case "PreToolUse":
			if (toolName && CLAUDE_INPUT_TOOLS.has(toolName)) {
				return { key, action: { type: "set", reason: "input" } };
			}
			return { key, action: { type: "noop" } };
		case "PostToolUse":
		case "PostToolUseFailure":
			return { key, action: { type: "clear-if", reason: "input" } };
		case "Stop":
			return { key, action: { type: "set", reason: "done", delayed: true } };
		default:
			return { key, action: { type: "noop" } };
	}
}

function interpretCodex(payload: Record<string, unknown>, env: Record<string, string | undefined>): HookPlan {
	if (asString(payload.agent_id) || asString(payload.parent_session_id)) return { action: { type: "noop" } };

	const event = asString(payload.hook_event_name);
	const sessionId = asString(payload.session_id);
	// A nested Codex run spawned inside a Codex shell carries a different CODEX_THREAD_ID.
	if (env.CODEX_THREAD_ID && sessionId && env.CODEX_THREAD_ID !== sessionId) {
		return { action: { type: "noop" } };
	}

	const key = sessionId ? `codex:${sessionId}` : undefined;
	const toolName = asString(payload.tool_name);

	switch (event) {
		case "SessionStart":
		case "UserPromptSubmit":
		case "SessionEnd":
			return { key, action: { type: "clear" } };
		case "PermissionRequest":
			return { key, action: { type: "set", reason: "input" } };
		case "PreToolUse":
			if (toolName && CODEX_INPUT_TOOLS.has(toolName)) {
				return { key, action: { type: "set", reason: "input" } };
			}
			return { key, action: { type: "noop" } };
		case "PostToolUse":
			return { key, action: { type: "clear-if", reason: "input" } };
		case "Stop":
			return { key, action: { type: "set", reason: "done", delayed: true } };
		default:
			return { key, action: { type: "noop" } };
	}
}

export function hashKey(key: string): string {
	return createHash("sha256").update(key).digest("hex").slice(0, 16);
}

function intentPath(keyHash: string): string {
	return path.join(intentsDir, `${keyHash}.json`);
}

async function readIntent(keyHash: string): Promise<HookIntent | undefined> {
	try {
		return JSON.parse(await readFile(intentPath(keyHash), "utf8")) as HookIntent;
	} catch {
		return undefined;
	}
}

/**
 * Walks ancestor processes past wrapper shells (`sh -c ...`) to find the long-lived host agent PID
 * so closed terminals / killed agents restore the lights automatically.
 */
export function findOwnerPid(startPid = process.ppid): number | null {
	let pid = startPid;
	for (let depth = 0; depth < 8 && pid > 1; depth++) {
		const res = Bun.spawnSync(["ps", "-o", "ppid=,comm=", "-p", String(pid)], {
			stdout: "pipe",
			stderr: "ignore",
		});
		if (res.exitCode !== 0) return null;
		const line = res.stdout.toString("utf8").trim();
		const match = /^(\d+)\s+(.+)$/.exec(line);
		if (!match) return null;
		const ppid = Number(match[1]);
		const comm = path.basename(match[2]!.trim()).replace(/^-/, "");
		if (!SHELL_NAMES.has(comm)) return pid;
		pid = ppid;
	}
	return null;
}

/**
 * Synchronous hook entry point: parses stdin, writes intent locally (<1ms), spawns the detached
 * `sync-hook` worker, and emits the required stdout JSON without touching the network.
 */
export async function handleHook(agent: HookAgent, stdinText: string, cliPath: string): Promise<void> {
	let payload: Record<string, unknown> = {};
	try {
		const parsed: unknown = stdinText.trim() ? JSON.parse(stdinText) : {};
		if (isRecord(parsed)) payload = parsed;
	} catch {
		payload = {};
	}

	const plan = interpretHook(agent, payload);
	try {
		if (!plan.key || plan.action.type === "noop") return;

		const keyHash = hashKey(plan.key);
		if (plan.action.type === "clear-if") {
			const current = await readIntent(keyHash);
			if (!current || current.reason !== plan.action.reason) return;
		}

		const config = await loadConfig().catch(() => undefined);
		if (!config) return;

		const now = Date.now();
		const action = plan.action;
		const intent: HookIntent =
			action.type === "set"
				? {
						key: plan.key,
						pid: findOwnerPid(),
						reason: action.reason,
						readyAt: action.delayed ? now + config.doneDelayMs : 0,
						seq: `${now}:${randomUUID()}`,
						...(plan.agyConversationId && { agyConversationId: plan.agyConversationId }),
					}
				: {
						key: plan.key,
						pid: null,
						reason: null,
						readyAt: 0,
						seq: `${now}:${randomUUID()}`,
					};
		await writeJsonAtomic(intentPath(keyHash), intent);

		if (process.env.LIGHTCONTROL_NO_SPAWN !== "1") {
			const bun = Bun.which("bun") ?? process.execPath;
			Bun.spawn([bun, cliPath, "sync-hook", keyHash], {
				stdio: ["ignore", "ignore", "ignore"],
				detached: true,
				env: process.env,
			}).unref();
		}
	} finally {
		if (plan.stdout) process.stdout.write(`${JSON.stringify(plan.stdout)}\n`);
	}
}

/**
 * Detached background worker spawned by `handleHook`. Waits out `doneDelayMs` if needed, filters
 * Antigravity subagent conversations, reconciles against the latest on-disk intent inside the lock,
 * and starts the monitor while any waiter remains active.
 */
export async function runHookSync(keyHash: string, cliPath: string): Promise<void> {
	const initial = await readIntent(keyHash);
	if (!initial) return;

	if (initial.reason === "done" && initial.readyAt > Date.now()) {
		await Bun.sleep(initial.readyAt - Date.now());
		const afterDelay = await readIntent(keyHash);
		if (!afterDelay || afterDelay.seq !== initial.seq) return;
	}

	if (initial.reason && initial.agyConversationId && (await isAgySubagent(initial.agyConversationId))) {
		const latest = await readIntent(keyHash);
		if (latest?.seq === initial.seq) await rm(intentPath(keyHash), { force: true }).catch(() => undefined);
		return;
	}

	let clearedSeq: string | undefined;
	const active = await syncAttention(initial.key, async () => {
		const latest = await readIntent(keyHash);
		if (!latest) return { reason: undefined, pid: null };
		if (latest.reason === "done" && latest.readyAt > Date.now()) return "skip";
		if (latest.reason === null) clearedSeq = latest.seq;
		return { reason: latest.reason ?? undefined, pid: latest.pid };
	});

	if (clearedSeq) {
		const latest = await readIntent(keyHash);
		if (latest?.seq === clearedSeq) await rm(intentPath(keyHash), { force: true }).catch(() => undefined);
	}

	if (active) await ensureMonitor(cliPath);
}

/** Queries the local Antigravity language server (when available) to ignore child/subagent turns. */
async function isAgySubagent(conversationId: string): Promise<boolean> {
	const address = process.env.ANTIGRAVITY_LS_ADDRESS;
	const csrf = process.env.ANTIGRAVITY_CSRF_TOKEN;
	if (!address || !csrf) return false;
	try {
		const res = await fetch(`http://${address}/product.v1.ConversationService/GetConversation`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"connect-protocol-version": "1",
				"x-antigravity-csrf-token": csrf,
			},
			body: JSON.stringify({ conversationId }),
			signal: AbortSignal.timeout(300),
		});
		if (!res.ok) return false;
		const data = (await res.json()) as { metadata?: { parentConversationId?: string } };
		return Boolean(data.metadata?.parentConversationId);
	} catch {
		return false;
	}
}
