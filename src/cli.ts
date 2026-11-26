#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { isAlive, readState, refreshAttention, resetAttention, runMonitor, setAttention } from "./attention.ts";
import { type Config, configPath, DEFAULTS, loadConfig, saveConfig } from "./config.ts";
import { handleHook, type HookAgent, runHookSync } from "./hooks.ts";
import { discoverBridges, getGroups, getLights, HueError, LINK_BUTTON_NOT_PRESSED, pair } from "./hue.ts";
import {
	ALL_TARGETS,
	detectTargets,
	type InstallTarget,
	installTarget,
	isInstallTarget,
	uninstallTarget,
} from "./install.ts";

const USAGE = `usage: bun run lights <command>

  setup [--bridge IP] [--lights 1,2 | --room NAME]   pair with the bridge and pick lights
  install [omp|agy|claude|codex|all ...]             install integrations (default: all detected)
  uninstall [omp|agy|claude|codex|all ...]           remove installed integrations
  list                                               show rooms and lights
  test                                               flash each alert color
  clear                                              restore lights and drop every session's alert
  status                                             show config and attention state
  hook <agy|claude|codex>                            (internal) lifecycle hook entry point
  sync-hook <hash>                                   (internal) reconcile a pending hook intent
  monitor                                            (internal) watch active waiters and active hours
  watch PID                                          (internal) restore lights after omp PID exits`;

const { positionals, values } = parseArgs({
	args: Bun.argv.slice(2),
	allowPositionals: true,
	options: { bridge: { type: "string" }, lights: { type: "string" }, room: { type: "string" } },
});

async function requireConfig(): Promise<Config> {
	const config = await loadConfig();
	if (!config) throw new Error(`no config at ${configPath}; run \`bun run lights setup\``);
	return config;
}

async function printLights(bridge: string, username: string): Promise<void> {
	const [groups, lights] = await Promise.all([getGroups(bridge, username), getLights(bridge, username)]);
	for (const group of Object.values(groups)) {
		if (group.type !== "Room" && group.type !== "Zone") continue;
		console.log(`${group.type} "${group.name}": ${group.lights.join(", ")}`);
	}
	for (const [id, light] of Object.entries(lights)) {
		const color = light.state.xy ? "color" : "white";
		const reach = light.state.reachable === false ? ", unreachable" : "";
		console.log(`  ${id.padStart(3)}  ${light.name} (${color}${reach})`);
	}
}

async function setup(): Promise<void> {
	const existing = await loadConfig().catch(() => undefined);

	let bridge = values.bridge ?? existing?.bridge;
	if (!bridge) {
		const found = await discoverBridges();
		if (found.length === 0) throw new Error("no bridge found; pass --bridge <ip>");
		bridge = found.length === 1 ? found[0]! : (prompt(`Bridges: ${found.join(", ")}\nBridge IP:`) ?? "");
	}
	console.log(`Bridge: ${bridge}`);

	let username = existing?.bridge === bridge ? existing.username : undefined;
	if (username) {
		await getLights(bridge, username).catch(err => {
			if (!(err instanceof HueError)) throw err;
			console.log("Stored key was rejected; pairing again.");
			username = undefined;
		});
	}
	if (!username) {
		console.log("Press the link button on the bridge (waiting up to 60s)...");
		const deadline = Date.now() + 60_000;
		while (!username) {
			try {
				username = await pair(bridge);
			} catch (err) {
				if (!(err instanceof HueError && err.type === LINK_BUTTON_NOT_PRESSED) || Date.now() > deadline) throw err;
				await Bun.sleep(1000);
			}
		}
		console.log("Paired.");
	}

	let lights = values.lights?.split(",").map(s => s.trim());
	let room = values.room;
	if (!lights && !room) {
		await printLights(bridge, username);
		const answer = prompt("Room/zone name or comma-separated light ids:")?.trim() ?? "";
		if (/^[\d,\s]+$/.test(answer)) lights = answer.split(",").map(s => s.trim());
		else room = answer;
	}
	if (room) {
		const groups = await getGroups(bridge, username);
		const match = Object.values(groups).find(g => g.name.toLowerCase() === room.toLowerCase());
		if (!match) throw new Error(`no room or zone named "${room}"`);
		lights = match.lights;
	}
	if (!lights?.length) throw new Error("no lights selected");

	const config: Config = { ...DEFAULTS, ...existing, bridge, username, lights };
	await saveConfig(config);
	console.log(`Saved ${configPath} (lights ${lights.join(", ")}).`);
}

function resolveRequestedTargets(raw: string[]): InstallTarget[] | null {
	if (raw.length === 0) return null;
	if (raw.includes("all")) return [...ALL_TARGETS];
	const targets: InstallTarget[] = [];
	for (const item of raw) {
		if (!isInstallTarget(item)) {
			throw new Error(`unknown target ${JSON.stringify(item)}; expected one of ${ALL_TARGETS.join(", ")}, all`);
		}
		if (!targets.includes(item)) targets.push(item);
	}
	return targets;
}

async function install(args: string[]): Promise<void> {
	const targets = resolveRequestedTargets(args) ?? (await detectTargets());
	if (targets.length === 0) {
		console.log(`No supported agents detected; pass explicit targets (${ALL_TARGETS.join(", ")}, or all).`);
		return;
	}
	for (const target of targets) {
		const res = await installTarget(target);
		console.log(`[${res.target}] Installed ${res.path}${res.note ? ` (${res.note})` : ""}.`);
	}
}

async function uninstall(args: string[]): Promise<void> {
	const targets = resolveRequestedTargets(args) ?? [...ALL_TARGETS];
	let removed = 0;
	for (const target of targets) {
		const res = await uninstallTarget(target);
		if (res) {
			removed++;
			console.log(`[${res.target}] Removed from ${res.path}.`);
		}
	}
	if (removed === 0) console.log("No lightcontrol integrations were installed.");
}

function isHookAgent(value: string | undefined): value is HookAgent {
	return value === "agy" || value === "claude" || value === "codex";
}

switch (positionals[0]) {
	case "setup":
		await setup();
		break;
	case "install":
		await install(positionals.slice(1));
		break;
	case "uninstall":
		await uninstall(positionals.slice(1));
		break;
	case "list": {
		const config = await requireConfig();
		await printLights(config.bridge, config.username);
		console.log(`Alerting: ${config.lights.join(", ")}`);
		break;
	}
	case "test": {
		await requireConfig();
		const key = `${process.pid}:cli-test`;
		for (const reason of ["input", "done"] as const) {
			console.log(reason);
			await setAttention(key, reason, true);
			await Bun.sleep(2500);
		}
		await setAttention(key, undefined);
		break;
	}
	case "clear":
		await requireConfig();
		await resetAttention();
		break;
	case "hook": {
		const agent = positionals[1];
		if (!isHookAgent(agent)) throw new Error("hook needs an agent: agy, claude, or codex");
		const stdinText = await Bun.stdin.text().catch(() => "");
		await handleHook(agent, stdinText, import.meta.path).catch(() => undefined);
		break;
	}
	case "sync-hook": {
		const keyHash = positionals[1];
		if (!keyHash) throw new Error("sync-hook needs a key hash");
		await runHookSync(keyHash, import.meta.path);
		break;
	}
	case "monitor":
		await runMonitor();
		break;
	case "watch": {
		// Spawned detached by the omp extension: covers exits that skip session_shutdown (SIGHUP, SIGTERM, crash).
		const pid = Number(positionals[1]);
		if (!Number.isInteger(pid) || pid <= 0) throw new Error("watch needs a pid");
		while (isAlive(pid)) await Bun.sleep(2000);
		await refreshAttention();
		break;
	}
	case "status": {
		const config = await loadConfig();
		const redacted = config && { ...config, username: `${config.username.slice(0, 4)}…` };
		console.log(JSON.stringify({ config: redacted, state: await readState() }, null, 2));
		break;
	}
	default:
		console.log(USAGE);
		process.exitCode = positionals[0] ? 1 : 0;
}
