/**
 * omp extension: recolors Hue lights while the main session waits on the user.
 *  - `input`: an `ask` prompt, tool approval, or plan review is open
 *  - `done`: the agent settled and is waiting for the next prompt
 * The lights return to their previous state when the user responds.
 */
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { refreshAttention, resetAttention, setAttention } from "./attention.ts";
import { DEFAULTS, loadConfig, type Reason } from "./config.ts";
import { nextWindowEnd } from "./hours.ts";

let watcherStarted = false;

/**
 * omp exits on SIGTERM/SIGINT (e.g. a closed terminal) without session_shutdown, so a detached
 * process waits for this one to exit and then restores the lights if nothing else is waiting.
 */
function startExitWatcher(): void {
	if (watcherStarted) return;
	watcherStarted = true;
	const bun = Bun.which("bun") ?? process.execPath;
	Bun.spawn([bun, path.join(import.meta.dir, "cli.ts"), "watch", String(process.pid)], {
		stdio: ["ignore", "ignore", "ignore"],
		detached: true,
	}).unref();
}

export default function lightcontrol(pi: ExtensionAPI): void {
	// omp marks the shells it spawns with OMPCODE=1; a nested `omp` there is not the one the user watches.
	if (process.env.OMPCODE === "1") return;

	const key = `${process.pid}:${randomUUID()}`;
	/** Open ask/approval/plan-review ids. */
	const blockers = new Set<string>();
	let settled = false;
	let doneTimer: NodeJS.Timeout | undefined;
	let published: Reason | undefined;
	let boundaryTimer: NodeJS.Timeout | undefined;
	let queue = Promise.resolve();

	const watched = (ctx: ExtensionContext) => ctx.hasUI && ctx.agent.kind === "main";

	/** Serialized so a slow bridge cannot reorder alert/clear. */
	function enqueue(step: () => Promise<void>): void {
		queue = queue
			.then(step)
			.catch(err => pi.logger.warn("lightcontrol: failed to update lights", { error: String(err) }));
	}

	/** While this session waits, switches the lights off when the active window closes. Runs inside the queue. */
	async function armBoundary(): Promise<void> {
		clearTimeout(boundaryTimer);
		boundaryTimer = undefined;
		if (!published) return;
		const end = nextWindowEnd((await loadConfig())?.activeHours ?? null);
		if (end === undefined) return;
		// The margin puts the refresh past the boundary minute, inside blackout.
		boundaryTimer = setTimeout(
			() =>
				enqueue(async () => {
					await refreshAttention("boundary");
					await armBoundary();
				}),
			end - Date.now() + 1000,
		);
		boundaryTimer.unref();
	}

	function publish(): void {
		const reason: Reason | undefined = blockers.size > 0 ? "input" : settled ? "done" : undefined;
		if (reason === published) return;
		if (reason) startExitWatcher();
		published = reason;
		enqueue(async () => {
			await setAttention(key, reason);
			await armBoundary();
		});
	}

	function cancelDone(): void {
		clearTimeout(doneTimer);
		doneTimer = undefined;
	}

	function userIsBack(): void {
		cancelDone();
		settled = false;
		publish();
	}

	function block(id: string, ctx: ExtensionContext): void {
		if (!watched(ctx)) return;
		cancelDone();
		blockers.add(id);
		publish();
	}

	function unblock(id: string): void {
		if (blockers.delete(id)) publish();
	}

	pi.on("input", (_event, ctx) => {
		if (watched(ctx)) userIsBack();
	});
	pi.on("agent_start", (_event, ctx) => {
		if (watched(ctx)) userIsBack();
	});
	pi.on("auto_retry_start", cancelDone);

	pi.on("agent_end", async (event, ctx) => {
		if (!watched(ctx) || event.willContinue || event.awaitingAsyncWork) return;
		const last = event.messages.findLast(m => m.role === "assistant");
		// Esc means the user is already at the keyboard.
		if (last && "stopReason" in last && last.stopReason === "aborted") return;
		const delay = (await loadConfig().catch(() => undefined))?.doneDelayMs ?? DEFAULTS.doneDelayMs;
		cancelDone();
		doneTimer = setTimeout(() => {
			doneTimer = undefined;
			settled = true;
			publish();
		}, delay);
		doneTimer.unref();
	});

	pi.on("tool_execution_start", (event, ctx) => {
		if (event.toolName === "ask") block(event.toolCallId, ctx);
	});
	pi.on("tool_execution_end", event => unblock(event.toolCallId));
	pi.on("tool_approval_requested", (event, ctx) => block(event.toolCallId, ctx));
	pi.on("tool_approval_resolved", event => unblock(event.toolCallId));
	pi.on("plan_review_requested", (event, ctx) => block(event.reviewId, ctx));
	pi.on("plan_review_resolved", event => unblock(event.reviewId));

	// Prunes alerts left by sessions that died without session_shutdown (kill -9, crash).
	pi.on("session_start", (_event, ctx) => {
		if (!watched(ctx)) return;
		enqueue(() => setAttention(key, undefined));
	});
	pi.on("session_switch", () => {
		blockers.clear();
		userIsBack();
	});
	pi.on("session_shutdown", async () => {
		cancelDone();
		blockers.clear();
		settled = false;
		publish();
		await queue;
	});

	pi.registerCommand("lights", {
		description: "Hue attention lights: `clear` restores them for every session, `test` flashes each color",
		getArgumentCompletions: prefix =>
			["clear", "test"].filter(c => c.startsWith(prefix)).map(c => ({ value: c, label: c })),
		handler: async (args, ctx) => {
			const sub = args.trim();
			if (sub === "clear") {
				blockers.clear();
				userIsBack();
				await queue;
				await resetAttention();
				ctx.ui.notify("Lights restored");
			} else if (sub === "test") {
				for (const reason of ["input", "done"] as const) {
					ctx.ui.notify(`Lights: ${reason}`);
					await setAttention(key, reason, true);
					await Bun.sleep(2500);
				}
				await setAttention(key, published);
			} else {
				ctx.ui.notify("Usage: /lights clear | test", "warning");
			}
		},
	});
}
