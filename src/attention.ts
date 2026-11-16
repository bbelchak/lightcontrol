/**
 * Cross-process attention state. Every omp session shares one state file, so the lights show the
 * most urgent reason any live session is waiting on, and the pre-alert light state is captured once
 * and restored only after the last session stops waiting.
 */
import { mkdir, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { type Config, configDir, loadConfig, REASON_PRIORITY, type Reason, writeJsonAtomic } from "./config.ts";
import { getLights, hexToXy, type LightState, restoreUpdate, setLightState } from "./hue.ts";

interface Waiter {
	pid: number;
	reason: Reason;
	since: number;
}

export interface AttentionState {
	/** Light states captured before the first alert; present exactly while an alert is shown. */
	snapshot?: Record<string, LightState>;
	/** Reason currently painted on the lights. */
	shown?: Reason;
	waiters: Record<string, Waiter>;
}

const statePath = path.join(configDir, "state.json");
const lockPath = path.join(configDir, "state.lock");
/** Longer than the worst-case critical section (snapshot GET + parallel PUTs, 4s timeout each). */
const STALE_LOCK_MS = 15_000;

/**
 * Sets (`reason`) or clears (`undefined`) the attention request for `key`, then repaints or
 * restores the lights if the winning reason changed. No-op when setup has not been run.
 */
export async function setAttention(key: string, reason: Reason | undefined): Promise<void> {
	const config = await loadConfig();
	if (!config) return;
	await withLock(async () => {
		const state = await readState();
		if (reason) state.waiters[key] = { pid: process.pid, reason, since: Date.now() };
		else delete state.waiters[key];
		await reconcile(config, state);
	});
}

/** Re-evaluates the state, which restores the lights once every waiting session has died. */
export async function refreshAttention(): Promise<void> {
	const config = await loadConfig();
	if (!config) return;
	await withLock(async () => reconcile(config, await readState()));
}

/** Drops every waiter and restores the lights. */
export async function resetAttention(): Promise<void> {
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

async function reconcile(config: Config, state: AttentionState): Promise<void> {
	// Sessions that died without clearing (crash, kill -9) must not pin the lights.
	for (const [key, waiter] of Object.entries(state.waiters)) {
		if (!isAlive(waiter.pid)) delete state.waiters[key];
	}
	const active = new Set(Object.values(state.waiters).map(w => w.reason));
	const target = REASON_PRIORITY.find(r => active.has(r) && config.colors[r]);

	if (target !== state.shown) {
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
