/**
 * Cost Meter Extension
 *
 * Muestra el coste acumulado de la sesión en la barra inferior.
 * Precios por millón de tokens (USD):
 *   claude-opus-4          input $15  / output $75
 *   claude-sonnet-4 / 4-5  input $3   / output $15
 *   claude-haiku-3-5       input $0.8 / output $4
 *   claude-haiku-3         input $0.25 / output $1.25
 *   (fallback sonnet)
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const PRICING: Record<string, { input: number; output: number }> = {
	"claude-opus-4":       { input: 15,   output: 75   },
	"claude-opus-4-5":     { input: 15,   output: 75   },
	"claude-sonnet-4":     { input: 3,    output: 15   },
	"claude-sonnet-4-5":   { input: 3,    output: 15   },
	"claude-sonnet-3-7":   { input: 3,    output: 15   },
	"claude-sonnet-3-5":   { input: 3,    output: 15   },
	"claude-haiku-3-5":    { input: 0.8,  output: 4    },
	"claude-haiku-3":      { input: 0.25, output: 1.25 },
};

const FALLBACK = { input: 3, output: 15 };

function getPrice(modelId: string | undefined) {
	if (!modelId) return FALLBACK;
	const key = Object.keys(PRICING).find((k) => modelId.includes(k));
	return key ? PRICING[key] : FALLBACK;
}

function formatCost(usd: number): string {
	if (usd < 0.001) return "<$0.001";
	if (usd < 0.01)  return `$${usd.toFixed(3)}`;
	if (usd < 1)     return `$${usd.toFixed(3)}`;
	return `$${usd.toFixed(2)}`;
}

export default function (pi: ExtensionAPI) {
	let totalCostUsd = 0;
	let savedCtx: any = null;

	pi.on("agent_start", async (_event, ctx) => {
		savedCtx = ctx;
		totalCostUsd = 0;
		ctx.ui.setStatus("cost", ctx.ui.theme.fg("dim", "$0.000"));
	});

	pi.on("turn_end", async (event) => {
		if (!savedCtx) return;
		const msg = event.message as any;
		if (!msg || msg.role !== "assistant") return;

		const inputTokens  = msg.usage?.input  ?? 0;
		const outputTokens = msg.usage?.output ?? 0;
		if (inputTokens === 0 && outputTokens === 0) return;

		const price = getPrice(savedCtx.model?.id);
		const turnCost =
			(inputTokens  / 1_000_000) * price.input +
			(outputTokens / 1_000_000) * price.output;

		totalCostUsd += turnCost;

		const theme = savedCtx.ui.theme;
		const label = formatCost(totalCostUsd);
		savedCtx.ui.setStatus("cost", theme.fg("dim", label));
	});

	pi.on("agent_end", async (_event, ctx) => {
		savedCtx = ctx;
		const theme = ctx.ui.theme;
		const label = formatCost(totalCostUsd);
		ctx.ui.setStatus("cost", theme.fg("accent", label));
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		ctx.ui.setStatus("cost", undefined);
	});
}
