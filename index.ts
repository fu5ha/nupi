import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { spawn } from "child_process";
import { homedir, tmpdir } from "os";
import { writeFileSync, unlinkSync } from "fs";
import { join } from "path";
import { randomBytes } from "crypto";

const MAX_BYTES = 50 * 1024; // 50 KB — matches pi's default bash limit
const MAX_LINES = 2000;

function truncate(text: string): string {
	const lines = text.split("\n");
	if (lines.length > MAX_LINES) {
		text = lines.slice(0, MAX_LINES).join("\n") + `\n[… ${lines.length - MAX_LINES} more lines truncated]`;
	}
	const bytes = Buffer.byteLength(text, "utf8");
	if (bytes > MAX_BYTES) {
		text = Buffer.from(text, "utf8").subarray(0, MAX_BYTES).toString("utf8") + "\n[… truncated at 50 KB]";
	}
	return text;
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", () => {
		const activeTools = pi.getActiveTools();
		if (activeTools.includes("bash")) {
			pi.setActiveTools([...new Set(activeTools.map((name) => (name === "bash" ? "nushell" : name)))]);
		}
	});

	pi.registerTool({
		name: "nushell",
		label: "nushell",
		description:
			"Execute a nushell (nu) script. Multi-line scripts are fine.",

		promptSnippet: "Execute a nushell (nu) script with full language support; multi-line scripts are fine.",

		promptGuidelines: [
			"Nushell scripts run directly in nu — no `nu -c` wrapper or `echo` needed. Simple expressions like `ls | where size > 1mb`, `which some-name`, etc. work as-is.",
			"Avoid bash syntax — use nushell idioms instead: Use `err>` instead of `2>` and `save` instead of `>`, use `| lines`, `| from json`, `from csv` as appropriate to ingest external data.",
			"Discover commands: `help commands | where command_type == built-in | get name | to text` (built-ins), same with `custom` for user-defined. Get help on one: `help <command> | ansi strip | str trim`",
			"Use nushell for calculations. Send eg. `1400 * 300` directly. For more advanced math check out `help math` and `help math <subcommand>` first.",
			"External shell tools like ripgrep, fd/find, git, etc. work as usual from nushell. When piping their output into further Nu commands, ingest/parse it properly first (for example with `lines`, `from json`, `from csv`, `split row`, or other suitable converters) so Nu receives structured data instead of raw text.",
			"Check whether the environment supports a shell tool you want to use before using it by calling `which some-tool-name`."
		],

		parameters: Type.Object({
			command: Type.String({
				description: "Nushell script to run. May be multi-line.",
			}),
			timeout: Type.Optional(
				Type.Number({
					description: "Maximum run time in milliseconds. Defaults to 30 000.",
				})
			),
		}),

		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			const label = theme.fg("toolTitle", "🐘 nushell");
			const firstLine = args.command.split("\n")[0];
			const preview = firstLine + (args.command.includes("\n") ? " …" : "");
			const full = args.command.includes("\n") ? "\n" + theme.fg("muted", args.command) : "";
			text.setText(`${label} ${theme.fg("muted", preview)}${full}`);
			return text;
		},

		renderResult(result, _options, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			const output = result.content[0]?.type === "text" ? result.content[0].text : "";
			text.setText(theme.fg("toolOutput", output));
			return text;
		},

		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const { command, timeout = 30_000 } = params;


			// Write the script to a temp file so multi-line scripts and
			// special characters survive shell quoting without any escaping.
			const tmpFile = join(tmpdir(), `pi-nu-${randomBytes(8).toString("hex")}.nu`);
			writeFileSync(tmpFile, command, "utf8");

			const cleanup = () => {
				try {
					unlinkSync(tmpFile);
				} catch {
					// best-effort
				}
			};

			const cwd = ctx.cwd;
			const piConfig = join(homedir(), ".config", "nushell", "pi.nu");

			return new Promise<ReturnType<typeof resolveShape>>((resolve) => {
				let stdout = "";
				let stderr = "";
				let timedOut = false;
				let settled = false;

				// I actually want the config
				// const proc = spawn("nu", ["--no-config-file", tmpFile], {
				// const proc = spawn("nu", [tmpFile], {
				const proc = spawn("nu", [
					"--config",
					piConfig,
					tmpFile
				], {
					cwd,
					env: { ...process.env },
				});

				const timer = setTimeout(() => {
					timedOut = true;
					proc.kill("SIGTERM");
				}, timeout);

				const abort = () => {
					clearTimeout(timer);
					proc.kill("SIGTERM");
				};
				signal?.addEventListener("abort", abort, { once: true });

				proc.stdout.on("data", (chunk: Buffer) => {
					stdout += chunk.toString("utf8");
					// Stream partial output back to the TUI.
					onUpdate({ content: [{ type: "text", text: truncate(stdout) }] });
				});

				proc.stderr.on("data", (chunk: Buffer) => {
					stderr += chunk.toString("utf8");
				});

				proc.on("close", (code) => {
					if (settled) return;
					settled = true;
					clearTimeout(timer);
					signal?.removeEventListener("abort", abort);
					cleanup();

					let output = stdout;
					if (stderr) {
						output += (output ? "\n\nstderr:\n" : "") + stderr;
					}
					if (timedOut) {
						output = `[timed out after ${timeout} ms]\n` + output;
					}

					output = truncate(output.trim()) || "(no output)";

					resolve({
						content: [{ type: "text", text: output }],
						details: {
							exitCode: timedOut ? -1 : code,
							timedOut,
							shell: "nushell",
						},
					});
				});

				proc.on("error", (err: NodeJS.ErrnoException) => {
					if (settled) return;
					settled = true;
					clearTimeout(timer);
					signal?.removeEventListener("abort", abort);
					cleanup();

					const hint =
						err.code === "ENOENT"
							? "\n\nHint: 'nu' was not found in PATH. Install nushell and make sure `nu` is executable."
							: "";

					resolve({
						content: [{ type: "text", text: `Error spawning nushell: ${err.message}${hint}` }],
						details: { error: true, shell: "nushell" },
					});
				});
			});
		},
	});
}

// Helper so TypeScript infers the return shape without importing internal types.
function resolveShape(x: { content: { type: string; text: string }[]; details: object }) {
	return x;
}
