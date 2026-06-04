/**
 * TPS Meter Extension
 *
 * Muestra tokens por segundo al final de cada turno del agente via notify.
 * Al final del run muestra el TPS global acumulado.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	let streamStart: number | null = null;
	let messageStart: number | null = null;
	let estimatedStreamedTokens = 0;
	let totalOutputTokens = 0;
	let totalStreamMs = 0;

	pi.on("agent_start", async () => {
		totalOutputTokens = 0;
		totalStreamMs = 0;
		messageStart = null;
		streamStart = null;
		estimatedStreamedTokens = 0;
	});

	pi.on("turn_start", async () => {
		messageStart = Date.now();
		streamStart = null;
		estimatedStreamedTokens = 0;
	});

	pi.on("message_update", async (event) => {
		const streamEvent = event.assistantMessageEvent;
		const isOutputDelta =
			streamEvent.type === "text_delta" ||
			streamEvent.type === "thinking_delta" ||
			streamEvent.type === "toolcall_delta";

		if (!isOutputDelta) return;

		const now = Date.now();
		streamStart ??= now;
		estimatedStreamedTokens += Math.max(0, streamEvent.delta.length / 4);
	});

	pi.on("turn_end", async (event, ctx) => {
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

		const elapsed = Math.max(0, Date.now() - timingStart) / 1000;
		const tps = elapsed > 0 ? Math.round(messageTokens / elapsed) : 0;

		totalOutputTokens += messageTokens;
		totalStreamMs += elapsed * 1000;

		if (tps > 0) {
			const theme = ctx.ui.theme;
			ctx.ui.notify(
				`${theme.fg("accent", `${tps} tok/s`)}  ${theme.fg("dim", `${messageTokens} tokens · ${elapsed.toFixed(1)}s`)}`,
				"info"
			);
		}

		messageStart = null;
		streamStart = null;
		estimatedStreamedTokens = 0;
	});
}
