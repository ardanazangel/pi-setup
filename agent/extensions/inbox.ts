/**
 * inbox.ts — /inbox command: fetch recent Gmail messages and triage them.
 *
 * Runs experiments/email-triage/fetch.py (read-only IMAP) to dump the N most
 * recent messages to inbox.json, then asks pi to classify + summarize them.
 *
 * Credentials come from the pi process environment (same as the script):
 *   GMAIL_USER, GMAIL_APP_PASSWORD
 * Launch pi with those exported, or use a .env loader (separate step).
 *
 * Usage: /inbox [N]   (N = messages to fetch, default 15)
 *
 * ponytail: creds via process.env only. Upgrade path = .env loader + OAuth.
 */
import { execFile } from "node:child_process";
import { writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const TRIAGE_DIR = join(homedir(), ".pi", "experiments", "email-triage");
const SCRIPT = join(TRIAGE_DIR, "fetch.py");
const OUT = join(TRIAGE_DIR, "inbox.json");

const TRIAGE_PROMPT = `Read the file ${OUT} (it is JSON: an array of emails with from/subject/date/body).

Produce a concise triage in Spanish, grouping every email into these buckets:
- **URGENTE / atención** — needs action soon (deadlines, security, personal/work asks)
- **CON DEADLINE (opcional)** — time-bound but optional (offers, webinars)
- **INFORMATIVO** — receipts, notifications, social digests; read & archive
- **RUIDO / boletines** — marketing/newsletters, safe to delete

For each email: one line — sender + a 1-line summary + the suggested action.
End with a one-line verdict (how many urgent, how many deletable).`;

function run(
  cmd: string,
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { cwd: TRIAGE_DIR, env: process.env, maxBuffer: 10 * 1024 * 1024 },
      (err, stdout, stderr) => {
        resolve({
          code:
            err && typeof (err as any).code === "number"
              ? (err as any).code
              : err
                ? 1
                : 0,
          stdout: stdout?.toString() ?? "",
          stderr: stderr?.toString() ?? "",
        });
      },
    );
  });
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("inbox", {
    description: "Fetch recent Gmail messages and triage them (read-only)",
    handler: async (args, ctx) => {
      const n = parseInt((args || "").trim(), 10);
      const count = Number.isFinite(n) && n > 0 ? String(n) : "15";

      ctx.ui.notify(`Fetching ${count} emails…`, "info");
      const { code, stdout, stderr } = await run("python3", [SCRIPT, count]);

      if (code !== 0) {
        const hint = stderr.includes("GMAIL_USER")
          ? " — export GMAIL_USER and GMAIL_APP_PASSWORD before launching pi"
          : "";
        ctx.ui.notify(`Fetch failed (exit ${code})${hint}`, "error");
        return;
      }

      try {
        writeFileSync(OUT, stdout, "utf8");
      } catch (e: any) {
        ctx.ui.notify(`Could not write inbox.json: ${e.message}`, "error");
        return;
      }

      ctx.ui.notify("Fetched. Triaging…", "info");
      if (ctx.isIdle()) {
        pi.sendUserMessage(TRIAGE_PROMPT);
      } else {
        pi.sendUserMessage(TRIAGE_PROMPT, { deliverAs: "followUp" });
        ctx.ui.notify("Queued /inbox triage as a follow-up", "info");
      }
    },
  });
}
