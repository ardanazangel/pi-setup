/**
 * autodiscover.ts — inyecta automáticamente en el system prompt
 * las extensiones instaladas en ~/.pi/agent/extensions/
 *
 * Hook: before_agent_start
 */

import type { ExtensionAPI, BeforeAgentStartEvent, BeforeAgentStartEventResult } from "@earendil-works/pi-coding-agent";
import * as fs from "fs";
import * as path from "path";

const EXTENSIONS_DIR = path.join(process.env.HOME!, ".pi", "agent", "extensions");
const SELF = "autodiscover.ts";

function extractCommands(src: string): { name: string; description: string }[] {
  const results: { name: string; description: string }[] = [];
  // Match: registerCommand("name", { description: "..." })
  const re = /registerCommand\(\s*["']([^"']+)["']\s*,\s*\{[^}]*description\s*:\s*["'`]([^"'`]+)["'`]/gs;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    results.push({ name: m[1]!, description: m[2]! });
  }
  return results;
}

function buildSection(commands: { file: string; name: string; description: string }[]): string {
  if (commands.length === 0) return "";

  const lines = [
    "## Extensiones / Comandos propios",
    "",
    "Comandos slash disponibles (autodescubiertos de `~/.pi/agent/extensions/`):",
    "",
  ];

  for (const cmd of commands) {
    lines.push(`- **/${cmd.name}** → ${cmd.description}`);
  }

  return lines.join("\n");
}

export default function (pi: ExtensionAPI) {
  pi.on("before_agent_start", async (_event: BeforeAgentStartEvent): Promise<BeforeAgentStartEventResult | void> => {
    try {
      const files = fs.readdirSync(EXTENSIONS_DIR).filter(
        (f) => f.endsWith(".ts") && f !== SELF && !f.endsWith(".json")
      );

      const commands: { file: string; name: string; description: string }[] = [];

      for (const file of files) {
        const src = fs.readFileSync(path.join(EXTENSIONS_DIR, file), "utf-8");
        const found = extractCommands(src);
        for (const cmd of found) {
          commands.push({ file, ...cmd });
        }
      }

      if (commands.length === 0) return;

      const section = buildSection(commands);
      const systemPrompt = _event.systemPrompt + "\n\n" + section;

      return { systemPrompt };
    } catch {
      // Silencioso — no romper la sesión si falla el scan
    }
  });
}
