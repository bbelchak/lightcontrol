/** Local-time active window for alerts; outside it is blackout, where events switch the lights off. */
export interface ActiveHours {
	/** `HH:MM`, local time. */
	start: string;
	/** `HH:MM`, local time; earlier than `start` means the window crosses midnight. */
	end: string;
}

const HHMM = /^([01]?\d|2[0-3]):([0-5]\d)$/;

export function parseHHMM(value: string): number {
	const match = HHMM.exec(value);
	if (!match) throw new Error(`invalid time "${value}", expected HH:MM`);
	return Number(match[1]) * 60 + Number(match[2]);
}

function localAt(now: Date, dayOffset: number, minutes: number): number {
	return new Date(now.getFullYear(), now.getMonth(), now.getDate() + dayOffset, 0, minutes).getTime();
}

/**
 * Epoch ms at which the active window containing `now` opened, or `undefined` during blackout.
 * `null` hours (no window) and `start === end` are always active and return 0.
 */
export function activeWindowStart(hours: ActiveHours | null, now = new Date()): number | undefined {
	if (!hours) return 0;
	const start = parseHHMM(hours.start);
	const end = parseHHMM(hours.end);
	if (start === end) return 0;
	const minute = now.getHours() * 60 + now.getMinutes();
	if (start < end) return minute >= start && minute < end ? localAt(now, 0, start) : undefined;
	if (minute >= start) return localAt(now, 0, start);
	if (minute < end) return localAt(now, -1, start);
	return undefined;
}

/** Epoch ms of the next time the active window closes, or `undefined` when it never does. */
export function nextWindowEnd(hours: ActiveHours | null, now = new Date()): number | undefined {
	if (!hours || parseHHMM(hours.start) === parseHHMM(hours.end)) return undefined;
	const end = parseHHMM(hours.end);
	const today = localAt(now, 0, end);
	return today > now.getTime() ? today : localAt(now, 1, end);
}
