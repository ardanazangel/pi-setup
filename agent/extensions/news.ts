/**
 * news.ts — handmade news extension for pi
 * Sources: Hacker News, Socket.dev Blog, daily.dev
 * Commands: /news [hn|socket|dailydev|all] [limit]
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";

// ── constants ─────────────────────────────────────────────────────────────────

const HN_BASE = "https://hacker-news.firebaseio.com/v0";
const SOCKET_FEED = "https://socket.dev/api/blog/feed.json";
const DAILY_DEV_GRAPHQL = "https://api.daily.dev/graphql";
const AGENT_ENV = join(homedir(), ".pi", "agent", ".env");
const NEWS_DIR = join(homedir(), ".pi", "NEWS");
const SEEN_FILE = join(NEWS_DIR, "seen.json");
const NEWS_MESSAGE_TYPE = "pi-news-handmade";
const SEEN_TTL_DAYS = 14;
const DEFAULT_LIMIT = 3;

// ── seen store ────────────────────────────────────────────────────────────────

type SeenStore = Record<string, number>;

function loadSeen(): SeenStore {
  try {
    if (!existsSync(SEEN_FILE)) return {};
    return JSON.parse(readFileSync(SEEN_FILE, "utf8")) as SeenStore;
  } catch { return {}; }
}

function saveSeen(store: SeenStore): void {
  try {
    mkdirSync(NEWS_DIR, { recursive: true });
    const cutoff = Date.now() - SEEN_TTL_DAYS * 24 * 60 * 60 * 1000;
    const pruned: SeenStore = {};
    for (const [id, ts] of Object.entries(store)) {
      if (ts > cutoff) pruned[id] = ts;
    }
    writeFileSync(SEEN_FILE, JSON.stringify(pruned, null, 2), "utf8");
  } catch { /* non-fatal */ }
}

function markSeen(store: SeenStore, ids: string[]): SeenStore {
  const now = Date.now();
  const updated = { ...store };
  for (const id of ids) updated[id] = now;
  return updated;
}

// ── env reader ────────────────────────────────────────────────────────────────

function readEnv(key: string): string | undefined {
  if (process.env[key]) return process.env[key];
  if (!existsSync(AGENT_ENV)) return undefined;
  for (const line of readFileSync(AGENT_ENV, "utf8").split(/\r?\n/)) {
    const m = line.match(new RegExp(`^(?:export\\s+)?${key}\\s*=\\s*(.+)$`));
    if (m) {
      let v = m[1].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      return v;
    }
  }
  return undefined;
}

// ── types ─────────────────────────────────────────────────────────────────────

type SourceKey = "hn" | "socket" | "dailydev";

type Entry = {
  id: string;
  source: SourceKey;
  title: string;
  url: string;
  sourceUrl?: string;
  author?: string;
  score?: number;
  comments?: number;
  publishedAt?: string;
  summary?: string;
};

// ── fetch helpers ─────────────────────────────────────────────────────────────

async function fetchJson<T>(url: string, opts?: RequestInit, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, {
    signal, ...opts,
    headers: { "user-agent": "pi-news/1.0", ...(opts?.headers ?? {}) },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return res.json() as Promise<T>;
}

// ── Hacker News ───────────────────────────────────────────────────────────────

async function fetchHN(limit: number, signal?: AbortSignal): Promise<Entry[]> {
  const ids = await fetchJson<number[]>(`${HN_BASE}/beststories.json`, {}, signal);
  const items = await Promise.all(
    ids.slice(0, limit).map((id) =>
      fetchJson<{ id: number; title?: string; url?: string; by?: string; score?: number; descendants?: number; time?: number }>(
        `${HN_BASE}/item/${id}.json`, {}, signal,
      ).catch(() => null),
    ),
  );
  return items
    .filter((x): x is NonNullable<typeof x> => !!x?.title)
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    .map((item) => ({
      id: `hn:${item.id}`,
      source: "hn" as const,
      title: item.title!,
      url: item.url ?? `https://news.ycombinator.com/item?id=${item.id}`,
      sourceUrl: `https://news.ycombinator.com/item?id=${item.id}`,
      author: item.by,
      score: item.score,
      comments: item.descendants,
      publishedAt: item.time ? new Date(item.time * 1000).toISOString() : undefined,
    }));
}

// ── Socket.dev ────────────────────────────────────────────────────────────────

async function fetchSocket(limit: number, signal?: AbortSignal): Promise<Entry[]> {
  const feed = await fetchJson<{
    items?: Array<{ id?: string; url?: string; title?: string; summary?: string; date_published?: string; author?: { name?: string } }>;
  }>(SOCKET_FEED, {}, signal);
  return (feed.items ?? []).slice(0, limit).map((item) => ({
    id: `socket:${item.url ?? item.id ?? item.title}`,
    source: "socket" as const,
    title: item.title ?? "Untitled",
    url: item.url ?? "https://socket.dev/blog",
    author: item.author?.name,
    publishedAt: item.date_published,
    summary: item.summary?.slice(0, 200),
  }));
}

// ── daily.dev ─────────────────────────────────────────────────────────────────

async function fetchDailyDev(limit: number, signal?: AbortSignal): Promise<Entry[]> {
  const cookie = readEnv("DAILY_DEV_COOKIE");
  const auth = readEnv("DAILY_DEV_AUTHORIZATION");
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (cookie) headers["cookie"] = cookie;
  if (auth) headers["authorization"] = auth.startsWith("Bearer ") ? auth : `Bearer ${auth}`;

  const query = `
    query HandmadeNewsFeed($first: Int!, $supportedTypes: [String!]) {
      mostUpvotedFeed(first: $first, period: 7, supportedTypes: $supportedTypes) {
        edges { node {
          id title url summary publishedAt createdAt numUpvotes numComments
          author { name username } source { name } commentsPermalink
        }}
      }
    }
  `;
  const res = await fetchJson<{
    data?: { mostUpvotedFeed?: { edges?: Array<{ node?: { id?: string; title?: string; url?: string; summary?: string; publishedAt?: string; createdAt?: string; numUpvotes?: number; numComments?: number; author?: { name?: string; username?: string }; source?: { name?: string }; commentsPermalink?: string } }> } };
    errors?: Array<{ message?: string }>;
  }>(DAILY_DEV_GRAPHQL, {
    method: "POST", headers,
    body: JSON.stringify({ query, variables: { first: limit, period: 30, supportedTypes: ["article", "share", "freeform", "tweet", "video:youtube"] } }),
  }, signal);

  if (res.errors?.length) throw new Error(`daily.dev: ${res.errors.map((e) => e.message).join("; ")}`);
  return (res.data?.mostUpvotedFeed?.edges ?? [])
    .map((e) => e.node)
    .filter((n): n is NonNullable<typeof n> => !!n?.title)
    .map((n) => ({
      id: `dailydev:${n.id}`,
      source: "dailydev" as const,
      title: n.title!,
      url: n.url ?? n.commentsPermalink ?? `https://app.daily.dev/posts/${n.id}`,
      sourceUrl: n.commentsPermalink,
      author: n.author?.name ?? n.author?.username ?? n.source?.name,
      score: n.numUpvotes,
      comments: n.numComments,
      publishedAt: n.publishedAt ?? n.createdAt,
      summary: n.summary?.slice(0, 200),
    }))
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
}

// ── dispatch ──────────────────────────────────────────────────────────────────

async function fetchSource(source: SourceKey, limit: number, signal?: AbortSignal): Promise<Entry[]> {
  if (source === "hn") return fetchHN(limit, signal);
  if (source === "socket") return fetchSocket(limit, signal);
  return fetchDailyDev(limit, signal);
}

async function fetchAll(limit: number, sources: SourceKey[], signal?: AbortSignal): Promise<{ entries: Entry[]; sourceErrors: string[] }> {
  const results = await Promise.allSettled(sources.map((s) => fetchSource(s, limit, signal)));
  const entries: Entry[] = [];
  const sourceErrors: string[] = [];
  results.forEach((r, i) => {
    if (r.status === "fulfilled") {
      entries.push(...r.value);
    } else {
      const msg = r.reason instanceof Error ? r.reason.message : String(r.reason);
      sourceErrors.push(`${sources[i]} (${msg})`);
    }
  });
  return { entries, sourceErrors };
}

// ── dedup ─────────────────────────────────────────────────────────────────────

function applyDedup(all: Entry[], seen: SeenStore, limitPerSource: number): { fresh: Entry[]; skipped: number } {
  const bySource = new Map<SourceKey, Entry[]>();
  let skipped = 0;
  for (const e of all) {
    if (seen[e.id]) { skipped++; continue; }
    if (!bySource.has(e.source)) bySource.set(e.source, []);
    const bucket = bySource.get(e.source)!;
    if (bucket.length < limitPerSource) bucket.push(e);
    else skipped++;
  }
  return { fresh: [...bySource.values()].flat(), skipped };
}

// ── formatting ────────────────────────────────────────────────────────────────

function fmtDate(iso: string | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleString("en-GB", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZoneName: "short" });
}

const SOURCE_LABELS: Record<SourceKey, string> = {
  hn: "🟧 Hacker News",
  socket: "🛡️ Socket.dev Blog",
  dailydev: "🟦 daily.dev",
};

function formatEntries(entries: Entry[], skipped: number): string {
  const bySource = new Map<SourceKey, Entry[]>();
  for (const e of entries) {
    if (!bySource.has(e.source)) bySource.set(e.source, []);
    bySource.get(e.source)!.push(e);
  }

  const sections: string[] = [];
  for (const [src, items] of bySource) {
    const label = SOURCE_LABELS[src];
    const headerText = `${label} (${items.length})`;
    const rule = "═".repeat(Math.max(24, headerText.length + 2));
    const padding = Math.max(0, rule.length - headerText.length - 1);
    const header = `╔${rule}╗\n║ ${headerText}${" ".repeat(padding)}║\n╚${rule}╝`;
    const lines = items.map((item, i) => {
      const badges = [
        item.score !== undefined ? `▲ ${item.score}` : undefined,
        item.comments !== undefined ? `💬 ${item.comments}` : undefined,
        item.author ? `👤 ${item.author}` : undefined,
        fmtDate(item.publishedAt) ? `🕒 ${fmtDate(item.publishedAt)}` : undefined,
      ].filter(Boolean).join("  ");
      return [
        `  ${i + 1}. ${item.title}`,
        badges ? `     ${badges}` : undefined,
        `     🔗 ${item.url}`,
        item.sourceUrl && item.sourceUrl !== item.url ? `     🧭 ${item.sourceUrl}` : undefined,
        item.summary ? `     📝 ${item.summary}` : undefined,
      ].filter((x) => x !== undefined).join("\n");
    });
    sections.push([header, ...lines].join("\n\n"));
  }

  const total = entries.length;
  const skippedNote = skipped > 0 ? ` · ${skipped} already seen` : "";
  return `🗞️  News Feed — ${total} new stories across ${bySource.size} sources${skippedNote}\n\n${sections.join("\n\n")}`;
}

// ── parse args ────────────────────────────────────────────────────────────────

const ALL_SOURCES: SourceKey[] = ["hn", "socket", "dailydev"];

const SOURCE_ALIASES: Record<string, SourceKey> = {
  hn: "hn", hackernews: "hn", "hacker-news": "hn",
  socket: "socket", "socket.dev": "socket",
  dailydev: "dailydev", daily: "dailydev", "daily.dev": "dailydev",
};

function parseArgs(args: string): { sources: SourceKey[]; limit: number } {
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  const sources: SourceKey[] = [];
  let limit = DEFAULT_LIMIT;

  for (const t of tokens) {
    if (/^\d+$/.test(t)) limit = Math.min(50, Math.max(1, Number(t)));
    else if (t === "all") sources.push(...ALL_SOURCES);
    else if (SOURCE_ALIASES[t]) sources.push(SOURCE_ALIASES[t]);
  }

  return { sources: sources.length > 0 ? [...new Set(sources)] : ALL_SOURCES, limit };
}

// ── extension ─────────────────────────────────────────────────────────────────

export default function newsExtension(pi: ExtensionAPI) {
  pi.registerCommand("news", {
    description: "Fetch dev news: /news [hn|socket|dailydev|all] [limit]",
    handler: async (args: string, ctx: any) => {
      const { sources, limit } = parseArgs(args);
      ctx.ui.notify("Fetching news…", "info");
      try {
        const seen = loadSeen();
        const { entries: all, sourceErrors } = await fetchAll(limit * 4, sources);
        const { fresh, skipped } = applyDedup(all, seen, limit);
        const entries = fresh.length > 0 ? fresh : all.slice(0, limit * sources.length);
        let content = formatEntries(entries, fresh.length > 0 ? skipped : 0);
        if (sourceErrors.length > 0) {
          content += `\n\n⚠️ Sources unavailable: ${sourceErrors.join(", ")}`;
        }
        pi.sendMessage({ customType: NEWS_MESSAGE_TYPE, content, display: true });
        saveSeen(markSeen(seen, all.map((e) => e.id)));
      } catch (err) {
        ctx.ui.notify(`News fetch failed: ${err instanceof Error ? err.message : String(err)}`, "error");
      }
    },
  });

  pi.registerCommand("news-reset", {
    description: "Clear news seen history",
    handler: async (_args: string, ctx: any) => {
      try {
        writeFileSync(SEEN_FILE, "{}", "utf8");
        ctx.ui.notify("News history cleared.", "success");
      } catch (err) {
        ctx.ui.notify(`Failed: ${err instanceof Error ? err.message : String(err)}`, "error");
      }
    },
  });
}
