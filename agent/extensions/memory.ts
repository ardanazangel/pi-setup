import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";

const DEFAULT_SUPERMEMORY_URL = "http://localhost:6767";
const DEFAULT_CONTAINER_TAG = "pi";
const PROJECT_CONTAINER_PREFIX = "project:";
const MAX_CAPTURE_CHARS = 12000;

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
  if (Array.isArray(content)) {
    return content
      .filter((c: any) => c.type === "text" && typeof c.text === "string")
      .map((c: any) => c.text)
      .join("\n");
  }
  return "";
}

function env(name: string): string | undefined {
  const v = process.env[name]?.trim();
  return v || undefined;
}

class SupermemoryLocal {
  readonly baseURL: string;
  readonly apiKey?: string;

  constructor() {
    this.baseURL = (env("SUPERMEMORY_URL") ?? DEFAULT_SUPERMEMORY_URL).replace(/\/$/, "");
    this.apiKey = env("SUPERMEMORY_API_KEY");
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
    return headers;
  }

  async post(path: string, body: unknown, timeoutMs?: number): Promise<any> {
    const ac = timeoutMs ? new AbortController() : undefined;
    const timer = ac ? setTimeout(() => ac.abort(), timeoutMs) : undefined;
    let res: Response;
    try {
      res = await fetch(`${this.baseURL}${path}`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(body),
        signal: ac?.signal,
      });
    } finally {
      if (timer) clearTimeout(timer);
    }
    const text = await res.text();
    let json: any = text;
    try { json = text ? JSON.parse(text) : {}; } catch {}
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${typeof json === "string" ? json : JSON.stringify(json)}`);
    return json;
  }

  async add(content: string, containerTag = DEFAULT_CONTAINER_TAG, metadata?: Record<string, unknown>) {
    return this.post("/v3/documents", { content, containerTag, metadata });
  }

  async search(q: string, containerTag = DEFAULT_CONTAINER_TAG, limit = 10, timeoutMs?: number) {
    return this.post("/v3/search", { q, containerTags: [containerTag], limit }, timeoutMs);
  }

  async profile(containerTag = DEFAULT_CONTAINER_TAG, q?: string) {
    return this.post("/v4/profile", q ? { containerTag, q } : { containerTag });
  }

  async list(containerTag = DEFAULT_CONTAINER_TAG, limit = 20, page = 1) {
    return this.post("/v3/documents/list", { containerTags: [containerTag], limit, page });
  }

  async del(path: string): Promise<any> {
    const res = await fetch(`${this.baseURL}${path}`, { method: "DELETE", headers: this.headers() });
    const text = await res.text();
    let json: any = text;
    try { json = text ? JSON.parse(text) : {}; } catch {}
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${typeof json === "string" ? json : JSON.stringify(json)}`);
    return json;
  }

  async forget(id: string) {
    return this.del(`/v3/documents/${encodeURIComponent(id)}`);
  }
}

function formatSearch(data: any): string {
  const results = data?.results ?? data?.documents ?? data?.memories ?? [];
  if (!Array.isArray(results) || !results.length) return "No matching memories found.";
  return results.map((r: any, i: number) => {
    const chunkText = Array.isArray(r.chunks)
      ? r.chunks.map((c: any) => c.content).filter(Boolean).join("\n")
      : "";
    const content = r.memory ?? r.content ?? r.chunk ?? r.document?.content ?? chunkText ?? r.title ?? JSON.stringify(r);
    const scoreValue = typeof r.score === "number" ? r.score : (typeof r.similarity === "number" ? r.similarity : undefined);
    const score = typeof scoreValue === "number" ? ` score:${scoreValue.toFixed(3)}` : "";
    return `${i + 1}.${score} ${String(content).trim()}`;
  }).join("\n\n");
}

// Compact formatter for context injection: dedup near-identical hits and cap length.
function formatSearchCompact(data: any, maxPerItem = 280): string {
  const results = data?.results ?? data?.documents ?? data?.memories ?? [];
  if (!Array.isArray(results) || !results.length) return "No matching memories found.";
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const r of results) {
    const chunkText = Array.isArray(r.chunks) ? r.chunks.map((c: any) => c.content).filter(Boolean).join("\n") : "";
    const raw = String(r.memory ?? r.content ?? r.chunk ?? r.document?.content ?? chunkText ?? r.title ?? "").trim().replace(/\s+/g, " ");
    if (!raw) continue;
    const key = raw.slice(0, 120).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const text = raw.length > maxPerItem ? raw.slice(0, maxPerItem) + "…" : raw;
    lines.push(`- ${text}`);
  }
  return lines.length ? lines.join("\n") : "No matching memories found.";
}

function formatProfile(data: any): string {
  const profile = data?.profile ?? data;
  const parts: string[] = [];
  if (Array.isArray(profile?.static) && profile.static.length) parts.push(`Static facts:\n${profile.static.map((x: any) => `- ${x}`).join("\n")}`);
  if (Array.isArray(profile?.dynamic) && profile.dynamic.length) parts.push(`Recent context:\n${profile.dynamic.map((x: any) => `- ${x}`).join("\n")}`);
  if (data?.searchResults) parts.push(`Search results:\n${formatSearch(data.searchResults)}`);
  return parts.join("\n\n") || JSON.stringify(data, null, 2);
}

function projectContainerTag(cwd?: string): string | undefined {
  const clean = (cwd ?? "").trim().replace(/\/+$/, "");
  if (!clean || clean === "/") return undefined;
  const name = clean.split("/").filter(Boolean).pop();
  if (!name) return undefined;
  const safeName = name.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "root";
  return `${PROJECT_CONTAINER_PREFIX}${safeName}`;
}

function memoryScopes(cwd?: string): string[] {
  const project = projectContainerTag(cwd);
  return project ? [DEFAULT_CONTAINER_TAG, project] : [DEFAULT_CONTAINER_TAG];
}

export default function (pi: ExtensionAPI) {
  const sm = new SupermemoryLocal();
  let sessionCwd = "";
  let pendingUserMessages: string[] = [];
  let pendingAssistantMessages: string[] = [];

  async function injectContext(ctx: any) {
    try {
      const alreadyInjected = ctx.sessionManager.getEntries()
        .some((e: any) => e.type === "custom_message" && e.customType === "pi-supermemory-context");
      if (alreadyInjected) return;

      const scopes = memoryScopes(ctx.cwd ?? sessionCwd);
      const results = await Promise.all(scopes.map(async (scope) => {
        const query = scope === DEFAULT_CONTAINER_TAG
          ? "user preferences tool preferences learned corrections validated approaches"
          : `project context decisions architecture docs current repo ${ctx.cwd ?? sessionCwd}`;
        try {
          const data = await sm.search(query, scope, scope === DEFAULT_CONTAINER_TAG ? 5 : 6, 2000);
          const text = formatSearchCompact(data);
          if (text && text !== "No matching memories found.") return `scope: ${scope}\n${text}`;
        } catch {}
        return "";
      }));
      const texts = results.filter(Boolean);
      if (texts.length) {
        pi.sendMessage({
          customType: "pi-supermemory-context",
          content: `<memory>\n${texts.join("\n\n")}\n</memory>`,
          display: false,
          details: { provider: "supermemory-local", url: sm.baseURL, scopes },
        });
      }
    } catch {}
  }

  async function captureConversation(reason = "manual") {
    const pairs: string[] = [];
    const len = Math.min(pendingUserMessages.length, pendingAssistantMessages.length);
    for (let i = 0; i < len; i++) {
      pairs.push(`User: ${pendingUserMessages[i]}\nAssistant: ${pendingAssistantMessages[i]}`);
    }
    const content = pairs.join("\n\n").slice(-MAX_CAPTURE_CHARS).trim();
    if (!content) return;
    const capturedAt = new Date().toISOString();
    const scopes = memoryScopes(sessionCwd);
    for (const containerTag of scopes) {
      await sm.add(content, containerTag, {
        source: "pi-session",
        reason,
        cwd: sessionCwd,
        projectContainerTag: projectContainerTag(sessionCwd),
        capturedAt,
      });
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    sessionCwd = ctx.cwd;
    pendingUserMessages = [];
    pendingAssistantMessages = [];

    try {
      const branch = ctx.sessionManager.getBranch();
      for (const entry of branch) {
        if ((entry as any).type !== "message") continue;
        const msg = (entry as any).message;
        if (!msg) continue;
        const t = extractText(msg.content);
        if (!t) continue;
        if (msg.role === "user") pendingUserMessages.push(t);
        if (msg.role === "assistant") pendingAssistantMessages.push(t);
      }
    } catch {}

    await injectContext(ctx);
    try {
      ctx.ui.setStatus("pi-memory", `Supermemory: ${sm.baseURL}`);
      setTimeout(() => { try { ctx.ui.setStatus("pi-memory", ""); } catch {} }, 5000);
    } catch {}
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
    try {
      await captureConversation();
      ctx.ui.notify("Supermemory local: session captured", "info");
    } catch (err: any) {
      ctx.ui.notify(`Supermemory local: capture failed: ${err.message}`, "warning");
    }
    pendingUserMessages = [];
    pendingAssistantMessages = [];
  });

  pi.on("session_shutdown", async () => {
    try { await captureConversation(); } catch {}
  });

  function resolveScopes(scope?: string): string[] {
    const requested = scope ?? DEFAULT_CONTAINER_TAG;
    if (requested === "project") return [projectContainerTag(sessionCwd) ?? DEFAULT_CONTAINER_TAG];
    if (requested === "all") return memoryScopes(sessionCwd);
    return [requested];
  }

  function formatList(data: any): string {
    const results = data?.memories ?? data?.documents ?? data?.results ?? [];
    if (!Array.isArray(results) || !results.length) return "No memories found.";
    return results.map((r: any) => {
      const text = String(r.summary ?? r.title ?? r.content ?? r.memory ?? "").trim().replace(/\s+/g, " ").slice(0, 160);
      return `- [${r.id}] ${text || "(no preview)"}`;
    }).join("\n");
  }

  pi.registerTool({
    name: "memory",
    label: "Supermemory",
    description: "Persistent memory (Supermemory Local). One tool, several modes:\n- search: find facts/preferences/project context by query\n- remember: store a fact, lesson, or memory\n- forget: delete by memoryId, or by query (deletes closest match)\n- list: browse recent memories with their ids (run before forget-by-id)\n- profile: accumulated static facts + recent context\n- stats: connection details\nScope: 'pi' (global, default), 'project' (current dir), 'all' (both), or an explicit container tag.",
    parameters: Type.Object({
      mode: Type.String({ description: "search | remember | forget | list | profile | stats" }),
      query: Type.Optional(Type.String({ description: "search/forget/profile query" })),
      content: Type.Optional(Type.String({ description: "remember: free-form content (type=memory)" })),
      type: Type.Optional(Type.String({ description: "remember: 'fact', 'lesson', or 'memory' (default memory)" })),
      key: Type.Optional(Type.String({ description: "remember fact: dotted key, e.g. pref.editor" })),
      value: Type.Optional(Type.String({ description: "remember fact: value" })),
      rule: Type.Optional(Type.String({ description: "remember lesson: rule text" })),
      category: Type.Optional(Type.String({ description: "remember lesson: category" })),
      negative: Type.Optional(Type.Boolean({ description: "remember lesson: true if something to avoid" })),
      memoryId: Type.Optional(Type.String({ description: "forget: id of memory to delete" })),
      limit: Type.Optional(Type.Number({ description: "search/list: max results" })),
      scope: Type.Optional(Type.String({ description: "pi | project | all | <container tag> (default pi)" })),
    }) as any,
    async execute(_id, params) {
      const mode = stripQuotes(params.mode ?? "") as string;
      try {
        switch (mode) {
          case "search": {
            if (!params.query) return ok("query required for search");
            const texts: string[] = [];
            for (const scope of resolveScopes(params.scope)) {
              const data = await sm.search(params.query, scope, params.limit ?? 10);
              texts.push(`scope: ${scope}\n${formatSearch(data)}`);
            }
            return ok(texts.join("\n\n"));
          }
          case "remember": {
            const type = stripQuotes(params.type ?? "memory");
            const containerTag = resolveScopes(params.scope)[0] ?? DEFAULT_CONTAINER_TAG;
            let content = "";
            if (type === "fact") {
              const key = stripQuotes(params.key);
              const value = stripQuotes(params.value);
              if (!key || !value) return ok("key and value required for facts");
              content = `${key}: ${value}`;
            } else if (type === "lesson") {
              const rule = stripQuotes(params.rule);
              if (!rule) return ok("rule required for lessons");
              content = `${params.negative ? "DON'T" : "DO"}${params.category ? ` [${params.category}]` : ""}: ${rule}`;
            } else {
              content = stripQuotes(params.content ?? params.value ?? params.rule ?? "") as string;
              if (!content) return ok("content required");
            }
            await sm.add(content, containerTag, { source: "pi-tool", type, cwd: sessionCwd, projectContainerTag: projectContainerTag(sessionCwd), savedAt: new Date().toISOString() });
            return ok(`Remembered (${containerTag}): ${content}`);
          }
          case "forget": {
            if (params.memoryId) {
              await sm.forget(stripQuotes(params.memoryId) as string);
              return ok(`Forgot memory ${params.memoryId}`);
            }
            if (params.query) {
              const scope = resolveScopes(params.scope)[0] ?? DEFAULT_CONTAINER_TAG;
              const data = await sm.search(params.query, scope, 1);
              const results = data?.results ?? data?.documents ?? data?.memories ?? [];
              const target = Array.isArray(results) ? results[0] : undefined;
              if (!target?.id) return ok("No matching memory found to forget.");
              await sm.forget(target.id);
              const preview = String(target.memory ?? target.content ?? target.title ?? "").slice(0, 100);
              return ok(`Forgot: "${preview}"`);
            }
            return ok("Provide memoryId or query to forget.");
          }
          case "list": {
            const texts: string[] = [];
            for (const scope of resolveScopes(params.scope)) {
              const data = await sm.list(scope, params.limit ?? 20);
              texts.push(`scope: ${scope}\n${formatList(data)}`);
            }
            return ok(texts.join("\n\n"));
          }
          case "profile": {
            const data = await sm.profile(resolveScopes(params.scope)[0] ?? DEFAULT_CONTAINER_TAG, params.query);
            return ok(formatProfile(data));
          }
          case "stats":
            return ok(`Supermemory Local\nURL: ${sm.baseURL}\nGlobal container: ${DEFAULT_CONTAINER_TAG}\nProject container: ${projectContainerTag(sessionCwd) ?? "none"}\nAPI key: ${sm.apiKey ? "set" : "not set; localhost unauth expected"}`);
          default:
            return ok(`Unknown mode "${mode}". Use: search | remember | forget | list | profile | stats`);
        }
      } catch (err: any) {
        return ok(`Supermemory ${mode} failed: ${err.message}`);
      }
    },
  });

  pi.registerCommand("memory-consolidate", {
    description: "Save the current session into Supermemory Local",
    async handler(_args, ctx) {
      try {
        await captureConversation("manual-command");
        ctx.ui.notify("Supermemory local: session captured", "info");
      } catch (err: any) {
        ctx.ui.notify(`Supermemory local: capture failed: ${err.message}`, "error");
      }
    },
  });
}
