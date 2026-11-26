/** Minimal Hue bridge v1 client (HTTPS; bridges use a self-signed certificate). */

export interface LightState {
	on: boolean;
	bri?: number;
	hue?: number;
	sat?: number;
	xy?: [number, number];
	ct?: number;
	colormode?: "hs" | "xy" | "ct";
	reachable?: boolean;
}

export interface Light {
	name: string;
	type: string;
	state: LightState;
}

export interface Group {
	name: string;
	type: string;
	lights: string[];
}

/** Body accepted by `PUT /lights/<id>/state`. */
export interface StateUpdate {
	on?: boolean;
	bri?: number;
	hue?: number;
	sat?: number;
	xy?: [number, number];
	ct?: number;
	alert?: "none" | "select" | "lselect";
	transitiontime?: number;
}

interface HueErrorEntry {
	error: { type: number; address: string; description: string };
}

export class HueError extends Error {
	constructor(
		readonly type: number,
		description: string,
	) {
		super(`Hue bridge error ${type}: ${description}`);
	}
}

/** Bridge error type for "link button not pressed". */
export const LINK_BUTTON_NOT_PRESSED = 101;

const REQUEST_TIMEOUT_MS = 4000;

async function request<T>(bridge: string, pathname: string, init?: { method: string; body: unknown }): Promise<T> {
	const res = await fetch(`https://${bridge}/api${pathname}`, {
		method: init?.method ?? "GET",
		body: init ? JSON.stringify(init.body) : undefined,
		headers: init ? { "content-type": "application/json" } : undefined,
		signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		tls: { rejectUnauthorized: false },
	});
	if (!res.ok) throw new Error(`Hue bridge ${bridge}: HTTP ${res.status}`);
	const data = (await res.json()) as T | HueErrorEntry[];
	// GETs return the resource, or a one-element error array. Writes return per-field success/error
	// entries; fail only when nothing applied, so e.g. `xy` on a white-only bulb still sets `on`/`bri`.
	if (Array.isArray(data) && data.length > 0 && data.every(e => typeof e === "object" && e && "error" in e)) {
		const first = (data as HueErrorEntry[])[0]!.error;
		throw new HueError(first.type, first.description);
	}
	return data as T;
}

/** Bridges registered with Philips' cloud discovery for this network. */
export async function discoverBridges(): Promise<string[]> {
	const res = await fetch("https://discovery.meethue.com", { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
	if (!res.ok) throw new Error(`discovery.meethue.com: HTTP ${res.status}`);
	const found = (await res.json()) as { internalipaddress: string }[];
	return found.map(b => b.internalipaddress);
}

/** Creates an application key. Throws `HueError` with `LINK_BUTTON_NOT_PRESSED` until the button is pressed. */
export async function pair(bridge: string): Promise<string> {
	const [result] = await request<[{ success: { username: string } }]>(bridge, "", {
		method: "POST",
		body: { devicetype: "lightcontrol#agent" },
	});
	return result.success.username;
}

export function getLights(bridge: string, username: string): Promise<Record<string, Light>> {
	return request(bridge, `/${username}/lights`);
}

export function getGroups(bridge: string, username: string): Promise<Record<string, Group>> {
	return request(bridge, `/${username}/groups`);
}

export async function setLightState(bridge: string, username: string, id: string, update: StateUpdate): Promise<void> {
	await request(bridge, `/${username}/lights/${id}/state`, { method: "PUT", body: update });
}

/** sRGB hex (`#rrggbb`) to CIE xy using Philips' wide-gamut conversion; the bridge clamps to each bulb's gamut. */
export function hexToXy(hex: string): [number, number] {
	const match = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
	if (!match) throw new Error(`invalid color ${JSON.stringify(hex)}; expected #rrggbb`);
	const [r, g, b] = match.slice(1).map(c => {
		const v = Number.parseInt(c, 16) / 255;
		return v > 0.04045 ? ((v + 0.055) / 1.055) ** 2.4 : v / 12.92;
	}) as [number, number, number];
	const X = r * 0.664511 + g * 0.154324 + b * 0.162028;
	const Y = r * 0.283881 + g * 0.668433 + b * 0.047685;
	const Z = r * 0.000088 + g * 0.07231 + b * 0.986039;
	const sum = X + Y + Z;
	if (sum === 0) return [0.3127, 0.329];
	return [Math.round((X / sum) * 10_000) / 10_000, Math.round((Y / sum) * 10_000) / 10_000];
}

/** Update that puts a light back into a snapshotted state. */
export function restoreUpdate(state: LightState): StateUpdate {
	// Color fields are rejected while a light is off, so an off light only needs `on: false`.
	if (!state.on) return { on: false, transitiontime: 4 };
	const update: StateUpdate = { on: true, bri: state.bri, transitiontime: 4 };
	if (state.colormode === "xy") update.xy = state.xy;
	else if (state.colormode === "ct") update.ct = state.ct;
	else if (state.colormode === "hs") Object.assign(update, { hue: state.hue, sat: state.sat });
	return update;
}
