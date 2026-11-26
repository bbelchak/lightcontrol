/**
 * Installs and uninstalls lightcontrol integrations for omp, Antigravity (`agy`), Claude Code
 * (`claude`), and OpenAI Codex (`codex`). Merges non-destructively into shared JSON config files
 * (`~/.claude/settings.json`, `~/.codex/hooks.json`) and writes isolated extension/plugin files
 * for `omp` and `agy`.
 */
import { access, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { HookAgent } from "./hooks.ts";

export type InstallTarget = "omp" | HookAgent;
export const ALL_TARGETS: readonly InstallTarget[] = ["omp", "agy", "claude", "codex"];

export interface InstallContext {
	home?: string;
	env?: Record<string, string | undefined>;
	cliPath?: string;
	extensionPath?: string;
	bunPath?: string;
	which?: (bin: string) => string | null;
}

export interface InstallResult {
	target: InstallTarget;
	path: string;
	note?: string;
}

interface HookCommand {
	type: "command";
	command: string;
	timeout?: number;
}

interface HookGroup {
	matcher?: string;
	hooks: HookCommand[];
}

type HookMap = Record<string, HookGroup[]>;

const HOOK_TIMEOUT_SEC = 5;
const LIGHTCONTROL_HOOK_RE = /(?:^|[\s/'"])cli\.ts['"]?\s+hook\s+(agy|claude|codex)(?:\s|$)/;

function resolveContext(ctx: InstallContext = {}) {
	const home = ctx.home ?? homedir();
	const env = ctx.env ?? process.env;
	const cliPath = path.resolve(ctx.cliPath ?? path.join(import.meta.dir, "cli.ts"));
	const extensionPath = path.resolve(ctx.extensionPath ?? path.join(import.meta.dir, "extension.ts"));
	const bunPath = ctx.bunPath ?? Bun.which("bun") ?? process.execPath;
	return { home, env, cliPath, extensionPath, bunPath };
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, "'\\''")}'`;
}

function hookCommand(bunPath: string, cliPath: string, agent: HookAgent): string {
	return `${shellQuote(bunPath)} ${shellQuote(cliPath)} hook ${agent}`;
}

async function exists(p: string): Promise<boolean> {
	try {
		await access(p);
		return true;
	} catch {
		return false;
	}
}

export function isInstallTarget(value: string): value is InstallTarget {
	return (ALL_TARGETS as readonly string[]).includes(value);
}

/** Detects which supported agents appear to be installed on this machine. */
export async function detectTargets(ctx: InstallContext = {}): Promise<InstallTarget[]> {
	const { home, env } = resolveContext(ctx);
	const which = ctx.which ?? (bin => Bun.which(bin));
	const checks: [InstallTarget, string, string][] = [
		["omp", env.PI_CODING_AGENT_DIR ?? path.join(home, ".omp"), "omp"],
		["agy", env.AGY_CONFIG_DIR ?? path.join(home, ".gemini", "config"), "agy"],
		["claude", env.CLAUDE_CONFIG_DIR ?? path.join(home, ".claude"), "claude"],
		["codex", env.CODEX_HOME ?? path.join(home, ".codex"), "codex"],
	];
	const found: InstallTarget[] = [];
	for (const [target, dir, bin] of checks) {
		if ((await exists(dir)) || which(bin)) found.push(target);
	}
	return found;
}

export async function installTarget(target: InstallTarget, ctx: InstallContext = {}): Promise<InstallResult> {
	switch (target) {
		case "omp":
			return installOmp(ctx);
		case "agy":
			return installAgy(ctx);
		case "claude":
			return installClaude(ctx);
		case "codex":
			return installCodex(ctx);
	}
}

export async function uninstallTarget(target: InstallTarget, ctx: InstallContext = {}): Promise<InstallResult | null> {
	switch (target) {
		case "omp":
			return uninstallOmp(ctx);
		case "agy":
			return uninstallAgy(ctx);
		case "claude":
			return uninstallClaude(ctx);
		case "codex":
			return uninstallCodex(ctx);
	}
}

async function installOmp(ctx: InstallContext): Promise<InstallResult> {
	const { home, env, cliPath, extensionPath } = resolveContext(ctx);
	const agentDir = env.PI_CODING_AGENT_DIR ?? path.join(home, ".omp", "agent");
	const target = path.join(agentDir, "extensions", "lightcontrol.ts");
	await mkdir(path.dirname(target), { recursive: true });
	await writeFile(target, `// installed by ${cliPath}\nexport { default } from ${JSON.stringify(extensionPath)};\n`);
	return { target: "omp", path: target, note: "new omp sessions will load it" };
}

async function uninstallOmp(ctx: InstallContext): Promise<InstallResult | null> {
	const { home, env } = resolveContext(ctx);
	const agentDir = env.PI_CODING_AGENT_DIR ?? path.join(home, ".omp", "agent");
	const target = path.join(agentDir, "extensions", "lightcontrol.ts");
	if (!(await exists(target))) return null;
	await rm(target, { force: true });
	return { target: "omp", path: target };
}

async function installAgy(ctx: InstallContext): Promise<InstallResult> {
	const { home, env, cliPath, bunPath } = resolveContext(ctx);
	const configRoot = env.AGY_CONFIG_DIR ?? path.join(home, ".gemini", "config");
	const pluginDir = path.join(configRoot, "plugins", "lightcontrol");
	const command = hookCommand(bunPath, cliPath, "agy");
	const handler: HookCommand = { type: "command", command, timeout: HOOK_TIMEOUT_SEC };

	const manifest = {
		name: "lightcontrol",
		displayName: "Lightcontrol",
		description: "Recolors Philips Hue lights while Antigravity is waiting on you, then restores them.",
	};
	const hooks = {
		lightcontrol: {
			SessionStart: [handler],
			PreInvocation: [handler],
			PreToolUse: [{ matcher: "ask_question", hooks: [handler] }],
			PostToolUse: [{ matcher: "ask_question", hooks: [handler] }],
			Stop: [handler],
		},
	};

	await mkdir(pluginDir, { recursive: true });
	await writeJsonFile(path.join(pluginDir, "plugin.json"), manifest);
	await writeJsonFile(path.join(pluginDir, "hooks.json"), hooks);
	return { target: "agy", path: pluginDir, note: "Antigravity plugin loads automatically" };
}

async function uninstallAgy(ctx: InstallContext): Promise<InstallResult | null> {
	const { home, env } = resolveContext(ctx);
	const configRoot = env.AGY_CONFIG_DIR ?? path.join(home, ".gemini", "config");
	const pluginDir = path.join(configRoot, "plugins", "lightcontrol");
	if (!(await exists(pluginDir))) return null;
	await rm(pluginDir, { recursive: true, force: true });
	return { target: "agy", path: pluginDir };
}

async function installClaude(ctx: InstallContext): Promise<InstallResult> {
	const { home, env, cliPath, bunPath } = resolveContext(ctx);
	const settingsPath = path.join(env.CLAUDE_CONFIG_DIR ?? path.join(home, ".claude"), "settings.json");
	const command = hookCommand(bunPath, cliPath, "claude");
	const handler: HookCommand = { type: "command", command, timeout: HOOK_TIMEOUT_SEC };

	const desired: HookMap = {
		SessionStart: [{ hooks: [handler] }],
		UserPromptSubmit: [{ hooks: [handler] }],
		PermissionRequest: [{ hooks: [handler] }],
		Notification: [
			{
				matcher: "permission_prompt|elicitation_dialog|elicitation_url_dialog",
				hooks: [handler],
			},
		],
		PreToolUse: [{ matcher: "AskUserQuestion|ExitPlanMode", hooks: [handler] }],
		PostToolUse: [{ hooks: [handler] }],
		PostToolUseFailure: [{ hooks: [handler] }],
		Stop: [{ hooks: [handler] }],
		SessionEnd: [{ hooks: [handler] }],
	};

	await mergeHooksFile(settingsPath, "claude", desired);
	return { target: "claude", path: settingsPath, note: "new Claude Code sessions will load the hooks" };
}

async function uninstallClaude(ctx: InstallContext): Promise<InstallResult | null> {
	const { home, env } = resolveContext(ctx);
	const settingsPath = path.join(env.CLAUDE_CONFIG_DIR ?? path.join(home, ".claude"), "settings.json");
	const removed = await stripHooksFile(settingsPath, "claude");
	return removed ? { target: "claude", path: settingsPath } : null;
}

async function installCodex(ctx: InstallContext): Promise<InstallResult> {
	const { home, env, cliPath, bunPath } = resolveContext(ctx);
	const codexHome = env.CODEX_HOME ?? path.join(home, ".codex");
	const hooksPath = path.join(codexHome, "hooks.json");
	const command = hookCommand(bunPath, cliPath, "codex");
	const handler: HookCommand = { type: "command", command, timeout: HOOK_TIMEOUT_SEC };

	const desired: HookMap = {
		SessionStart: [{ hooks: [handler] }],
		UserPromptSubmit: [{ hooks: [handler] }],
		PermissionRequest: [{ hooks: [handler] }],
		PreToolUse: [{ matcher: "request_user_input|ask_user", hooks: [handler] }],
		PostToolUse: [{ hooks: [handler] }],
		Stop: [{ hooks: [handler] }],
		SessionEnd: [{ hooks: [handler] }],
	};

	await mergeHooksFile(hooksPath, "codex", desired);

	let hooksFeatureEnabled = false;
	try {
		const toml = await readFile(path.join(codexHome, "config.toml"), "utf8");
		hooksFeatureEnabled = /^\s*hooks\s*=\s*true\b/m.test(toml);
	} catch {
		hooksFeatureEnabled = false;
	}
	const note = hooksFeatureEnabled
		? "run /hooks in Codex to review and trust the new hooks"
		: "enable [features] hooks = true in config.toml and run /hooks in Codex to trust the new hooks";
	return { target: "codex", path: hooksPath, note };
}

async function uninstallCodex(ctx: InstallContext): Promise<InstallResult | null> {
	const { home, env } = resolveContext(ctx);
	const hooksPath = path.join(env.CODEX_HOME ?? path.join(home, ".codex"), "hooks.json");
	const removed = await stripHooksFile(hooksPath, "codex");
	return removed ? { target: "codex", path: hooksPath } : null;
}

function isLightcontrolHook(entry: unknown, agent: HookAgent): boolean {
	if (typeof entry !== "object" || entry === null) return false;
	const cmd = (entry as { command?: unknown }).command;
	if (typeof cmd !== "string") return false;
	const match = LIGHTCONTROL_HOOK_RE.exec(cmd);
	return match?.[1] === agent;
}

function stripLightcontrolHooks(hooks: Record<string, unknown>, agent: HookAgent): boolean {
	let changed = false;
	for (const [event, value] of Object.entries(hooks)) {
		if (!Array.isArray(value)) continue;
		const nextGroups: unknown[] = [];
		for (const group of value) {
			if (typeof group !== "object" || group === null || !Array.isArray((group as { hooks?: unknown }).hooks)) {
				nextGroups.push(group);
				continue;
			}
			const list = (group as { hooks: unknown[] }).hooks;
			const filtered = list.filter(h => !isLightcontrolHook(h, agent));
			if (filtered.length !== list.length) changed = true;
			if (filtered.length > 0) nextGroups.push({ ...group, hooks: filtered });
		}
		if (nextGroups.length > 0) hooks[event] = nextGroups;
		else delete hooks[event];
	}
	return changed;
}

async function readJsonObject(file: string): Promise<Record<string, unknown> | undefined> {
	let raw: string;
	try {
		raw = await readFile(file, "utf8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw err;
	}
	const parsed: unknown = JSON.parse(raw);
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error(`${file}: expected a JSON object`);
	}
	return parsed as Record<string, unknown>;
}

async function mergeHooksFile(file: string, agent: HookAgent, desired: HookMap): Promise<void> {
	const root = (await readJsonObject(file)) ?? {};
	const existing = root.hooks;
	const hooks: Record<string, unknown> =
		typeof existing === "object" && existing !== null && !Array.isArray(existing)
			? { ...(existing as Record<string, unknown>) }
			: {};

	stripLightcontrolHooks(hooks, agent);
	for (const [event, groups] of Object.entries(desired)) {
		const prev = Array.isArray(hooks[event]) ? (hooks[event] as unknown[]) : [];
		hooks[event] = [...prev, ...groups];
	}

	root.hooks = hooks;
	await writeJsonFile(file, root);
}

async function stripHooksFile(file: string, agent: HookAgent): Promise<boolean> {
	const root = await readJsonObject(file);
	if (!root) return false;
	const existing = root.hooks;
	if (typeof existing !== "object" || existing === null || Array.isArray(existing)) return false;

	const hooks = { ...(existing as Record<string, unknown>) };
	const changed = stripLightcontrolHooks(hooks, agent);
	if (!changed) return false;

	if (Object.keys(hooks).length > 0) root.hooks = hooks;
	else delete root.hooks;
	await writeJsonFile(file, root);
	return true;
}

/** Writes pretty-printed JSON (2-space indent) atomically, preserving 0644 permissions for shared configs. */
async function writeJsonFile(file: string, value: unknown): Promise<void> {
	await mkdir(path.dirname(file), { recursive: true });
	const tmp = `${file}.${process.pid}.tmp`;
	await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`);
	await rename(tmp, file);
}
