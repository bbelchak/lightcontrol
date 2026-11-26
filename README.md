# lightcontrol

Recolors Philips Hue lights while your coding agent is waiting on you, then puts them back. Supports
[omp](https://omp.sh), [Antigravity (`agy`)](https://antigravity.google),
[Claude Code](https://code.claude.com), and [Codex](https://developers.openai.com/codex) across shared
state. Outside the active hours you set (08:00 to 22:00 by default), it switches the lights off instead.

| Signal | Default color | When |
| --- | --- | --- |
| `input` | red-orange `#ff3000` | question prompt, tool approval, or plan review is open |
| `done` | green `#00ff50` | the main agent settled and waits for your next prompt |

During active hours, lights return to their captured state when you answer, submit a prompt, or the session
exits. Only top-level interactive sessions count (subagents and nested runs are ignored). Sessions across
all supported agents share one state file (`~/.config/lightcontrol/state.json`): the most urgent reason
across live sessions wins, and the lights are restored only after the last one stops waiting. A detached
background monitor restores them if an agent is killed or its terminal closes, and switches still-showing
alerts off when active hours end.

## Agent Support

| Agent | Integration | `input` signals | `done` signal | Notes |
| --- | --- | --- | --- | --- |
| **omp** | `~/.omp/agent/extensions/lightcontrol.ts` | `ask`, tool approval, plan review | `agent_end` | Also registers `/lights clear \| test`. |
| **Antigravity (`agy`)** | `~/.gemini/config/plugins/lightcontrol/` | `ask_question` | `Stop` (skips `USER_CANCELED`) | Antigravity does not expose a tool-approval prompt hook; `ask_question` and `Stop` work in both CLI and app. |
| **Claude Code** | `~/.claude/settings.json` (`hooks`) | `PermissionRequest`, `Notification` (`permission_prompt`, `elicitation_*`), `AskUserQuestion`, `ExitPlanMode` | `Stop` | Merges non-destructively with existing hooks; ignores subagents (`agent_id`). |
| **Codex** | `~/.codex/hooks.json` (`hooks`) | `PermissionRequest`, `request_user_input` | `Stop` | Merges non-destructively; requires `[features] hooks = true` and trusting hooks via `/hooks`. |

## Requirements

- [Bun](https://bun.sh)
- A Philips Hue bridge on the same network
- One or more of: `omp`, `agy` (Antigravity), `claude` (Claude Code), `codex` (OpenAI Codex)

## Setup

```sh
git clone https://github.com/bbelchak/omp-lightcontrol.git
cd omp-lightcontrol
bun install
bun run lights setup      # finds the bridge, waits for the link button, picks lights
bun run lights install    # installs into all detected agents (or pass: omp agy claude codex all)
bun run lights test       # flashes input, then done, then restores
```

`install` points each agent at this checkout, so keep the clone where it is. For Codex, run `/hooks` inside
Codex after installing to review and trust the new hooks.

## Commands

- `bun run lights setup [--bridge IP] [--lights 1,2 | --room NAME]`
- `bun run lights install [omp|agy|claude|codex|all ...]`: defaults to every detected agent.
- `bun run lights uninstall [omp|agy|claude|codex|all ...]`: cleanly removes only lightcontrol's hooks/extension.
- `bun run lights list | test | clear | status`: `clear` restores the lights and drops every session's alert.
- `/lights clear` and `/lights test` inside `omp`.

## Config

`~/.config/lightcontrol/config.json` (override the directory with `LIGHTCONTROL_DIR`); read on every alert,
so edits apply without restarting your agent.

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
