import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { mkdir, appendFile, readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const LOG_RELATIVE_PATH = ".pi/deltalog/log.jsonl";
const EXCLUDED_PATHS = [":(exclude).pi/deltalog/**"];

type PendingRun = {
  prompt: string;
  cwd: string;
  startedAt: string;
};

async function git(cwd: string, args: string[]): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      timeout: 15_000,
      maxBuffer: 20 * 1024 * 1024,
    });
    return stdout;
  } catch {
    return undefined;
  }
}

async function gitRoot(cwd: string): Promise<string | undefined> {
  const root = await git(cwd, ["rev-parse", "--show-toplevel"]);
  return root?.trim() || undefined;
}

async function ensureIgnored(root: string): Promise<void> {
  const gitDir = (await git(root, ["rev-parse", "--git-dir"]))?.trim();
  if (!gitDir) return;

  const excludePath = path.isAbsolute(gitDir)
    ? path.join(gitDir, "info", "exclude")
    : path.join(root, gitDir, "info", "exclude");
  const ignoreLine = ".pi/deltalog/";

  let current = "";
  try {
    current = await readFile(excludePath, "utf8");
  } catch {
    // ignore missing/unreadable exclude; appendFile will create it when possible
  }

  if (!current.split("\n").includes(ignoreLine)) {
    await mkdir(path.dirname(excludePath), { recursive: true });
    await appendFile(
      excludePath,
      `${current.endsWith("\n") || current.length === 0 ? "" : "\n"}${ignoreLine}\n`,
      "utf8",
    );
  }
}

async function trackedDiff(root: string): Promise<string> {
  return (
    (await git(root, [
      "diff",
      "--no-ext-diff",
      "--binary",
      "--",
      ".",
      ...EXCLUDED_PATHS,
    ])) ?? ""
  );
}

async function untrackedFiles(root: string): Promise<string[]> {
  const output =
    (await git(root, [
      "ls-files",
      "--others",
      "--exclude-standard",
      "--",
      ".",
      ...EXCLUDED_PATHS,
    ])) ?? "";
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

async function changedFiles(root: string): Promise<string[]> {
  const output =
    (await git(root, [
      "status",
      "--short",
      "--",
      ".",
      ...EXCLUDED_PATHS,
    ])) ?? "";
  return output
    .split("\n")
    .map((line) => line.slice(3).trim())
    .filter(Boolean);
}

async function logChanges(run: PendingRun): Promise<string | undefined> {
  const root = await gitRoot(run.cwd);
  if (!root) return undefined;
  await ensureIgnored(root);

  const [diff, untracked, files] = await Promise.all([
    trackedDiff(root),
    untrackedFiles(root),
    changedFiles(root),
  ]);

  if (!diff.trim() && untracked.length === 0) return undefined;

  const entry = {
    timestamp: new Date().toISOString(),
    startedAt: run.startedAt,
    cwd: root,
    prompt: run.prompt,
    changedFiles: files,
    diff,
    untrackedFiles: untracked,
  };

  const logPath = path.join(root, LOG_RELATIVE_PATH);
  await mkdir(path.dirname(logPath), { recursive: true });
  await appendFile(logPath, `${JSON.stringify(entry)}\n`, "utf8");
  return logPath;
}

export default function (pi: ExtensionAPI) {
  let pending: PendingRun | undefined;

  pi.on("before_agent_start", async (event, ctx) => {
    pending = {
      prompt: event.prompt,
      cwd: ctx.cwd,
      startedAt: new Date().toISOString(),
    };
  });

  pi.on("agent_end", async (_event, ctx) => {
    const run = pending;
    pending = undefined;
    if (!run) return;

    try {
      const logPath = await logChanges(run);
      if (logPath) ctx.ui.notify(`deltalog saved: ${logPath}`, "info");
    } catch {
      // Silent by design: deltalog must never break the coding flow.
    }
  });

  pi.registerCommand("deltalog", {
    description: "Show where automatic git diff logs are written",
    handler: async (_args, ctx) => {
      const root = await gitRoot(ctx.cwd);
      if (!root) {
        ctx.ui.notify("deltalog: no git repository", "warning");
        return;
      }
      ctx.ui.notify(`deltalog: ${path.join(root, LOG_RELATIVE_PATH)}`, "info");
    },
  });
}
