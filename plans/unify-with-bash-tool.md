# Plan: Align Nushell Tool with Built-in Bash Tool Behavior

## Goal
Update `index.ts` so the `nushell` tool more closely matches the performance and UX characteristics of Pi's built-in `bash` tool while preserving Nushell-specific invocation and prompt guidance.

## Changes

1. **Timeout units**
   - Change `timeout` from milliseconds to seconds to match `bash`.
   - Remove the default timeout, or document/implement any default explicitly if still desired.
   - Update parameter description and timeout messages accordingly.

2. **Process cancellation**
   - Spawn `nu` as a detached child process.
   - Track the child PID and kill the full process tree on timeout or abort.
   - Use platform-aware process-tree termination similar to Pi's `killProcessTree()` behavior.

3. **Output handling**
   - Stream stdout and stderr through the same data path, matching `bash`'s combined output behavior.
   - Send partial updates from the combined rolling output buffer instead of stdout only.
   - Consider reusing Pi's shell environment behavior, especially PATH augmentation, if accessible.

4. **Truncation behavior**
   - Replace head truncation with tail truncation so the model sees the most recent output/errors.
   - Maintain a rolling buffer rather than accumulating unbounded output in memory.
   - Save full output to a temp file when output exceeds the display limit.
      - Use the same output location logic as for built-in bash
   - Include truncation metadata and full-output path in tool result details.

5. **Error behavior**
   - Treat non-zero exit codes as tool errors, matching `bash`.
   - Treat timeout and abort as rejected/error results with buffered output plus a clear message.
   - Keep spawn failures as clear errors, including the existing `nu`-not-found hint.

6. **Rendering**
   - Replace the simple text renderer with a bash-like renderer:
     - show elapsed time while running;
     - show collapsed preview by default;
     - support expanded output;
     - display truncation/full-output warnings;
     - render timeout/error states consistently with built-in tool behavior.

## Implementation Notes
- For all of the above, prefer copying Pi's built-in `bash` implementation as closely as possible and adapt it as necessary. Look at the source code for it.
- Keep the tool name as `nushell` and continue running commands through a temporary `.nu` script file.
- Keep Nushell-specific prompt snippets and guidelines unchanged unless parameter semantics change.
- Keep current nushell config/environment behavior.
- Don't worry about breaking changes.
