/**
 * Ripgrep search tool for read-only scout subagents.
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const PI_HOME = path.join(process.env.HOME || "~", ".pi");
const BUNDLED_RG = path.join(PI_HOME, "agent", "bin", "rg");

function resolveRg(): string {
	return fs.existsSync(BUNDLED_RG) ? BUNDLED_RG : "rg";
}

function rejectUnsafePath(value: string): void {
	if (value.includes("\0")) throw new Error("Path contains null byte");
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "rg",
		label: "Ripgrep",
		description: "Fast read-only file content search using ripgrep. Respects .gitignore by default.",
		parameters: Type.Object({
			pattern: Type.String({ description: "Regex pattern to search for" }),
			path: Type.Optional(Type.String({ description: "File or directory to search (default: current directory)" })),
			glob: Type.Optional(Type.String({ description: "Optional glob filter, e.g. '*.ts' or '!node_modules/**'" })),
			ignoreCase: Type.Optional(Type.Boolean({ description: "Force case-insensitive search" })),
			fixedStrings: Type.Optional(Type.Boolean({ description: "Treat pattern as a literal string" })),
			maxResults: Type.Optional(Type.Number({ description: "Maximum matching lines to return (default: 200)" })),
		}),
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const searchPath = params.path || ".";
			rejectUnsafePath(searchPath);
			if (params.glob) rejectUnsafePath(params.glob);

			const maxResults = Math.max(1, Math.min(1000, Math.floor(params.maxResults ?? 200)));
			const args = ["--line-number", "--column", "--color", "never", "--heading", "--smart-case"];
			if (params.ignoreCase) args.push("--ignore-case");
			if (params.fixedStrings) args.push("--fixed-strings");
			if (params.glob) args.push("--glob", params.glob);
			args.push(params.pattern, searchPath);

			return await new Promise<string>((resolve, reject) => {
				const child = spawn(resolveRg(), args, { cwd: ctx.cwd });
				let stdout = "";
				let stderr = "";
				let lineCount = 0;
				let truncated = false;

				const abort = () => {
					child.kill("SIGTERM");
					reject(new Error("rg search aborted"));
				};
				signal?.addEventListener("abort", abort, { once: true });

				child.stdout.on("data", (chunk) => {
					const text = String(chunk);
					for (const line of text.split(/(?<=\n)/)) {
						if (!line) continue;
						if (line.endsWith("\n")) lineCount++;
						if (lineCount <= maxResults) stdout += line;
						else truncated = true;
					}
					if (truncated) child.kill("SIGTERM");
				});
				child.stderr.on("data", (chunk) => {
					stderr += String(chunk);
				});
				child.on("error", reject);
				child.on("close", (code) => {
					signal?.removeEventListener("abort", abort);
					if (code === 0 || code === 1 || truncated) {
						const suffix = truncated ? `\n\n[truncated after ${maxResults} matching lines]` : "";
						resolve(stdout.trimEnd() ? `${stdout.trimEnd()}${suffix}` : "No matches");
						return;
					}
					reject(new Error(stderr.trim() || `rg exited with code ${code}`));
				});
			});
		},
	});
}
