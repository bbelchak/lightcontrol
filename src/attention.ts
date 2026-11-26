/**
 * Cross-process attention state. Every supported agent session shares one state file, so the lights
 * show the most urgent reason any live session is waiting on, and the pre-alert light state is
 * captured once and restored only after the last session stops waiting. Outside the configured
 * active hours, alert events switch the lights off instead, and nothing is restored afterwards.
 */
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { type Config, configDir, loadConfig, REASON_PRIORITY, type Reason, writeJsonAtomic } from "./config.ts";
import { activeWindowStart, nextWindowEnd } from "./hours.ts";
import { getLights, hexToXy, type LightState, restoreUpdate, setLightState } from "./hue.ts";

export interface Waiter {
	/** Host process whose lifetime owns this waiter; pruned once dead. */
	pid?: number;
	reason: Reason;
	since: number;
	/** Shown regardless of active hours (`lights test`). */
	force?: boolean;
}

export interface AttentionState {
	/** Light states captured before the first alert; present exactly while an alert is shown. */
	snapshot?: Record<string, LightState>;
	/** Reason currently painted on the lights. */
	shown?: Reason;
	waiters: Record<string, Waiter>;
}

export interface AttentionOptions {
	/** Shown regardless of active hours (`lights test`). */
	force?: boolean;
	/** Host process whose lifetime owns this waiter (defaults to `process.pid`; pass `null` for none). */
	pid?: number | null;
}

export type SyncDecision =
	| { reason: Reason | undefined; pid?: number | null; force?: boolean }
	| "skip";

const statePath = path.join(configDir, "state.json");
const lockPath = path.join(configDir, "state.lock");
const monitorPidPath = path.join(configDir, "monitor.pid");
/** Longer than the worst-case critical section (snapshot GET + parallel PUTs, 4s timeout each). */
const STALE_LOCK_MS = 15_000;

/**
 * What prompted a reconcile, for blackout handling: `event` is a new enabled alert, `boundary` the
 * active window closing. Either one switches the lights off during blackout.
 */
type Trigger = "event" | "boundary";

/**
 * Sets (`reason`) or clears (`undefined`) the attention request for `key`, then repaints or
 * restores the lights if the winning reason changed. `force` ignores active hours.
 * No-op when setup has not been run.
 */
export async function setAttention(
	key: string,
	reason: Reason | undefined,
	options?: boolean | AttentionOptions,
): Promise<void> {
	const force = typeof options === "boolean" ? options : (options?.force ?? false);
	const pidOpt = typeof options === "object" ? options.pid : undefined;
	const pid = pidOpt === null ? undefined : (pidOpt ?? process.pid);
	await syncAttention(key, async () => ({ reason, pid: pid ?? null, force }));
}

/**
 * Applies a reason computed inside the attention lock, so concurrent detached hook workers
 * always reconcile against the latest on-disk intent and cannot apply stale events out of order.
 * Returns `true` while any alert or watched waiter remains active.
 */
export async function syncAttention(key: string, resolve: () => Promise<SyncDecision>): Promise<boolean> {
	const config = await loadConfig();
	if (!config) return false;
	return withLock(async () => {
		const decision = await resolve();
		const state = await readState();
		if (decision === "skip") {
			return needsMonitor(state);
		}
		const { reason, force = false } = decision;
		const pid = decision.pid === null ? undefined : (decision.pid ?? process.pid);
		if (reason) {
			state.waiters[key] = {
				...(pid !== undefined && { pid }),
				reason,
				since: Date.now(),
				...(force && { force }),
			};
		} else {
			delete state.waiters[key];
		}
		await reconcile(config, state, reason && !force && config.colors[reason] ? "event" : undefined);
		return needsMonitor(state);
	});
}

function needsMonitor(state: AttentionState): boolean {
	return Boolean(state.shown) || Object.values(state.waiters).some(w => w.pid !== undefined);
}

/** Ensures a single detached monitor process is running to watch dead PIDs and active-hours boundaries. */
export async function ensureMonitor(cliPath: string): Promise<void> {
	const existing = await readMonitorPid();
	if (existing !== undefined && isAlive(existing)) return;
	const bun = Bun.which("bun") ?? process.execPath;
	Bun.spawn([bun, cliPath, "monitor"], {
		stdio: ["ignore", "ignore", "ignore"],
		detached: true,
		env: process.env,
	}).unref();
}

/**
 * Background monitor: watches active waiters for exited host processes and switches still-showing
 * alerts off when the active hours window closes. Exits automatically once nothing needs watching.
 */
export async function runMonitor(): Promise<void> {
	if (!(await claimMonitorSlot())) return;
	try {
		for (;;) {
			const config = await loadConfig().catch(() => undefined);
			const state = await readState().catch(() => ({ waiters: {} }) as AttentionState);
			if (!config || !needsMonitor(state)) break;

			const hasDeadWaiter = Object.values(state.waiters).some(w => w.pid !== undefined && !isAlive(w.pid));
			if (hasDeadWaiter) {
				await refreshAttention().catch(() => undefined);
				continue;
			}

			if (state.shown && activeWindowStart(config.activeHours) === undefined) {
				await refreshAttention("boundary").catch(() => undefined);
				continue;
			}

			const end = nextWindowEnd(config.activeHours);
			const sleepMs = end !== undefined ? Math.max(250, Math.min(2000, end - Date.now() + 1000)) : 2000;
			await Bun.sleep(sleepMs);
		}
	} finally {
		if ((await readMonitorPid()) === process.pid) {
			await rm(monitorPidPath, { force: true }).catch(() => undefined);
		}
	}
}

async function readMonitorPid(): Promise<number | undefined> {
	try {
		const pid = Number((await readFile(monitorPidPath, "utf8")).trim());
		return Number.isInteger(pid) && pid > 0 ? pid : undefined;
	} catch {
		return undefined;
	}
}

async function claimMonitorSlot(): Promise<boolean> {
	await mkdir(configDir, { recursive: true });
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			await writeFile(monitorPidPath, `${process.pid}\n`, { flag: "wx", mode: 0o600 });
			return true;
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "EEXIST") return false;
			const existing = await readMonitorPid();
			if (existing !== undefined && existing !== process.pid && isAlive(existing)) return false;
			await rm(monitorPidPath, { force: true }).catch(() => undefined);
		}
	}
	return false;
}

/**
 * Re-evaluates the state, which restores the lights once every waiting session has died.
 * `boundary` (the active window just closed) switches a still-showing alert off.
 */
export async function refreshAttention(trigger?: "boundary"): Promise<void> {
	const config = await loadConfig();
	if (!config) return;
	await withLock(async () => reconcile(config, await readState(), trigger));
}

/** Drops every waiter and restores the lights. */
export async function resetAttention(): Promise<void> {
	await rm(path.join(configDir, "intents"), { recursive: true, force: true }).catch(() => undefined);
	const config = await loadConfig();
	if (!config) return;
	await withLock(async () => {
		const state = await readState();
		state.waiters = {};
		await reconcile(config, state);
	});
}

export async function readState(): Promise<AttentionState> {
	try {
		return JSON.parse(await readFile(statePath, "utf8")) as AttentionState;
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return { waiters: {} };
		throw err;
	}
}

async function reconcile(config: Config, state: AttentionState, trigger?: Trigger): Promise<void> {
	// Sessions that died without clearing (crash, kill -9) must not pin the lights.
	for (const [key, waiter] of Object.entries(state.waiters)) {
		if (waiter.pid !== undefined && !isAlive(waiter.pid)) delete state.waiters[key];
	}
	// Only requests made during the current window count, so one left over from blackout stays dark.
	const windowStart = activeWindowStart(config.activeHours);
	const active = new Set(
		Object.values(state.waiters)
			.filter(w => w.force || (windowStart !== undefined && w.since >= windowStart))
			.map(w => w.reason),
	);
	const target = REASON_PRIORITY.find(r => active.has(r) && config.colors[r]);

	if (!target && windowStart === undefined && (trigger === "event" || (trigger === "boundary" && state.shown))) {
		await Promise.allSettled(
			config.lights.map(id => setLightState(config.bridge, config.username, id, { on: false, transitiontime: 2 })),
		);
		delete state.snapshot;
		state.shown = undefined;
	} else if (target !== state.shown) {
		if (target) {
			state.snapshot ??= await snapshot(config);
			await paint(config, target);
		} else if (state.snapshot) {
			await Promise.allSettled(
				Object.entries(state.snapshot).map(([id, s]) =>
					setLightState(config.bridge, config.username, id, restoreUpdate(s)),
				),
			);
			delete state.snapshot;
		}
		state.shown = target;
	}
	await writeJsonAtomic(statePath, state);
}

async function snapshot(config: Config): Promise<Record<string, LightState>> {
	const lights = await getLights(config.bridge, config.username);
	const captured: Record<string, LightState> = {};
	for (const id of config.lights) {
		const light = lights[id];
		if (light) captured[id] = light.state;
	}
	return captured;
}

async function paint(config: Config, reason: Reason): Promise<void> {
	const xy = hexToXy(config.colors[reason]!);
	const results = await Promise.allSettled(
		config.lights.map(id =>
			setLightState(config.bridge, config.username, id, {
				on: true,
				bri: config.brightness,
				xy,
				transitiontime: 2,
				alert: config.flash ? "select" : "none",
			}),
		),
	);
	const failed = results.find(r => r.status === "rejected");
	if (failed && results.every(r => r.status === "rejected")) throw failed.reason;
}

export function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
}

async function withLock<T>(fn: () => Promise<T>): Promise<T> {
	await mkdir(configDir, { recursive: true });
	const deadline = Date.now() + 2 * STALE_LOCK_MS;
	for (;;) {
		try {
			await mkdir(lockPath);
			break;
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
			const info = await stat(lockPath).catch(() => undefined);
			if (info && Date.now() - info.mtimeMs > STALE_LOCK_MS) {
				await rm(lockPath, { recursive: true, force: true });
				continue;
			}
			if (Date.now() > deadline) throw new Error(`timed out waiting for ${lockPath}`);
			await Bun.sleep(25);
		}
	}
	try {
		return await fn();
	} finally {
		await rm(lockPath, { recursive: true, force: true });
	}
}
