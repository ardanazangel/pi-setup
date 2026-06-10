/**
 * memory.ts — Markdown-backed persistent memory for pi.
 *
 * Stores facts and lessons as human-readable .md files in ~/.pi/memory/.
 * Consolidation runs in a detached background process (no shutdown blocking).
 * Uses claude-haiku for faster extraction.
 *
 * Files:
 *   ~/.pi/memory/facts.md    — key-value preferences and project patterns
 *   ~/.pi/memory/lessons.md  — learned corrections and validated approaches
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { spawn, execSync } from "node:child_process";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const MEMORY_DIR = join(homedir(), ".pi", "memory");
const FACTS_FILE = join(MEMORY_DIR, "facts.md");
const LESSONS_FILE = join(MEMORY_DIR, "lessons.md");
const WORKER_SCRIPT = join(MEMORY_DIR, "consolidate-worker.mjs");
const CONSOLIDATION_MODEL = "claude-haiku-4-20250514";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Fact {
  key: string;
  value: string;
  confidence: number;
  source: string;
  updated: string;
}

interface Lesson {
  id: string;
  rule: string;
  category: string;
  negative: boolean;
  created: string;
}

// ---------------------------------------------------------------------------
// MD parse / serialize
// ---------------------------------------------------------------------------

function readFileSafe(path: string): string {
  try { return readFileSync(path, "utf-8"); } catch { return ""; }
}

function parseFacts(content: string): Fact[] {
  const facts: Fact[] = [];
  const blocks = ("\n" + content).split(/\n## /);
  for (const block of blocks.slice(1)) {
    const lines = block.split("\n");
    const key = lines[0]?.trim();
    if (!key || key === "Memory Facts") continue;
    let metaIdx = -1;
    for (let i = lines.length - 1; i >= 1; i--) {
      if (lines[i].startsWith("<!-- ")) { metaIdx = i; break; }
    }
    const metaLine = metaIdx >= 0 ? lines[metaIdx] : "";
    const value = lines.slice(1, metaIdx >= 0 ? metaIdx : lines.length).join("\n").trim();
    if (!key || !value) continue;
    facts.push({
      key, value,
      confidence: parseFloat(metaLine.match(/confidence:([\d.]+)/)?.[1] ?? "0.8"),
      source: metaLine.match(/source:(\S+)/)?.[1] ?? "consolidation",
      updated: metaLine.match(/updated:([^\s>]+)/)?.[1] ?? new Date().toISOString(),
    });
  }
  return facts;
}

function serializeFacts(facts: Fact[]): string {
  if (!facts.length) return "# Memory Facts\n";
  return "# Memory Facts\n\n" + facts.map(f =>
    `## ${f.key}\n${f.value}\n<!-- confidence:${f.confidence} source:${f.source} updated:${f.updated} -->`
  ).join("\n\n") + "\n";
}

function parseLessons(content: string): Lesson[] {
  const lessons: Lesson[] = [];
  const blocks = ("\n" + content).split(/\n## /);
  for (const block of blocks.slice(1)) {
    const lines = block.split("\n");
    const header = lines[0]?.trim();
    if (!header || header === "Memory Lessons") continue;
    const id = header.match(/id:([a-f0-9]+)/)?.[1] ?? uid();
    const category = header.match(/category:(\S+)/)?.[1] ?? "general";
    const negative = header.includes("negative:true");
    let metaIdx = -1;
    for (let i = lines.length - 1; i >= 1; i--) {
      if (lines[i].startsWith("<!-- ")) { metaIdx = i; break; }
    }
    const rule = lines.slice(1, metaIdx >= 0 ? metaIdx : lines.length).join("\n").trim();
    const created = lines[metaIdx]?.match(/created:([^\s>]+)/)?.[1] ?? new Date().toISOString();
    if (rule) lessons.push({ id, rule, category, negative, created });
  }
  return lessons;
}

function serializeLessons(lessons: Lesson[]): string {
  if (!lessons.length) return "# Memory Lessons\n";
  return "# Memory Lessons\n\n" + lessons.map(l =>
    `## id:${l.id} category:${l.category} negative:${l.negative}\n${l.rule}\n<!-- created:${l.created} -->`
  ).join("\n\n") + "\n";
}

// ---------------------------------------------------------------------------
// MarkdownMemoryStore
// ---------------------------------------------------------------------------

class MarkdownMemoryStore {
  constructor(
    readonly factsFile: string,
    readonly lessonsFile: string,
  ) {}

  readFacts(): Fact[] { return parseFacts(readFileSafe(this.factsFile)); }
  writeFacts(facts: Fact[]): void { writeFileSync(this.factsFile, serializeFacts(facts)); }

  readLessons(): Lesson[] { return parseLessons(readFileSafe(this.lessonsFile)); }
  writeLessons(lessons: Lesson[]): void { writeFileSync(this.lessonsFile, serializeLessons(lessons)); }

  setFact(key: string, value: string, confidence = 0.8, source = "consolidation"): void {
    const facts = this.readFacts();
    const k = key.toLowerCase();
    const idx = facts.findIndex(f => f.key === k);
    const entry: Fact = { key: k, value, confidence, source, updated: new Date().toISOString() };
    if (idx >= 0) facts[idx] = entry; else facts.push(entry);
    this.writeFacts(facts);
  }

  deleteFact(key: string): boolean {
    const facts = this.readFacts();
    const idx = facts.findIndex(f => f.key === key.toLowerCase());
    if (idx < 0) return false;
    facts.splice(idx, 1);
    this.writeFacts(facts);
    return true;
  }

  searchFacts(query: string, limit = 10): Fact[] {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) return this.readFacts().slice(0, limit);
    return this.readFacts()
      .map(f => ({ f, score: terms.filter(t => `${f.key} ${f.value}`.toLowerCase().includes(t)).length / terms.length }))
      .filter(x => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(x => x.f);
  }

  addLesson(rule: string, category = "general", negative = false): { success: boolean; id?: string; reason?: string } {
    const trimmed = rule.trim();
    if (!trimmed) return { success: false, reason: "empty rule" };
    const lessons = this.readLessons();
    const cat = (category.trim().toLowerCase()) || "general";
    if (lessons.some(l => l.rule.toLowerCase() === trimmed.toLowerCase()))
      return { success: false, reason: "duplicate" };
    if (lessons.some(l => jaccard(trimmed, l.rule) >= 0.7))
      return { success: false, reason: "similar" };
    const id = uid().slice(0, 16);
    lessons.push({ id, rule: trimmed, category: cat, negative, created: new Date().toISOString() });
    this.writeLessons(lessons);
    return { success: true, id };
  }

  deleteLesson(id: string): boolean {
    const lessons = this.readLessons();
    const idx = lessons.findIndex(l => l.id === id || l.id.startsWith(id));
    if (idx < 0) return false;
    lessons.splice(idx, 1);
    this.writeLessons(lessons);
    return true;
  }

  listLessons(category?: string, limit = 50): Lesson[] {
    let l = this.readLessons();
    if (category) l = l.filter(x => x.category === category.toLowerCase());
    return l.slice(0, limit);
  }

  searchLessons(query: string, limit = 20): Lesson[] {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) return this.readLessons().slice(0, limit);
    return this.readLessons()
      .map(l => ({ l, score: terms.filter(t => `${l.rule} ${l.category}`.toLowerCase().includes(t)).length / terms.length }))
      .filter(x => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(x => x.l);
  }

  stats() {
    return { facts: this.readFacts().length, lessons: this.readLessons().length };
  }
}

// ---------------------------------------------------------------------------
// Context block builder
// ---------------------------------------------------------------------------

const MAX_CONTEXT_CHARS = 8000;
const STALE_WARN_DAYS = 30;
const VERY_STALE_DAYS = 90;

function daysSince(iso: string): number {
  try { return Math.floor((Date.now() - new Date(iso).getTime()) / 86400000); } catch { return 0; }
}

function staleTag(updated: string): string {
  const d = daysSince(updated);
  if (d >= VERY_STALE_DAYS) return ` ⚠️ ${d}d old — verify before acting`;
  if (d >= STALE_WARN_DAYS) return ` (${d}d ago)`;
  return "";
}

function buildContext(store: MarkdownMemoryStore): string {
  const facts = store.readFacts();
  const lessons = store.readLessons();
  const sections: string[] = [];

  const PREFIX_TITLES: Record<string, string> = {
    pref: "User Preferences",
    project: "Project Context",
    tool: "Tool Preferences",
  };

  const groups: Record<string, Fact[]> = {};
  for (const f of facts) {
    const prefix = f.key.split(".")[0] ?? "other";
    (groups[prefix] ??= []).push(f);
  }

  for (const [prefix, group] of Object.entries(groups)) {
    const title = PREFIX_TITLES[prefix] ?? "Other";
    const lines = group.map(f => {
      const shortKey = f.key.includes(".") ? f.key.slice(f.key.indexOf(".") + 1) : f.key;
      return `- ${shortKey}: ${f.value}${staleTag(f.updated)}`;
    });
    sections.push(`## ${title}\n${lines.join("\n")}`);
  }

  const corrections = lessons.filter(l => l.negative);
  const positives = lessons.filter(l => !l.negative);
  if (corrections.length) {
    sections.push(`## Learned Corrections\n${corrections.map(l =>
      `- DON'T: ${l.rule}${l.category !== "general" ? ` [${l.category}]` : ""}`
    ).join("\n")}`);
  }
  if (positives.length) {
    sections.push(`## Validated Approaches\n${positives.map(l =>
      `- ${l.rule}${l.category !== "general" ? ` [${l.category}]` : ""}`
    ).join("\n")}`);
  }

  if (!sections.length) return "";

  const caveat = `## Before acting on memory
- Memory records can become stale. If a memory names a file, function, or flag — verify it still exists before recommending it. "The memory says X exists" is not the same as "X exists now."
- If a recalled memory conflicts with what you observe in the current code or project state, trust what you observe now.
- Memories about project state (deadlines, decisions, architecture) decay fastest — check if still relevant.`;

  let text = `<memory>\n${sections.join("\n\n")}\n\n${caveat}\n</memory>`;
  if (text.length > MAX_CONTEXT_CHARS) text = text.slice(0, MAX_CONTEXT_CHARS - 30) + "\n... (truncated)\n</memory>";
  return text;
}

// ---------------------------------------------------------------------------
// Consolidation prompt builder
// ---------------------------------------------------------------------------

const CONSOLIDATION_SYSTEM = `You are a memory extraction system. Analyze this conversation and extract structured knowledge.

Extract ONLY concrete, reusable facts. Focus on:
1. User preferences (key prefix: pref.) — coding style, tool preferences, workflow habits
2. Project patterns (key prefix: project.<name>.) — languages, frameworks, architecture decisions
3. Tool preferences (key prefix: tool.) — which tools to prefer/avoid
4. Corrections/lessons — things the user corrected, mistakes to avoid (negative: true)
5. Validated approaches — things the user confirmed worked well (negative: false)

Do NOT extract: file paths, git history, debugging fixes, ephemeral task details, activity summaries, anything in CLAUDE.md/AGENTS.md.

Rules:
- Only extract if confidence >= 0.8
- Key format: lowercase, dots as separators, no spaces, max 100 chars
- Values: concise, under 200 chars

Respond with ONLY valid JSON:
{
  "semantic": [{ "key": "string", "value": "string", "confidence": number }],
  "lessons": [{ "rule": "string", "category": "string", "negative": boolean }]
}

If nothing worth extracting: { "semantic": [], "lessons": [] }`;

function buildConsolidationPrompt(
  userMessages: string[],
  assistantMessages: string[],
  cwd: string,
  facts: Fact[],
  lessons: Lesson[],
): string {
  const memParts: string[] = [];
  if (facts.length) {
    memParts.push("Existing facts (avoid duplicating):");
    let chars = 0;
    for (const f of facts) {
      const line = `- ${f.key}: ${f.value.length > 120 ? f.value.slice(0, 120) + "…" : f.value}`;
      if (chars + line.length > 1500) { memParts.push("- ... (truncated)"); break; }
      memParts.push(line); chars += line.length;
    }
  }
  if (lessons.length) {
    memParts.push("\nExisting lessons (avoid duplicating):");
    let chars = 0;
    for (const l of lessons) {
      const line = `- [${l.category}] ${l.rule.length > 120 ? l.rule.slice(0, 120) + "…" : l.rule}`;
      if (chars + line.length > 500) { memParts.push("- ... (truncated)"); break; }
      memParts.push(line); chars += line.length;
    }
  }

  const msgs: string[] = [];
  const len = Math.min(userMessages.length, 30);
  for (let i = 0; i < len; i++) {
    const u = userMessages[i];
    if (u) msgs.push(`User: ${u.length > 1000 ? u.slice(0, 1000) + "…" : u}`);
    const a = assistantMessages[i];
    if (a) msgs.push(`Assistant: ${a.length > 500 ? a.slice(0, 500) + "…" : a}`);
  }

  const memSection = memParts.length ? `## Current Memory State\n${memParts.join("\n")}\n\n` : "";
  return `${CONSOLIDATION_SYSTEM}\n\n${memSection}${cwd ? `Working directory: ${cwd}\n\n` : ""}## Conversation\n\n${msgs.join("\n\n")}`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ok(text: string) {
  return { content: [{ type: "text" as const, text }], details: {} };
}

function stripQuotes<T>(v: T): T {
  if (typeof v !== "string") return v;
  const s = v.trim();
  if (s.length >= 2) {
    const first = s[0], last = s[s.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      try { if (first === '"') return JSON.parse(s) as unknown as T; } catch {}
      return s.slice(1, -1) as unknown as T;
    }
  }
  return v;
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content))
    return content.filter((c: any) => c.type === "text" && typeof c.text === "string").map((c: any) => c.text).join("\n");
  return "";
}

function uid(): string {
  return Math.random().toString(16).slice(2, 10) + Math.random().toString(16).slice(2, 10);
}

function jaccard(a: string, b: string): number {
  const setA = new Set(a.toLowerCase().split(/\s+/).filter(Boolean));
  const setB = new Set(b.toLowerCase().split(/\s+/).filter(Boolean));
  if (!setA.size && !setB.size) return 1;
  const intersection = [...setA].filter(x => setB.has(x)).length;
  return intersection / new Set([...setA, ...setB]).size;
}

function findPiBin(): string {
  try { return execSync("which pi", { encoding: "utf8" }).trim(); } catch { return "pi"; }
}

// ---------------------------------------------------------------------------
// Migration from SQLite
// ---------------------------------------------------------------------------

async function migrateFromSqlite(store: MarkdownMemoryStore): Promise<void> {
  const oldDb = join(homedir(), ".pi", "memory", "memory.db");
  if (!existsSync(oldDb)) return;
  try {
    const { DatabaseSync } = await import("node:sqlite") as any;
    const db = new DatabaseSync(oldDb);
    const rawFacts = db.prepare("SELECT * FROM semantic").all() as any[];
    const rawLessons = db.prepare("SELECT * FROM lessons WHERE is_deleted = 0").all() as any[];
    db.close();

    const facts: Fact[] = rawFacts.map((f: any) => ({
      key: f.key,
      value: f.value,
      confidence: f.confidence ?? 0.8,
      source: f.source ?? "consolidation",
      updated: f.updated_at ?? new Date().toISOString(),
    }));
    const lessons: Lesson[] = rawLessons.map((l: any) => ({
      id: (l.id as string)?.slice(0, 16) ?? uid().slice(0, 16),
      rule: l.rule,
      category: l.category ?? "general",
      negative: !!l.negative,
      created: l.created_at ?? new Date().toISOString(),
    }));

    store.writeFacts(facts);
    store.writeLessons(lessons);
    console.error(`pi-memory: migrated ${facts.length} facts, ${lessons.length} lessons from SQLite → markdown`);
  } catch (e: any) {
    console.error("pi-memory: SQLite migration failed:", e?.message ?? e);
  }
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  let store: MarkdownMemoryStore | null = null;
  let sessionCwd = "";
  let sessionId: string | undefined;
  let cachedCtx: any = null;
  let pendingUserMessages: string[] = [];
  let pendingAssistantMessages: string[] = [];

  function fireConsolidation(): void {
    if (!store) return;
    const prompt = buildConsolidationPrompt(
      pendingUserMessages,
      pendingAssistantMessages,
      sessionCwd,
      store.readFacts(),
      store.readLessons(),
    );
    const jobFile = join(MEMORY_DIR, `consolidate-${Date.now()}.json`);
    writeFileSync(jobFile, JSON.stringify({
      prompt,
      factsFile: store.factsFile,
      lessonsFile: store.lessonsFile,
      model: CONSOLIDATION_MODEL,
      piBin: findPiBin(),
    }));
    const child = spawn(process.execPath, [WORKER_SCRIPT, jobFile], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
  }

  pi.on("session_start", async (_event, ctx) => {
    try {
      sessionCwd = ctx.cwd;
      cachedCtx = ctx;
      sessionId = (ctx as any).sessionId ?? (ctx as any).session?.id;

      mkdirSync(MEMORY_DIR, { recursive: true });
      store = new MarkdownMemoryStore(FACTS_FILE, LESSONS_FILE);

      // First-run migration from SQLite
      if (!existsSync(FACTS_FILE) && !existsSync(LESSONS_FILE)) {
        await migrateFromSqlite(store);
      }

      // Seed pending messages from existing session history
      pendingUserMessages = [];
      pendingAssistantMessages = [];
      try {
        const branch = ctx.sessionManager.getBranch();
        for (const entry of branch) {
          if ((entry as any).type !== "message") continue;
          const msg = (entry as any).message;
          if (!msg) continue;
          if (msg.role === "user") {
            const t = extractText(msg.content);
            if (t) pendingUserMessages.push(t);
          } else if (msg.role === "assistant") {
            const t = extractText(msg.content);
            if (t) pendingAssistantMessages.push(t);
          }
        }
      } catch {}

      // Inject memory context as one-shot message at session start
      try {
        const alreadyInjected = ctx.sessionManager.getEntries()
          .some((e: any) => e.type === "custom_message" && e.customType === "pi-memory-context");
        if (!alreadyInjected) {
          const text = buildContext(store);
          if (text) {
            pi.sendMessage({ customType: "pi-memory-context", content: text, display: false, details: store.stats() });
          }
        }
      } catch {}

      const s = store.stats();
      if (s.facts + s.lessons > 0) {
        ctx.ui.setStatus("pi-memory", `Memory: ${s.facts} facts, ${s.lessons} lessons`);
        setTimeout(() => { try { ctx.ui.setStatus("pi-memory", ""); } catch {} }, 5000);
      }
    } catch (err: any) {
      ctx.ui.notify(`pi-memory: init failed: ${err.message}`, "warning");
    }
  });

  pi.on("agent_end", async (event) => {
    for (const msg of event.messages) {
      if (msg.role === "user" && "content" in msg) {
        const t = extractText(msg.content);
        if (t) { pendingUserMessages.push(t); if (pendingUserMessages.length > 60) pendingUserMessages.shift(); }
      } else if (msg.role === "assistant" && "content" in msg) {
        const t = extractText(msg.content);
        if (t) { pendingAssistantMessages.push(t); if (pendingAssistantMessages.length > 60) pendingAssistantMessages.shift(); }
      }
    }
  });

  pi.on("session_before_switch", async (_event, ctx) => {
    if (!store || pendingUserMessages.length < 3) return;
    try {
      fireConsolidation();
      ctx.ui.notify("Memory consolidation queued in background", "info");
    } catch {}
    pendingUserMessages = [];
    pendingAssistantMessages = [];
  });

  pi.on("session_shutdown", async () => {
    if (!store) return;
    if (pendingUserMessages.length >= 3) {
      try { fireConsolidation(); } catch {}
    }
    store = null;
  });

  // ─── Tools ───────────────────────────────────────────────────────────────

  pi.registerTool({
    name: "memory_search",
    label: "Memory Search",
    description: "Search persistent memory for facts, preferences, and project patterns the user has established across sessions.",
    parameters: Type.Object({
      query: Type.String({ description: "Search query" }),
      limit: Type.Optional(Type.Number({ description: "Max results (default 10)" })),
    }) as any,
    async execute(_id, params) {
      if (!store) return ok("Memory store not initialized");
      const facts = store.searchFacts(params.query, params.limit ?? 10);
      const lessons = store.searchLessons(params.query, 5);
      if (!facts.length && !lessons.length) return ok("No matching memories found.");
      const lines: string[] = [];
      for (const f of facts) lines.push(`${f.key}: ${f.value} (confidence: ${f.confidence}, source: ${f.source})`);
      for (const l of lessons) lines.push(`[lesson/${l.category}] ${l.negative ? "DON'T: " : ""}${l.rule} (id: ${l.id.slice(0, 8)})`);
      return ok(lines.join("\n"));
    },
  });

  pi.registerTool({
    name: "memory_remember",
    label: "Memory Remember",
    description: "Store a fact, preference, or lesson in persistent memory. Use dotted keys like pref.editor, project.rosie.lang, tool.sed.usage. For corrections, use type='lesson'.",
    parameters: Type.Object({
      type: Type.String({ description: "'fact' for key-value, 'lesson' for a correction" }),
      key: Type.Optional(Type.String({ description: "Dotted key for facts (e.g. pref.commit_style)" })),
      value: Type.Optional(Type.String({ description: "Value for facts" })),
      rule: Type.Optional(Type.String({ description: "Rule text for lessons" })),
      category: Type.Optional(Type.String({ description: "Category for lessons (default: general)" })),
      negative: Type.Optional(Type.Boolean({ description: "True if this is something to AVOID" })),
    }) as any,
    async execute(_id, params) {
      if (!store) return ok("Memory store not initialized");
      const type = stripQuotes(params.type);
      if (type === "fact") {
        const key = stripQuotes(params.key);
        const value = stripQuotes(params.value);
        if (!key || !value) return ok("Both key and value required for facts");
        store.setFact(key, value, 0.95, "user");
        return ok(`Remembered: ${key} = ${value}`);
      }
      if (type === "lesson") {
        const rule = stripQuotes(params.rule);
        if (!rule) return ok("Rule text required for lessons");
        const result = store.addLesson(rule, params.category ?? "general", params.negative ?? false);
        return result.success ? ok(`Lesson learned: ${rule}`) : ok(`Already known (${result.reason}): ${rule}`);
      }
      return ok(`Invalid type: ${type}. Must be 'fact' or 'lesson'.`);
    },
  });

  pi.registerTool({
    name: "memory_forget",
    label: "Memory Forget",
    description: "Remove a fact or lesson from persistent memory.",
    parameters: Type.Object({
      type: Type.String(),
      key: Type.Optional(Type.String({ description: "Key for facts" })),
      id: Type.Optional(Type.String({ description: "ID for lessons" })),
    }) as any,
    async execute(_id, params) {
      if (!store) return ok("Memory store not initialized");
      const type = stripQuotes(params.type);
      if (type === "fact" && params.key)
        return ok(store.deleteFact(stripQuotes(params.key)) ? `Forgot: ${params.key}` : `Not found: ${params.key}`);
      if (type === "lesson" && params.id)
        return ok(store.deleteLesson(stripQuotes(params.id)) ? `Forgot lesson ${params.id}` : `Not found: ${params.id}`);
      return ok("Provide key (for facts) or id (for lessons)");
    },
  });

  pi.registerTool({
    name: "memory_lessons",
    label: "Memory Lessons",
    description: "List learned corrections and lessons from past sessions.",
    parameters: Type.Object({
      category: Type.Optional(Type.String({ description: "Filter by category" })),
      limit: Type.Optional(Type.Number({ description: "Max results (default 50)" })),
    }) as any,
    async execute(_id, params) {
      if (!store) return ok("Memory store not initialized");
      const lessons = store.listLessons(params.category, params.limit ?? 50);
      if (!lessons.length) return ok("No lessons learned yet.");
      return ok(lessons.map(l =>
        `${l.negative ? "DON'T" : "DO"} [${l.category}] ${l.rule} (id: ${l.id.slice(0, 8)})`
      ).join("\n"));
    },
  });

  pi.registerTool({
    name: "memory_stats",
    label: "Memory Stats",
    description: "Show memory statistics — how many facts, lessons, and events are stored.",
    parameters: Type.Object({}) as any,
    async execute() {
      if (!store) return ok("Memory store not initialized");
      const s = store.stats();
      return ok(`Memory: ${s.facts} facts, ${s.lessons} lessons\nFacts: ${FACTS_FILE}\nLessons: ${LESSONS_FILE}`);
    },
  });

  pi.registerCommand("memory-consolidate", {
    description: "Manually trigger memory consolidation for the current session (runs in background)",
    async handler(_args, ctx) {
      if (!store) { ctx.ui.notify("Memory store not initialized", "warning"); return; }
      if (pendingUserMessages.length < 2) {
        ctx.ui.notify("Not enough conversation to consolidate (need at least 2 user messages)", "warning");
        return;
      }
      try {
        fireConsolidation();
        ctx.ui.notify("Consolidation queued — worker running in background", "info");
      } catch (err: any) {
        ctx.ui.notify(`Consolidation failed: ${err.message}`, "error");
      }
    },
  });
}
