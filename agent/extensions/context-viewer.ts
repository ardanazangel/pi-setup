/**
 * /context — Visualize current context usage as a colored grid overlay.
 *
 * Fixed:
 * - Uses am.usage.output (real tokens) instead of length/4 for assistant messages
 * - Splits thinking vs text tokens by content ratio applied to real output count
 * - getSystemPrompt() called directly (always available on ExtensionContext)
 * - Grid cells use largest-remainder allocation — no rounding drift
 * - usage.tokens null is handled explicitly (shows "~" prefix)
 */

import type {
    ExtensionAPI,
    ExtensionCommandContext,
    ContextUsage,
    Theme,
} from "@mariozechner/pi-coding-agent";
import type { AssistantMessage, ToolResultMessage, UserMessage } from "@mariozechner/pi-ai";
import { matchesKey, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";

// ── Category definitions ──────────────────────────────────────────────

interface Category {
    key: string;
    label: string;
    tokens: number;
    color: (theme: Theme, text: string) => string;
    square: string;
}

const ansi256Fg = (code: number, text: string) => `\x1b[38;5;${code}m${text}\x1b[0m`;
const ansi256Bg = (code: number, text: string) => `\x1b[48;5;${code}m${text}\x1b[0m`;

// ── Token estimation (only used where no real counts exist) ───────────

function estimateStringTokens(text: string): number {
    return Math.ceil(text.length / 4);
}

function estimateContentTokens(content: string | Array<{ type: string; [k: string]: any }>): number {
    if (typeof content === "string") return estimateStringTokens(content);
    let total = 0;
    for (const block of content) {
        if (block.type === "text") {
            total += estimateStringTokens(block.text ?? "");
        } else if (block.type === "image") {
            total += 1600;
        }
    }
    return total;
}

// ── Breakdown computation ─────────────────────────────────────────────

interface ContextBreakdown {
    categories: Category[];
    totalTokens: number;
    contextWindow: number;
    percent: number | null;
    tokensIsEstimated: boolean;
    cacheRead: number;
    cacheWrite: number;
    totalCost: number;
    messageCount: number;
    turnCount: number;
}

function computeBreakdown(ctx: any): ContextBreakdown | null {
    const usage: ContextUsage | undefined = ctx.getContextUsage();
    if (!usage) return null;

    const { contextWindow } = usage;
    const branch = ctx.sessionManager.getBranch();

    let systemPromptTokens = 0;
    let userTokens = 0;
    let assistantTextTokens = 0;
    let thinkingTokens = 0;
    let compactionTokens = 0;
    let customMessageTokens = 0;
    let imageTokens = 0;
    const toolTokens: Record<string, number> = {};
    let cacheRead = 0;
    let cacheWrite = 0;
    let totalCost = 0;
    let turnCount = 0;
    let messageCount = 0;

    // getSystemPrompt() is always available on ExtensionContext — no try/catch needed
    const sysPrompt = ctx.getSystemPrompt();
    if (sysPrompt) {
        systemPromptTokens = estimateStringTokens(sysPrompt);
    }

    for (const entry of branch) {
        if (entry.type === "message") {
            const msg = entry.message;
            messageCount++;

            if (msg.role === "user") {
                const um = msg as UserMessage;
                const content = um.content;
                if (typeof content === "string") {
                    userTokens += estimateStringTokens(content);
                } else if (Array.isArray(content)) {
                    for (const block of content) {
                        if (block.type === "text") {
                            userTokens += estimateStringTokens(block.text);
                        } else if (block.type === "image") {
                            imageTokens += 1600;
                        }
                    }
                }
            } else if (msg.role === "assistant") {
                const am = msg as AssistantMessage;
                turnCount++;
                cacheRead += am.usage.cacheRead;
                cacheWrite += am.usage.cacheWrite;
                totalCost += am.usage.cost.total;

                // Use real output token count instead of estimating from text length
                const realOutputTokens = am.usage.output;

                // Estimate the ratio of thinking vs text from content lengths,
                // then apply that ratio to the real token count
                let rawTextLen = 0;
                let rawThinkingLen = 0;
                for (const block of am.content) {
                    if (block.type === "text") rawTextLen += block.text.length;
                    else if (block.type === "thinking") rawThinkingLen += (block as any).thinking.length;
                }
                const rawTotal = rawTextLen + rawThinkingLen;
                if (rawTotal > 0) {
                    const thinkRatio = rawThinkingLen / rawTotal;
                    thinkingTokens += Math.round(realOutputTokens * thinkRatio);
                    assistantTextTokens += Math.round(realOutputTokens * (1 - thinkRatio));
                } else {
                    assistantTextTokens += realOutputTokens;
                }
            } else if (msg.role === "toolResult") {
                const tr = msg as ToolResultMessage;
                const name = tr.toolName || "unknown";
                // Tool results have no token count in the API — estimate from content
                const tokens = estimateContentTokens(tr.content);
                toolTokens[name] = (toolTokens[name] ?? 0) + tokens;
            }
        } else if (entry.type === "compaction" || entry.type === "branch_summary") {
            compactionTokens += estimateStringTokens(entry.summary ?? "");
        } else if (entry.type === "custom_message") {
            const content = entry.content;
            if (typeof content === "string") {
                customMessageTokens += estimateStringTokens(content);
            } else if (Array.isArray(content)) {
                customMessageTokens += estimateContentTokens(content);
            }
        }
    }

    // Build categories list (only non-zero)
    const categories: Category[] = [];

    const addCat = (
        key: string,
        label: string,
        tokens: number,
        color: (theme: Theme, text: string) => string,
        square: string,
    ) => {
        if (tokens > 0) categories.push({ key, label, tokens, color, square });
    };

    addCat("system",    "System Prompt",   systemPromptTokens,   (_th, t) => ansi256Fg(141, t), ansi256Bg(141, "  "));
    addCat("user",      "User Messages",   userTokens,           (_th, t) => ansi256Fg(75,  t), ansi256Bg(75,  "  "));
    addCat("assistant", "Assistant Text",  assistantTextTokens,  (_th, t) => ansi256Fg(114, t), ansi256Bg(114, "  "));
    addCat("thinking",  "Thinking",        thinkingTokens,       (_th, t) => ansi256Fg(216, t), ansi256Bg(216, "  "));

    const builtinTools: Record<string, { label: string; colorCode: number }> = {
        read:                { label: "Tool: read",       colorCode: 73  },
        bash:                { label: "Tool: bash",       colorCode: 167 },
        edit:                { label: "Tool: edit",       colorCode: 179 },
        write:               { label: "Tool: write",      colorCode: 143 },
        grep:                { label: "Tool: grep",       colorCode: 109 },
        find:                { label: "Tool: find",       colorCode: 146 },
        ls:                  { label: "Tool: ls",         colorCode: 108 },
        subagent:            { label: "Tool: subagent",   colorCode: 175 },
        web_search:          { label: "Tool: web_search", colorCode: 74  },
        web_fetch:           { label: "Tool: web_fetch",  colorCode: 38  },
        ask_user_question:   { label: "Tool: ask_user",   colorCode: 183 },
        video_extract:       { label: "Tool: video",      colorCode: 204 },
        google_image_search: { label: "Tool: img_search", colorCode: 214 },
        youtube_search:      { label: "Tool: yt_search",  colorCode: 196 },
    };
    const customToolColors = [132, 166, 130, 97, 136, 169, 103, 172];
    let customColorIdx = 0;

    const sortedTools = Object.entries(toolTokens).sort((a, b) => b[1] - a[1]);
    for (const [name, tokens] of sortedTools) {
        const builtin = builtinTools[name];
        const colorCode = builtin?.colorCode ?? customToolColors[customColorIdx++ % customToolColors.length]!;
        const label = builtin?.label ?? `Tool: ${name}`;
        addCat(`tool:${name}`, label, tokens, (_th, t) => ansi256Fg(colorCode, t), ansi256Bg(colorCode, "  "));
    }

    addCat("compaction", "Compaction",      compactionTokens,     (_th, t) => ansi256Fg(245, t), ansi256Bg(245, "  "));
    addCat("custom",     "Custom Messages", customMessageTokens,  (_th, t) => ansi256Fg(183, t), ansi256Bg(183, "  "));
    addCat("images",     "Images",          imageTokens,          (_th, t) => ansi256Fg(219, t), ansi256Bg(219, "  "));

    // Real token total from pi (may be null right after compaction)
    const tokensIsEstimated = usage.tokens === null;
    const usedFromCategories = categories.reduce((s, c) => s + c.tokens, 0);
    const totalTokens = usage.tokens ?? usedFromCategories;
    const freeTokens = Math.max(0, contextWindow - totalTokens);

    categories.push({
        key: "free",
        label: "Free",
        tokens: freeTokens,
        color: (_th, t) => ansi256Fg(240, t),
        square: ansi256Bg(236, "  "),
    });

    return {
        categories,
        totalTokens,
        contextWindow,
        percent: usage.percent,
        tokensIsEstimated,
        cacheRead,
        cacheWrite,
        totalCost,
        messageCount,
        turnCount,
    };
}

// ── Grid rendering — largest-remainder allocation ─────────────────────

function renderGrid(breakdown: ContextBreakdown, width: number): string[] {
    const lines: string[] = [];
    const squareW = 2;
    const cols = Math.floor(width / squareW);
    if (cols <= 0) return lines;

    const targetRows = Math.min(15, Math.max(6, Math.floor(width / 8)));
    const cellsTotal = cols * targetRows;

    // Largest-remainder method — eliminates rounding drift
    const exact = breakdown.categories.map(c => (c.tokens / breakdown.contextWindow) * cellsTotal);
    const floors = exact.map(v => Math.floor(v));
    const remainder = exact.map((v, i) => v - floors[i]!);
    const allocated = [...floors];
    let leftover = cellsTotal - allocated.reduce((s, v) => s + v, 0);

    // Distribute remaining cells to highest remainders
    const indices = remainder
        .map((r, i) => ({ r, i }))
        .sort((a, b) => b.r - a.r);
    for (let k = 0; k < leftover && k < indices.length; k++) {
        allocated[indices[k]!.i]!++;
    }

    // Build cell array
    const cells: string[] = [];
    for (let ci = 0; ci < breakdown.categories.length; ci++) {
        const cat = breakdown.categories[ci]!;
        const count = allocated[ci]!;
        for (let i = 0; i < count; i++) cells.push(cat.square);
    }
    // Safety: trim/pad to exact cellsTotal
    while (cells.length < cellsTotal) cells.push(ansi256Bg(236, "  "));

    const gridW = cols * squareW;
    const leftPad = " ".repeat(Math.max(0, Math.floor((width - gridW) / 2)));

    for (let row = 0; row < targetRows; row++) {
        const start = row * cols;
        lines.push(leftPad + cells.slice(start, start + cols).join(""));
    }

    return lines;
}

// ── Overlay ───────────────────────────────────────────────────────────

function formatTokens(n: number): string {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
    return `${n}`;
}

function buildOverlay(breakdown: ContextBreakdown, theme: Theme, width: number): string[] {
    const lines: string[] = [];
    const innerW = width - 2;

    const pad = (s: string, len: number) => {
        const vis = visibleWidth(s);
        return s + " ".repeat(Math.max(0, len - vis));
    };
    const row = (content: string) =>
        theme.fg("border", "│") + pad(` ${content}`, innerW) + theme.fg("border", "│");
    const emptyRow = () => row("");
    const hr = () =>
        theme.fg("border", "│") + theme.fg("dim", "─".repeat(innerW)) + theme.fg("border", "│");

    // Top border + title
    lines.push(theme.fg("border", `╭${"─".repeat(innerW)}╮`));

    const pct = breakdown.percent !== null ? ` (${breakdown.percent.toFixed(1)}%)` : "";
    lines.push(row(theme.bold(theme.fg("accent", `Context Window Usage${pct}`))));

    const prefix = breakdown.tokensIsEstimated ? "~" : "";
    lines.push(row(theme.fg("muted", `${prefix}${formatTokens(breakdown.totalTokens)} / ${formatTokens(breakdown.contextWindow)} tokens`)));

    if (breakdown.tokensIsEstimated) {
        lines.push(row(theme.fg("dim", "Token count unavailable after compaction — showing estimate")));
    }

    lines.push(emptyRow());

    // Grid
    for (const gl of renderGrid(breakdown, innerW)) {
        lines.push(theme.fg("border", "│") + pad(gl, innerW) + theme.fg("border", "│"));
    }

    lines.push(emptyRow());
    lines.push(hr());
    lines.push(emptyRow());

    // Legend — two columns
    const nonFreeCategories = breakdown.categories.filter(c => c.key !== "free");
    const freeCat = breakdown.categories.find(c => c.key === "free");
    const colW = Math.floor((innerW - 2) / 2);

    const formatEntry = (cat: Category, w: number): string => {
        const pctStr = ((cat.tokens / breakdown.contextWindow) * 100).toFixed(1);
        const label = `${cat.square} ${cat.color(theme, cat.label)}`;
        const value = theme.fg("dim", `${formatTokens(cat.tokens)} (${pctStr}%)`);
        return pad(`${label} ${value}`, w);
    };

    for (let i = 0; i < nonFreeCategories.length; i += 2) {
        const left = nonFreeCategories[i]!;
        const right = nonFreeCategories[i + 1];
        let content = " " + formatEntry(left, colW);
        if (right) content += formatEntry(right, colW);
        lines.push(theme.fg("border", "│") + pad(content, innerW) + theme.fg("border", "│"));
    }

    if (freeCat && freeCat.tokens > 0) {
        const pctStr = ((freeCat.tokens / breakdown.contextWindow) * 100).toFixed(1);
        const label = `${freeCat.square} ${freeCat.color(theme, freeCat.label)}`;
        const value = theme.fg("dim", `${formatTokens(freeCat.tokens)} (${pctStr}%)`);
        lines.push(row(`${label} ${value}`));
    }

    lines.push(emptyRow());
    lines.push(hr());
    lines.push(emptyRow());

    // Stats
    lines.push(row(theme.bold(theme.fg("accent", "Session Stats"))));
    const stats = [
        `Turns: ${breakdown.turnCount}`,
        `Messages: ${breakdown.messageCount}`,
        `Cache read: ${formatTokens(breakdown.cacheRead)}`,
        `Cache write: ${formatTokens(breakdown.cacheWrite)}`,
        `Cost: $${breakdown.totalCost.toFixed(4)}`,
    ];
    const sep = theme.fg("dim", "  │  ");
    const sepW = visibleWidth(sep);
    const contentW = innerW - 1;
    let currentLine = "";
    let currentW = 0;
    for (const item of stats) {
        const colored = theme.fg("muted", item);
        const itemW = visibleWidth(colored);
        const needsSep = currentW > 0;
        if (currentW > 0 && currentW + (needsSep ? sepW : 0) + itemW > contentW) {
            lines.push(row(currentLine));
            currentLine = colored;
            currentW = itemW;
        } else {
            currentLine += (needsSep ? sep : "") + colored;
            currentW += (needsSep ? sepW : 0) + itemW;
        }
    }
    if (currentLine) lines.push(row(currentLine));

    // Suggestions
    const suggestions: string[] = [];
    if (breakdown.percent !== null && breakdown.percent > 95) {
        suggestions.push("🔴 Near context limit — compaction strongly recommended");
    } else if (breakdown.percent !== null && breakdown.percent > 80) {
        suggestions.push("⚠ Context usage above 80% — consider /compact");
    }

    const toolCats = breakdown.categories.filter(c => c.key.startsWith("tool:"));
    const biggestTool = toolCats.sort((a, b) => b.tokens - a.tokens)[0];
    if (biggestTool && biggestTool.tokens > breakdown.contextWindow * 0.2) {
        const pct = ((biggestTool.tokens / breakdown.contextWindow) * 100).toFixed(0);
        suggestions.push(`💡 ${biggestTool.label} uses ${pct}% — consider summarizing large outputs`);
    }

    if (suggestions.length > 0) {
        lines.push(emptyRow());
        lines.push(hr());
        lines.push(emptyRow());
        for (const s of suggestions) lines.push(row(theme.fg("warning", s)));
    }

    lines.push(emptyRow());
    lines.push(row(theme.fg("dim", "Press Escape or Q to close")));
    lines.push(theme.fg("border", `╰${"─".repeat(innerW)}╯`));

    return lines;
}

// ── Entry point ───────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
    pi.registerCommand("context", {
        description: "Visualize current context usage as a colored grid",
        handler: async (_args: string, ctx: ExtensionCommandContext) => {
            const breakdown = computeBreakdown(ctx);
            if (!breakdown) {
                ctx.ui.notify("No context usage data available yet. Send a message first.", "warning");
                return;
            }

            await ctx.ui.custom<void>(
                (tui, theme, _keybindings, done) => {
                    return {
                        handleInput(data: string) {
                            if (
                                matchesKey(data, "escape") ||
                                matchesKey(data, "q") ||
                                matchesKey(data, "return")
                            ) {
                                done(undefined);
                            }
                        },
                        render(width: number): string[] {
                            return buildOverlay(breakdown, theme, width);
                        },
                        invalidate() {},
                    };
                },
                {
                    overlay: true,
                    overlayOptions: {
                        anchor: "center",
                        width: "80%",
                        maxWidth: 100,
                        minWidth: 40,
                        maxHeight: "90%",
                    },
                },
            );
        },
    });
}
