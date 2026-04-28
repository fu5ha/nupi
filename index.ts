import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	truncateTail,
	truncateToVisualLines,
} from "@mariozechner/pi-coding-agent";
import { Container, Text, truncateToWidth } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { randomBytes } from "crypto";
import { spawn, type ChildProcess } from "child_process";
import { createWriteStream, existsSync, writeFileSync, unlinkSync, type WriteStream } from "fs";
import { homedir, tmpdir } from "os";
import { join } from "path";

const NUSHELL_PREVIEW_LINES = 5;
const EXIT_STDIO_GRACE_MS = 100;
const trackedDetachedChildPids = new Set<number>();

function getShellEnv(): NodeJS.ProcessEnv {
	return { ...process.env };
}

function trackDetachedChildPid(pid: number): void {
	trackedDetachedChildPids.add(pid);
}

function untrackDetachedChildPid(pid: number): void {
	trackedDetachedChildPids.delete(pid);
}

function killProcessTree(pid: number): void {
	if (process.platform === "win32") {
		try {
			spawn("taskkill", ["/F", "/T", "/PID", String(pid)], {
				stdio: "ignore",
				detached: true,
				windowsHide: true,
			});
		} catch {
			// Ignore taskkill failures.
		}
	} else {
		try {
			process.kill(-pid, "SIGKILL");
		} catch {
			try {
				process.kill(pid, "SIGKILL");
			} catch {
				// Process already exited.
			}
		}
	}
}

function getTempFilePath() {
	const id = randomBytes(8).toString("hex");
	return join(tmpdir(), `pi-nushell-${id}.log`);
}

function getTempScriptPath() {
	const id = randomBytes(8).toString("hex");
	return join(tmpdir(), `pi-nu-${id}.nu`);
}

function formatDuration(ms: number) {
	return `${(ms / 1000).toFixed(1)}s`;
}

function waitForChildProcess(child: ChildProcess): Promise<number | null> {
	return new Promise((resolve, reject) => {
		let settled = false;
		let exited = false;
		let exitCode: number | null = null;
		let postExitTimer: NodeJS.Timeout | undefined;
		let stdoutEnded = child.stdout === null;
		let stderrEnded = child.stderr === null;

		const cleanup = () => {
			if (postExitTimer) clearTimeout(postExitTimer);
			child.removeListener("error", onError);
			child.removeListener("exit", onExit);
			child.removeListener("close", onClose);
			child.stdout?.removeListener("end", onStdoutEnd);
			child.stderr?.removeListener("end", onStderrEnd);
		};
		const finalize = (code: number | null) => {
			if (settled) return;
			settled = true;
			cleanup();
			child.stdout?.destroy();
			child.stderr?.destroy();
			resolve(code);
		};
		const maybeFinalizeAfterExit = () => {
			if (exited && stdoutEnded && stderrEnded) finalize(exitCode);
		};
		function onStdoutEnd() {
			stdoutEnded = true;
			maybeFinalizeAfterExit();
		}
		function onStderrEnd() {
			stderrEnded = true;
			maybeFinalizeAfterExit();
		}
		function onError(err: Error) {
			if (settled) return;
			settled = true;
			cleanup();
			reject(err);
		}
		function onExit(code: number | null) {
			exited = true;
			exitCode = code;
			maybeFinalizeAfterExit();
			if (!settled) postExitTimer = setTimeout(() => finalize(code), EXIT_STDIO_GRACE_MS);
		}
		function onClose(code: number | null) {
			finalize(code);
		}

		child.stdout?.once("end", onStdoutEnd);
		child.stderr?.once("end", onStderrEnd);
		child.once("error", onError);
		child.once("exit", onExit);
		child.once("close", onClose);
	});
}

function formatNushellCall(args: { command?: unknown; timeout?: unknown }, theme: any) {
	const command = typeof args?.command === "string" ? args.command : null;
	const timeout = typeof args?.timeout === "number" && args.timeout > 0 ? args.timeout : undefined;
	const timeoutSuffix = timeout ? theme.fg("muted", ` (timeout ${timeout}s)`) : "";
	const commandDisplay = command === null ? theme.fg("error", "invalid command") : command || theme.fg("toolOutput", "...");
	return theme.fg("toolTitle", theme.bold(`🐘 ${commandDisplay}`)) + timeoutSuffix;
}

function getTextOutput(result: any): string {
	return result?.content?.find?.((item: any) => item?.type === "text")?.text ?? "";
}

class NushellResultRenderComponent extends Container {
	state: {
		cachedWidth?: number;
		cachedLines?: string[];
		cachedSkipped?: number;
	} = {};
}

function rebuildNushellResultRenderComponent(component: NushellResultRenderComponent, result: any, options: any, theme: any, startedAt?: number, endedAt?: number) {
	const state = component.state;
	component.clear();
	const output = getTextOutput(result).trim();
	if (output) {
		const styledOutput = output
			.split("\n")
			.map((line) => theme.fg("toolOutput", line))
			.join("\n");
		if (options.expanded) {
			component.addChild(new Text(`\n${styledOutput}`, 0, 0));
		} else {
			component.addChild({
				render: (width: number) => {
					if (state.cachedLines === undefined || state.cachedWidth !== width) {
						const preview = truncateToVisualLines(styledOutput, NUSHELL_PREVIEW_LINES, width);
						state.cachedLines = preview.visualLines;
						state.cachedSkipped = preview.skippedCount;
						state.cachedWidth = width;
					}
					if (state.cachedSkipped && state.cachedSkipped > 0) {
						const hint = theme.fg("muted", `... (${state.cachedSkipped} earlier lines, expand to show all)`);
						return ["", truncateToWidth(hint, width, "..."), ...(state.cachedLines ?? [])];
					}
					return ["", ...(state.cachedLines ?? [])];
				},
				invalidate: () => {
					state.cachedWidth = undefined;
					state.cachedLines = undefined;
					state.cachedSkipped = undefined;
				},
			});
		}
	}

	const truncation = result.details?.truncation;
	const fullOutputPath = result.details?.fullOutputPath;
	if (truncation?.truncated || fullOutputPath) {
		const warnings: string[] = [];
		if (fullOutputPath) warnings.push(`Full output: ${fullOutputPath}`);
		if (truncation?.truncated) {
			if (truncation.truncatedBy === "lines") {
				warnings.push(`Truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines`);
			} else {
				warnings.push(`Truncated: ${truncation.outputLines} lines shown (${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit)`);
			}
		}
		component.addChild(new Text(`\n${theme.fg("warning", `[${warnings.join(". ")}]`)}`, 0, 0));
	}

	if (startedAt !== undefined) {
		const label = options.isPartial ? "Elapsed" : "Took";
		const endTime = endedAt ?? Date.now();
		component.addChild(new Text(`\n${theme.fg("muted", `${label} ${formatDuration(endTime - startedAt)}`)}`, 0, 0));
	}
}

export default function (pi: ExtensionAPI) {
	// Replace built-in bash tool with nushell fully by wiping bash from active tools and replacing it with the new nushell tool below.
	pi.on("session_start", () => {
		const activeTools = pi.getActiveTools();
		if (activeTools.includes("bash")) {
			pi.setActiveTools([...new Set(activeTools.map((name) => (name === "bash" ? "nushell" : name)))]);
		}
	});

	pi.registerTool({
		name: "nushell",
		label: "nushell",
		description: `Execute a nushell (nu) script in the current working directory. Returns stdout and stderr. Output is truncated to last ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). If truncated, full output is saved to a temp file. Optionally provide a timeout in seconds.`,

		promptSnippet: "Execute a nushell (nu) script with full language support; multi-line scripts are fine.",

		promptGuidelines: [
			"Nushell scripts run directly in nu — no `nu -c` wrapper or `echo` needed. Simple expressions like `ls | where size > 1mb`, `which some-name`, etc. work as-is.",
			"Avoid bash syntax — use nushell idioms instead: Use `err>` instead of `2>` and `save` instead of `>`, use `| lines`, `| from json`, `from csv` as appropriate to ingest external data.",
			"Discover commands: `help commands | where command_type == built-in | get name | to text` (built-ins), same with `custom` for user-defined. Get help on one: `help <command> | ansi strip | str trim`",
			"Use nushell for calculations. Send eg. `1400 * 300` directly. For more advanced math check out `help math` and `help math <subcommand>` first.",
			"External shell tools like ripgrep, fd/find, git, etc. work as usual from nushell. When piping their output into further Nu commands, ingest/parse it properly first (for example with `lines`, `from json`, `from csv`, `split row`, or other suitable converters) so Nu receives structured data instead of raw text.",
			"Check whether the environment supports a shell tool you want to use before using it by calling `which some-tool-name`.",
		],

		parameters: Type.Object({
			command: Type.String({
				description: "Nushell script to run. May be multi-line.",
			}),
			timeout: Type.Optional(
				Type.Number({
					description: "Timeout in seconds (optional, no default timeout).",
				})
			),
		}),

		renderCall(args, theme, context) {
			const state = context.state as { startedAt?: number; endedAt?: number };
			if (context.executionStarted && state.startedAt === undefined) {
				state.startedAt = Date.now();
				state.endedAt = undefined;
			}
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatNushellCall(args, theme));
			return text;
		},

		renderResult(result, options, theme, context) {
			const state = context.state as { startedAt?: number; endedAt?: number; interval?: NodeJS.Timeout };
			if (state.startedAt !== undefined && options.isPartial && !state.interval) {
				state.interval = setInterval(() => context.invalidate(), 1000);
			}
			if (!options.isPartial || context.isError) {
				state.endedAt ??= Date.now();
				if (state.interval) {
					clearInterval(state.interval);
					state.interval = undefined;
				}
			}
			const component = (context.lastComponent as NushellResultRenderComponent | undefined) ?? new NushellResultRenderComponent();
			rebuildNushellResultRenderComponent(component, result, options, theme, state.startedAt, state.endedAt);
			component.invalidate();
			return component;
		},

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const { command, timeout } = params;
			const tmpScriptFile = getTempScriptPath();
			writeFileSync(tmpScriptFile, command, "utf8");

			const cleanupScript = () => {
				try {
					unlinkSync(tmpScriptFile);
				} catch {
					// best-effort
				}
			};

			const piConfig = join(homedir(), ".config", "nushell", "pi.nu");
			const nuArgs = existsSync(piConfig) ? ["--config", piConfig, tmpScriptFile] : [tmpScriptFile];

			if (onUpdate) onUpdate({ content: [], details: undefined });

			return new Promise((resolve, reject) => {
				let tempFilePath: string | undefined;
				let tempFileStream: WriteStream | undefined;
				let totalBytes = 0;
				const chunks: Buffer[] = [];
				let chunksBytes = 0;
				const maxChunksBytes = DEFAULT_MAX_BYTES * 2;
				let timedOut = false;
				let timeoutHandle: NodeJS.Timeout | undefined;

				const ensureTempFile = () => {
					if (tempFilePath) return;
					tempFilePath = getTempFilePath();
					tempFileStream = createWriteStream(tempFilePath);
					for (const chunk of chunks) tempFileStream.write(chunk);
				};

				const handleData = (data: Buffer) => {
					totalBytes += data.length;
					if (totalBytes > DEFAULT_MAX_BYTES) ensureTempFile();
					if (tempFileStream) tempFileStream.write(data);

					chunks.push(data);
					chunksBytes += data.length;
					while (chunksBytes > maxChunksBytes && chunks.length > 1) {
						const removed = chunks.shift();
						chunksBytes -= removed?.length ?? 0;
					}

					const fullText = Buffer.concat(chunks).toString("utf-8");
					const truncation = truncateTail(fullText);
					if (truncation.truncated) ensureTempFile();
					onUpdate?.({
						content: [{ type: "text", text: truncation.content || "" }],
						details: {
							truncation: truncation.truncated ? truncation : undefined,
							fullOutputPath: tempFilePath,
						},
					});
				};

				const child = spawn("nu", nuArgs, {
					cwd: ctx.cwd,
					detached: process.platform !== "win32",
					env: getShellEnv(),
					stdio: ["ignore", "pipe", "pipe"],
					windowsHide: true,
				});

				if (child.pid) trackDetachedChildPid(child.pid);

				if (timeout !== undefined && timeout > 0) {
					timeoutHandle = setTimeout(() => {
						timedOut = true;
						if (child.pid) killProcessTree(child.pid);
					}, timeout * 1000);
				}

				const onAbort = () => {
					if (child.pid) killProcessTree(child.pid);
				};
				if (signal) {
					if (signal.aborted) onAbort();
					else signal.addEventListener("abort", onAbort, { once: true });
				}

				child.stdout?.on("data", handleData);
				child.stderr?.on("data", handleData);

				const finishProcessCleanup = () => {
					if (child.pid) untrackDetachedChildPid(child.pid);
					if (timeoutHandle) clearTimeout(timeoutHandle);
					if (signal) signal.removeEventListener("abort", onAbort);
				};
				const finishFileCleanup = () => {
					if (tempFileStream) tempFileStream.end();
					cleanupScript();
				};

				waitForChildProcess(child)
					.then((exitCode) => {
						finishProcessCleanup();
						const fullOutput = Buffer.concat(chunks).toString("utf-8");
						const truncation = truncateTail(fullOutput);
						if (truncation.truncated) ensureTempFile();
						finishFileCleanup();

						let outputText = truncation.content || "(no output)";
						let details: Record<string, unknown> | undefined;
						if (truncation.truncated) {
							details = { truncation, fullOutputPath: tempFilePath };
							const startLine = truncation.totalLines - truncation.outputLines + 1;
							const endLine = truncation.totalLines;
							if (truncation.lastLinePartial) {
								const lastLineSize = formatSize(Buffer.byteLength(fullOutput.split("\n").pop() || "", "utf-8"));
								outputText += `\n\n[Showing last ${formatSize(truncation.outputBytes)} of line ${endLine} (line is ${lastLineSize}). Full output: ${tempFilePath}]`;
							} else if (truncation.truncatedBy === "lines") {
								outputText += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines}. Full output: ${tempFilePath}]`;
							} else {
								outputText += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Full output: ${tempFilePath}]`;
							}
						}

						if (signal?.aborted) {
							if (outputText) outputText += "\n\n";
							reject(new Error(`${outputText}Command aborted`));
						} else if (timedOut) {
							if (outputText) outputText += "\n\n";
							reject(new Error(`${outputText}Command timed out after ${timeout} seconds`));
						} else if (exitCode !== 0 && exitCode !== null) {
							outputText += `\n\nCommand exited with code ${exitCode}`;
							reject(new Error(outputText));
						} else {
							resolve({ content: [{ type: "text", text: outputText }], details });
						}
					})
					.catch((err: NodeJS.ErrnoException) => {
						finishProcessCleanup();
						finishFileCleanup();
						const hint =
							err.code === "ENOENT"
								? "\n\nHint: 'nu' was not found in PATH. Install nushell and make sure `nu` is executable."
								: "";
						reject(new Error(`Error spawning nushell: ${err.message}${hint}`));
					});
			});
		},
	});
}
