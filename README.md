# nupi 🐘π

A [Pi Coding Agent](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent) extension that replaces the built-in bash tool with [Nushell](https://www.nushell.sh/) (`nu`).

## What it does

Registers a tool named `bash` (displayed as `nushell` in the TUI) that executes scripts using `nu` instead of bash. The agent gets full Nushell language support — structured pipelines, `open`, `http get`, `| where`, `| get`, `| to json`, `| to nuon`, etc. — including native **nuon** (Nushell Object Notation) for structured data interchange.

## Requirements

- Node.js with ES2022+ support
- Nushell installed with `nu` in your PATH
- `@mariozechner/pi-coding-agent`

## Installation

```sh
pi install git:github.com/kiil/nupi
```

Remember to create a pi.nu in your nushell config dir (~/.config/nushell/pi.nu) and source custom commands and `use` modules you want available on pi.

Bonus:

You can use this in your pi config if you additionally want nushell for the ! and !! functionality in pi:

  "shellPath": "/path/to/your/nu"

## Behavior

- Scripts are written to a temp file (`pi-nu-*.nu`) before execution to avoid quoting issues with multi-line scripts and special characters.
- Output is capped at **2000 lines** or **50 KB**, whichever comes first — matching Pi's default bash limit.
- Partial output is streamed to the TUI in real time.
- Default timeout is **30 seconds** (overridable per call).
- Nushell is spawned with `--config ~/.config/nushell/pi.nu` - make sure to source your custom commands and `use` modules you need from a pi.nu file in that location.
- Temp files are cleaned up after each run, even on error or timeout.
