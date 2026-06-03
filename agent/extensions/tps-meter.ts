/**
 * TPS Meter Extension
 *
 * Shows tokens per second in the footer status bar.
 * - During streaming: live estimate based on text deltas (~4 chars/token)
 * - After turn ends: accurate TPS from actual usage.output / elapsed time
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	let turnStartTime = 0;
	let firstDeltaTime = 0;
	let charCount = 0;
	let isStreaming = false;

	pi.on("session_start", async (_event, ctx) => {
		ctx.ui.setStatus("tps", ctx.ui.theme.fg("dim", "—"));
	});

	pi.on("turn_start", async (_event, _ctx) => {
		turnStartTime = Date.now();
		firstDeltaTime = 0;
		charCount = 0;
		isStreaming = false;
	});

	pi.on("message_update", async (event, ctx) => {
		const e = event.assistantMessageEvent;
		if (e.type !== "text_delta") return;

		const now = Date.now();
		if (!firstDeltaTime) firstDeltaTime = now;
		isStreaming = true;

		charCount += e.delta.length;

		// Estimate: ~4 chars per token
		const estimatedTokens = charCount / 4;
		const elapsedSec = (now - firstDeltaTime) / 1000;
		if (elapsedSec < 0.1) return;

		const tps = estimatedTokens / elapsedSec;
		const theme = ctx.ui.theme;
		const label = theme.fg("accent", `~${tps.toFixed(0)}`);
		ctx.ui.setStatus("tps", label);
	});

	pi.on("turn_end", async (event, ctx) => {
		if (!isStreaming) return;

		const theme = ctx.ui.theme;

		// Use actual output token count if available
		const msg = event.message;
		if (msg && msg.role === "assistant" && (msg as any).usage?.output > 0) {
			const usage = (msg as any).usage;
			const elapsedSec = (Date.now() - (firstDeltaTime || turnStartTime)) / 1000;
			if (elapsedSec > 0) {
				const tps = usage.output / elapsedSec;
				const label = theme.fg("accent", `${tps.toFixed(0)} (${usage.output} tok)`);
				ctx.ui.setStatus("tps", label);
				return;
			}
		}

		// Fallback: keep estimate shown
		isStreaming = false;
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		ctx.ui.setStatus("tps", undefined);
	});
}
