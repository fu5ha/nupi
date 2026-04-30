# nupi 🐘π

A [Pi Coding Agent](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent) extension that replaces the active built-in `bash` tool with a `nushell` tool powered by [Nushell](https://www.nushell.sh/) (`nu`).

## What it does

Registers a tool named `nushell` and swaps it in for the active built-in `bash` tool, including
replacing all mentions of using bash in the system prompt and a short set of guidelines.

## Requirements

- Node.js with ES2022+ support
- Nushell installed with `nu` in your PATH
- `@mariozechner/pi-coding-agent`

## Installation

```sh
pi install git:github.com/fu5ha/nupi
```

You can use this in your pi config if you additionally want nushell for the ! and !! functionality in pi (recommended):

```json
  "shellPath": "/path/to/your/nu",
```


Optionally create a `pi.nu` in your nushell config dir (`~/.config/nushell/pi.nu`) which will be used as replacement config for pi's nu shells.
Source custom commands and `use` modules you want available on pi.

You can even set nushell up to output `nuon` by default instead of the standard table. This can make output more digestable and token effective for the coding agent and underlying LLM in some cases.

Add this in your `pi.nu`.

```nushell
$env.config = {
  hooks: {
    display_output: {
      if ($in | describe | str contains "table") or ($in | describe | str contains "list") or ($in | describe | str contains "record") {
        $in | to nuon --indent 2
      } else {
        table
      }
    }
  }
}
```

## Behavior

- Scripts are written to a temp file (`pi-nu-*.nu`) before execution to avoid quoting issues with multi-line scripts and special characters.
- If `~/.config/nushell/pi.nu` exists, Nushell is spawned with `--config ~/.config/nushell/pi.nu`; otherwise the `--config` argument is omitted.
- Implementation is as close to the built-in `bash` tool as possible in most ways, but it's slightly less extensible by other pi packages.
