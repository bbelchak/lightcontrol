# omp-lightcontrol

An [omp](https://omp.sh) extension that recolors Philips Hue lights while omp is waiting on you, then puts them
back. Outside the active hours you set (08:00 to 22:00 by default), it switches the lights off instead.

| Signal | Default color | When |
| --- | --- | --- |
| `input` | red-orange `#ff3000` | `ask` prompt, tool approval, or plan review is open |
| `done` | green `#00ff50` | the main agent settled and waits for your next prompt |

During active hours, lights return to their captured state when you answer, submit a prompt, or the session
exits. Only the top-level interactive session counts (subagents, print mode, and nested `omp` runs are ignored).
Several omp sessions share one state file (`~/.config/lightcontrol/state.json`): the most urgent reason across
live sessions wins, and the lights are restored only after the last one stops waiting. A detached watcher
restores them if omp is killed or its terminal closes.

## Requirements

- [omp](https://github.com/can1357/oh-my-pi)
- [Bun](https://bun.sh) on `PATH` (the exit watcher runs with it)
- A Philips Hue bridge on the same network

## Setup

```sh
git clone https://github.com/bbelchak/omp-lightcontrol.git
cd omp-lightcontrol
bun install
bun run lights setup      # finds the bridge, waits for the link button, picks lights
bun run lights install    # writes ~/.omp/agent/extensions/lightcontrol.ts
bun run lights test       # flashes input, then done, then restores
```

New omp sessions load the extension. `install` points it at this checkout, so keep the clone where it is.

## Commands

- `bun run lights list | test | clear | status`: `clear` restores the lights and drops every session's alert.
- `/lights clear` and `/lights test` inside omp.

## Config

`~/.config/lightcontrol/config.json` (override the directory with `LIGHTCONTROL_DIR`); read on every alert,
so edits apply without restarting omp.

```json
{
	"bridge": "<bridge IP>",
	"username": "<app key from pairing>",
	"lights": ["1", "2"],
	"colors": { "input": "#ff3000", "done": "#00ff50" },
	"brightness": 254,
	"flash": true,
	"doneDelayMs": 1500,
	"activeHours": { "start": "08:00", "end": "22:00" }
}
```

- `colors.<reason>: null` disables that signal.
- `flash` breathes the lights once when the color changes.
- `doneDelayMs` waits before showing `done`, so auto-retries and continuations don't flicker the lights.
- `activeHours` (local time) limits alerts to that window. In the blackout period outside it, an `input` or `done`
  event switches the lights off instead, and they stay off. An alert still showing when the window closes is switched
  off too. A request left waiting from blackout does not light up when the window opens. `start` later than `end`
  crosses midnight; `null` disables the window. `test` ignores it.
- White-only bulbs get brightness and the flash but not the color.

Manual light changes made while an alert is showing are overwritten by the restore.

## License

[MIT](LICENSE)
