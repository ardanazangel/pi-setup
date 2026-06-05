/**
 * workflow.ts — dynamic multi-agent workflow orchestration for pi
 *
 * Command: /workflow <task> [--adversarial|--tournament|--loop]
 *                           [--quality fast|balanced|best] [--quick]
 *
 * Patterns: --adversarial | --tournament | --loop (mutually exclusive)
 * --quick is an alias for --quality fast
 *
 * Quality tiers:
 *   fast     — haiku for all agents (cheap, 3-5x faster)
 *   balanced — haiku for scout, sonnet for worker/researcher (default)
 *   best     — sonnet for scout, opus for worker/researcher (max quality)
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fileURLToPath } from "url";
import * as fs from "fs";
import * as path from "path";

type Pattern = "auto" | "adversarial" | "tournament" | "loop";
type Quality = "fast" | "balanced" | "best";

const AGENTS_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "subagents/agents"
);

const MODEL_TIERS: Record<Quality, Record<string, string>> = {
  fast: {
    scout:      "anthropic/claude-haiku-4-5",
    researcher: "anthropic/claude-haiku-4-5",
    worker:     "anthropic/claude-haiku-4-5",
  },
  balanced: {
    scout:      "anthropic/claude-haiku-4-5",
    researcher: "anthropic/claude-sonnet-4-6",
    worker:     "anthropic/claude-sonnet-4-6",
  },
  best: {
    scout:      "anthropic/claude-sonnet-4-6",
    researcher: "anthropic/claude-opus-4-8",
    worker:     "anthropic/claude-opus-4-8",
  },
};

// Track which quality-variant agent names this module has already registered
// so we never call registerAgent twice for the same name in one process.
const registeredVariants = new Set<string>();

function loadAgentSystemPrompt(agentName: string): string | null {
  try {
    const filePath = path.join(AGENTS_DIR, `${agentName}.md`);
    const content = fs.readFileSync(filePath, "utf-8");
    // Strip YAML frontmatter
    const match = content.match(/^---\n[\s\S]*?\n---\n([\s\S]*)$/);
    return match ? match[1].trim() : content.trim();
  } catch {
    console.warn(`[workflow] failed to load agent prompt for ${agentName}`);
    return null;
  }
}

/**
 * Registers quality-variant agents (e.g. scout-fast, worker-best).
 * Returns true if ALL three agents are available, false otherwise.
 */
function registerQualityAgents(quality: Quality): boolean {
  const subagents = (globalThis as any).__pi_subagents;
  if (!subagents?.registerAgent) {
    console.warn("[workflow] __pi_subagents unavailable; quality variants not registered");
    return false;
  }

  const models = MODEL_TIERS[quality];
  let allOk = true;

  for (const [agentName, model] of Object.entries(models)) {
    const variantName = `${agentName}-${quality}`;

    // Already registered by this module in a previous call — treat as success
    if (registeredVariants.has(variantName)) {
      continue;
    }

    const systemPrompt = loadAgentSystemPrompt(agentName);
    if (!systemPrompt) {
      console.warn(`[workflow] skipping ${variantName}: system prompt unavailable`);
      allOk = false;
      continue;
    }

    try {
      subagents.registerAgent({
        name: variantName,
        description: `${agentName} (${quality} quality — ${model.split("/")[1] ?? model})`,
        tools: agentName === "scout"
          ? ["read", "grep", "find", "ls"]
          : agentName === "researcher"
          ? ["web_search", "web_fetch"]
          : ["read", "write", "edit", "safe_bash"],
        model,
        systemPrompt,
        filePath: path.join(AGENTS_DIR, `${agentName}.md`),
      });
      registeredVariants.add(variantName);
    } catch (e: any) {
      if (typeof e?.message === "string" && e.message.includes("already registered")) {
        // Agent was registered by another part of the system — still available
        registeredVariants.add(variantName);
      } else {
        console.warn(`[workflow] failed to register ${variantName}: ${e?.message}`);
        allOk = false;
      }
    }
  }

  return allOk;
}

function buildWorkflowPrompt(task: string, pattern: Pattern, quality: Quality): string {
  const patternHint = pattern === "auto"
    ? ""
    : `\n> **Forced pattern: ${pattern}** — use this pattern regardless of task shape.\n`;

  const models = MODEL_TIERS[quality];
  const agentSuffix = quality === "balanced" ? "" : `-${quality}`;
  const qualityNote = quality === "balanced"
    ? ""
    : `\n> **Quality: ${quality}** — use \`scout${agentSuffix}\`, \`researcher${agentSuffix}\`, \`worker${agentSuffix}\` agents.\n`;

  const agentTable = `
| Agent | Best for | Model |
|-------|----------|-------|
| **scout${agentSuffix}** | Code exploration, grep, find, read | ${models.scout.split("/")[1] ?? models.scout} |
| **researcher${agentSuffix}** | Web research, web_search, fetch | ${models.researcher.split("/")[1] ?? models.researcher} |
| **worker${agentSuffix}** | Code changes, write, edit, bash | ${models.worker.split("/")[1] ?? models.worker} |`;

  return `# Workflow Task
${task}
${patternHint}${qualityNote}
## Your role

You are an orchestrator. Design and execute a multi-agent workflow to complete the task above using subagents. Do NOT do the work yourself — delegate everything to agents.

## Step 1 — Analyze (think before acting)

Before calling any tool, reason about:
- What are the independent subtasks that can run in parallel?
- Does the output need adversarial verification (correctness matters)?
- Are there multiple valid approaches worth comparing (tournament)?
- Is the amount of work unknown upfront (loop until done)?
- Is the input heterogeneous and needs classification first?

Write your analysis as a short plan before executing anything.

## Step 2 — Choose pattern(s)

### fan-out + synthesize
Split into N parallel subtasks → merge results.
Use when: multiple data sources, independent subtasks, large volume of similar work.
\`\`\`
subagent({ tasks: [
  { agent: "researcher${agentSuffix}", task: "..." },
  { agent: "researcher${agentSuffix}", task: "..." },
  { agent: "scout${agentSuffix}",      task: "..." },
]})
// then synthesize results
\`\`\`

### adversarial verification
For each output, a separate agent tries to find flaws.
Use when: correctness is critical, output will be acted upon.
\`\`\`
// Step A: generate
subagent({ agent: "worker${agentSuffix}", task: "implement X" })
// Step B: attack
subagent({ agent: "scout${agentSuffix}", task: "Given this output: [paste A]. Find bugs, edge cases, wrong assumptions. Be adversarial." })
// Step C: fix if needed
\`\`\`

### tournament
N agents attack same task with different approaches → judge pairwise.
Use when: taste-based decisions, naming, architecture, multiple valid solutions.
\`\`\`
subagent({ tasks: [
  { agent: "worker${agentSuffix}", task: "Approach A: ..." },
  { agent: "worker${agentSuffix}", task: "Approach B: ..." },
  { agent: "worker${agentSuffix}", task: "Approach C: ..." },
]})
// judge: subagent({ agent: "scout${agentSuffix}", task: "Given these 3 outputs [paste], rank by [rubric]" })
\`\`\`

### loop until done
Keep spawning agents until stop condition met.
Use when: unknown amount of work (all tests pass, no errors left, all items processed).
\`\`\`
// Iteration 1
subagent({ agent: "worker${agentSuffix}", task: "Fix failing tests. Return: list of remaining failures." })
// If failures remain → iterate (max 3 without user approval)
\`\`\`

### classify + route
Classifier agent analyzes input → routes to appropriate agent/approach.
Use when: heterogeneous tasks, different subtasks need different handling.
\`\`\`
subagent({ agent: "scout${agentSuffix}", task: "Analyze [X]. Classify as simple/complex/needs-research. Output JSON." })
// route based on classification
\`\`\`

## Step 3 — Execute

Rules:
- **Launch parallel subtasks in a single subagent call** using \`tasks\` array — never sequentially if independent
- Each agent has zero context from this conversation — **include ALL necessary context in the task string**
- Verifier agents must receive the complete output they're verifying, pasted inline
- For loops: check stop condition from agent output before iterating
- Max 3 loop iterations without user approval

Available agents:
${agentTable}

## Step 4 — Synthesize

After agents complete:
1. Aggregate outputs into a coherent result
2. Resolve conflicts between agent outputs
3. Produce a final structured report

**Show your plan before executing. Then execute. Then synthesize.**`;
}

export default function workflowExtension(pi: ExtensionAPI) {
  pi.registerCommand("workflow", {
    description:
      "Multi-agent workflow: /workflow <task> [--adversarial|--tournament|--loop] [--quality fast|balanced|best] (--quick = alias for --quality fast)",
    handler: async (args: string, ctx: any) => {
      const trimmed = args.trim();
      if (!trimmed) {
        ctx.ui.notify(
          "Usage: /workflow <task> [--adversarial|--tournament|--loop|--quick] [--quality fast|balanced|best]",
          "warning"
        );
        return;
      }

      // Parse pattern using word-boundary regexes to avoid false matches
      let pattern: Pattern = "auto";
      if (/(?:^|\s)--adversarial\b/.test(trimmed)) pattern = "adversarial";
      else if (/(?:^|\s)--tournament\b/.test(trimmed)) pattern = "tournament";
      else if (/(?:^|\s)--loop\b/.test(trimmed)) pattern = "loop";

      // Parse quality — explicit --quality takes precedence over --quick
      let quality: Quality = "balanced";
      const qualityMatch = trimmed.match(/(?:^|\s)--quality\s+(fast|balanced|best)\b/);
      if (qualityMatch) {
        quality = qualityMatch[1] as Quality;
      } else if (/(?:^|\s)--quick\b/.test(trimmed)) {
        // --quick is an alias for --quality fast
        quality = "fast";
      }

      // Clean task string — strip recognized flags with word-boundary safety
      const task = trimmed
        .replace(/(?:^|\s)--adversarial\b/g, " ")
        .replace(/(?:^|\s)--tournament\b/g, " ")
        .replace(/(?:^|\s)--loop\b/g, " ")
        .replace(/(?:^|\s)--quick\b/g, " ")
        .replace(/(?:^|\s)--quality\s+(fast|balanced|best)\b/g, " ")
        .replace(/\s{2,}/g, " ")
        .trim();

      // Validate that a non-empty task remains after stripping flags
      if (!task) {
        ctx.ui.notify("Task required after flags", "error");
        return;
      }

      // Register quality variants if not balanced (default agents already exist).
      // Fall back to balanced if variant registration fails.
      if (quality !== "balanced") {
        const ok = registerQualityAgents(quality);
        if (!ok) {
          ctx.ui.notify(`Quality '${quality}' agents unavailable — falling back to balanced`, "warning");
          quality = "balanced";
        }
      }

      const patternLabel = pattern === "auto" ? "auto-detect" : pattern;
      ctx.ui.notify(
        `Workflow [${patternLabel}] [${quality}]: "${task}"…`,
        "info"
      );

      const prompt = buildWorkflowPrompt(task, pattern, quality);
      try {
        pi.sendUserMessage(prompt);
      } catch (e: any) {
        ctx.ui.notify(`Workflow failed: ${e.message}`, "error");
      }
    },
  });
}
