/**
 * research.ts — deep research extension for pi
 * Command: /research <query>
 *
 * Injects a structured research prompt so the agent uses its own tools
 * (web_search, web_fetch) to produce a comprehensive, sourced report.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

function buildResearchPrompt(query: string, depth: "quick" | "deep"): string {
  const searches = depth === "deep" ? 6 : 3;
  const sources  = depth === "deep" ? 8 : 4;
  const year = new Date().getFullYear();
  const prevYear = year - 1;

  return `# Deep Research: ${query}

Run a structured research process on the topic above. Follow these steps strictly:

## 1. Search strategy
Generate ${searches} distinct search queries covering different angles of the topic:
- Core definition / what it is
- Latest developments / news (${prevYear}–${year})
- Technical details or how it works
${depth === "deep" ? "- Criticisms, limitations, or controversies\n- Comparisons with alternatives\n- Real-world use cases" : "- Key players or context"}

Execute ALL searches using web_search before proceeding to step 2.

## 2. Source selection
From search results, pick the ${sources} most informative URLs. Prioritize:
- Primary sources over aggregators
- Technical depth over marketing copy
- Recent content (${prevYear}–${year}) over older unless foundational

Fetch each selected URL using web_fetch.

## 3. Synthesis
Write a structured report with these sections:

### TL;DR
2–3 sentence summary of the most important finding.

### Overview
What it is, context, why it matters.

### Key findings
Bullet points with the most relevant information. Be specific — include numbers, dates, names when available.

### How it works (if technical)
Mechanism, architecture, or process. Skip if not applicable.

### Current state (${new Date().getFullYear()})
Latest developments, recent news, where things stand now.

${depth === "deep" ? "### Controversies / limitations\nCritiques, known issues, or open questions.\n\n### Alternatives / comparison\nMain alternatives and how they compare.\n\n" : ""}### Sources
List all URLs consulted with a one-line description of what each contributed.

---

Be direct and information-dense. No filler. Cite specific sources inline (e.g., "according to [source name]").`;
}

export default function researchExtension(pi: ExtensionAPI) {
  pi.registerCommand("research", {
    description: "Deep research on any topic: /research <query> [--quick]",
    handler: async (args: string, ctx: any) => {
      const trimmed = args.trim();
      if (!trimmed) {
        ctx.ui.notify("Usage: /research <query> [--quick]", "warning");
        return;
      }

      const isQuick = trimmed.includes("--quick");
      const query   = trimmed.replace(/--quick/g, "").trim();
      const depth   = isQuick ? "quick" : "deep";

      ctx.ui.notify(`Starting ${depth} research on: "${query}"…`, "info");

      const prompt = buildResearchPrompt(query, depth);
      pi.sendUserMessage(prompt);
    },
  });
}
