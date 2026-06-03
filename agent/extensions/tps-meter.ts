/**
 * TPS Meter Extension
 *
 * Shows tokens per second in the footer status bar.
 * - Durante streaming: estimación en vivo basada en deltas (~4 chars/token)
 * - Al final del run: TPS global acumulado de todos los mensajes del agente
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	/** Timestamp cuando empieza el mensaje actual. Fallback si no hay stream. */
	let messageStart: number | null = null;
	/** Timestamp del primer output delta del mensaje actual. */
	let streamStart: number | null = null;
	/** Tokens estimados del stream actual (antes de que el provider reporte el total oficial). */
	let estimatedStreamedTokens = 0;
	/** Output tokens oficiales acumulados en todo el agent run. */
	let totalOutputTokens = 0;
	/** Tiempo total (ms) de streaming real, excluyendo latencia first-token y tool calls. */
	let totalStreamMs = 0;

	pi.on("agent_start", async (_event, ctx) => {
		totalOutputTokens = 0;
		totalStreamMs = 0;
		messageStart = null;
		streamStart = null;
		estimatedStreamedTokens = 0;
		ctx.ui.setStatus("tps", ctx.ui.theme.fg("dim", "⏱ generating..."));
	});

	pi.on("turn_start", async (_event, _ctx) => {
		messageStart = Date.now();
		streamStart = null;
		estimatedStreamedTokens = 0;
	});

	pi.on("message_update", async (event, ctx) => {
		const streamEvent = event.assistantMessageEvent;
		const isOutputDelta =
			streamEvent.type === "text_delta" ||
			streamEvent.type === "thinking_delta" ||
			streamEvent.type === "toolcall_delta";

		if (!isOutputDelta) return;

		const now = Date.now();
		streamStart ??= now;
		estimatedStreamedTokens += Math.max(0, streamEvent.delta.length / 4);

		const elapsed = (now - streamStart) / 1000;
		const officialTokens = event.message.usage?.output ?? 0;
		const currentTokens = officialTokens > 0 ? officialTokens : estimatedStreamedTokens;

		if (elapsed > 0.1 && currentTokens > 0) {
			const tps = Math.round(currentTokens / elapsed);
			const tokenLabel = officialTokens > 0
				? `${officialTokens} tok`
				: `~${Math.round(estimatedStreamedTokens)} tok`;
			const theme = ctx.ui.theme;
			ctx.ui.setStatus(
				"tps",
				`${theme.fg("accent", `${tps} tok/s`)} ${theme.fg("dim", `(${tokenLabel} / ${elapsed.toFixed(1)}s)`)}`,
			);
		}
	});

	pi.on("turn_end", async (event) => {
		const msg = event.message;
		if (!msg || msg.role !== "assistant") return;

		const messageTokens = (msg as any).usage?.output ?? 0;
		const timingStart = streamStart ?? messageStart;
		if (!timingStart || messageTokens <= 0) {
			messageStart = null;
			streamStart = null;
			estimatedStreamedTokens = 0;
			return;
		}

		totalOutputTokens += messageTokens;
		totalStreamMs += Math.max(0, Date.now() - timingStart);

		messageStart = null;
		streamStart = null;
		estimatedStreamedTokens = 0;
	});

	pi.on("agent_end", async (_event, ctx) => {
		const elapsed = totalStreamMs / 1000;
		const tps = totalOutputTokens > 0 && elapsed > 0 ? Math.round(totalOutputTokens / elapsed) : 0;

		const theme = ctx.ui.theme;
		const icon = theme.fg("success", "✓");
		const tpsLabel = tps > 0
			? theme.fg("accent", `${tps} tok/s`)
			: theme.fg("dim", "N/A");
		const detail = theme.fg("dim", `${totalOutputTokens} tokens in ${elapsed.toFixed(1)}s streaming`);

		ctx.ui.notify(`${icon} ${tpsLabel}  ${detail}`, "info");
		ctx.ui.setStatus("tps", theme.fg("dim", `done — ${tpsLabel}`));
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		ctx.ui.setStatus("tps", undefined);
	});
}
