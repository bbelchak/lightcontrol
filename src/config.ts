import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { type ActiveHours, parseHHMM } from "./hours.ts";

/** Why an agent wants attention. `input` (ask/approval/plan review) outranks `done` (agent settled). */
export type Reason = "input" | "done";
export const REASON_PRIORITY: readonly Reason[] = ["input", "done"];

export interface Config {
	/** Bridge IP or hostname. */
	bridge: string;
	/** Hue v1 application key from pairing. */
	username: string;
	/** Light ids (as the bridge reports them) to recolor. */
	lights: string[];
	/** Hex color per reason; `null` disables alerts for that reason. */
	colors: Record<Reason, string | null>;
	/** Alert brightness, 1-254. */
	brightness: number;
	/** Breathe once when the alert color is applied. */
	flash: boolean;
	/** Quiet period after the agent settles before showing `done`; absorbs auto-retries and continuations. */
	doneDelayMs: number;
	/** Local-time window for alerts; events outside it switch the lights off. `null` disables the window. */
	activeHours: ActiveHours | null;
}

export const DEFAULTS: Omit<Config, "bridge" | "username" | "lights"> = {
	colors: { input: "#ff3000", done: "#00ff50" },
	brightness: 254,
	flash: true,
	doneDelayMs: 1500,
	activeHours: { start: "08:00", end: "22:00" },
};

export const configDir = process.env.LIGHTCONTROL_DIR ?? path.join(homedir(), ".config", "lightcontrol");
export const configPath = path.join(configDir, "config.json");

/** Returns `undefined` when setup has not been run. */
export async function loadConfig(): Promise<Config | undefined> {
	let raw: string;
	try {
		raw = await readFile(configPath, "utf8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw err;
	}
	const parsed = JSON.parse(raw) as Partial<Config>;
	if (!parsed.bridge || !parsed.username || !Array.isArray(parsed.lights)) {
		throw new Error(`${configPath}: bridge, username and lights are required; rerun setup`);
	}
	const config = {
		...DEFAULTS,
		...parsed,
		colors: { ...DEFAULTS.colors, ...parsed.colors },
	} as Config;
	if (config.activeHours) {
		parseHHMM(config.activeHours.start);
		parseHHMM(config.activeHours.end);
	}
	return config;
}

export async function saveConfig(config: Config): Promise<void> {
	await writeJsonAtomic(configPath, config);
}

export async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
	await mkdir(path.dirname(file), { recursive: true });
	const tmp = `${file}.${process.pid}.tmp`;
	await writeFile(tmp, `${JSON.stringify(value, null, "\t")}\n`, { mode: 0o600 });
	await rename(tmp, file);
}
