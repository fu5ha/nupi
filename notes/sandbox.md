# Windows sandboxing for nupi

High-level plan: keep `nupi` as the Pi extension, but delegate sandboxed Nushell execution to a small Rust helper/broker built on Codex's `codex-windows-sandbox` crate.

## Architecture

```text
nupi TypeScript tool
  -> pi-nupi-sandbox.exe / broker
      -> codex_windows_sandbox elevated setup as needed
      -> codex-command-runner.exe as CodexSandboxOffline/Online
          -> nu <script> under restricted token + capability SIDs
```

A pure Node/NAPI-only implementation is not enough because elevated setup and sandbox-user execution both require separate Windows processes. NAPI could still be used as a thin client, but a broker executable is simpler and safer.

## Required pieces

1. **Rust broker executable**
   - Depends on `codex-windows-sandbox`.
   - Accepts JSON request from `nupi` containing command/script path, cwd, env, timeout, policy roots, and Codex home.
   - Calls `run_windows_sandbox_capture_elevated` or session API.
   - Returns stdout/stderr/exit/timeout as JSON.

2. **Bundle helper executables**
   - `codex-command-runner.exe`
   - `codex-windows-sandbox-setup.exe`
   - These are built from `codex-rs/windows-sandbox-rs`.
   - Codex currently locates them relative to `current_exe()` or `codex-resources/`; broker packaging should either match that layout or patch/helper-wrap lookup paths.

3. **Setup handling**
   - Broker checks `sandbox_setup_is_complete(codex_home)`.
   - If missing/outdated, calls elevated setup, which triggers UAC via the setup helper.
   - Prefer adding an explicit Pi command such as `/nupi-sandbox-setup` so setup is not surprising during a tool call.

4. **Policy/root handling**
   - Grant workspace cwd read/write for normal `nupi` behavior.
   - Ensure the temporary `.nu` script is readable by the sandbox.
   - Prefer writing temp scripts under a project-local `.pi/tmp`/`.nupi/tmp` directory, or pass explicit read roots for OS temp.
   - Expose/patch controls for extra readable/writable roots and deny-write carveouts.
   - Add optional deny-read/deny-execute ACLs for specific blocked executables, e.g. `p4.exe`, `gh.exe`, or other tools the sandboxed Nushell should not be able to run. Removing them from `PATH` is useful for UX, but strong blocking should deny the sandbox user/capability SID read/execute access to the actual executable path.
   - Decide network mode: offline/restricted by default, optionally allow Codex proxy settings.

5. **nupi integration**
   - Replace direct `spawn("nu", ...)` with broker invocation.
   - Preserve existing timeout, abort, truncation, and full-output-file behavior.
   - First version can return output only on completion; streaming can be added later via line/framed JSON events.

## Likely Codex changes or wrappers

- Allow explicit helper executable paths instead of relying only on `current_exe()` sibling lookup.
- Allow clearer override of read/write roots for the elevated capture path.
- Possibly expose a smaller stable API specifically for “run this command under elevated Windows sandbox”.

## Prototype order

1. Build broker that runs `nu <script>` sandboxed and returns captured output.
2. Package broker beside Codex helper exes and validate setup/helper lookup.
3. Wire `nupi` to call broker instead of spawning `nu` directly.
4. Add explicit setup command and configurable roots/network policy.
5. Add streaming output if needed.
