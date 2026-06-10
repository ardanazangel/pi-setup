/**
 * web-access.ts — Web search and URL fetching via Gemini API + Chrome headless.
 *
 * Tools:
 *   web_search    — Search the web using Gemini with Google Search grounding.
 *   fetch_content — Fetch a URL and return readable text.
 *                   Tier 1: Node fetch (simple/static pages).
 *                   Tier 2: Playwright networkidle (JS-heavy SPAs).
 *                   Tier 3: Gemini (YouTube, PDF, prompt questions, last resort).
 *   crawl_site   — Crawl a site recursively and return content of N pages.
 *                   Discovers URLs via sitemap.xml, falls back to link traversal.
 *
 * Config: ~/.pi/web-search.json + ~/.pi/.env
 *   .env keys: GEMINI_API_KEY, EXA_API_KEY, PERPLEXITY_API_KEY
 *   {
 *     "politeness": {
 *       "respectRobotsTxt": true,
 *       "perHostConcurrency": 1,
 *       "minDelayMs": 1000,
 *       "maxRetries": 2,
 *       "backoffMs": 1000,
 *       "userAgent": "pi-web-access/1.0 (+https://github.com/earendil-works/pi)",
 *       "cacheTtlMs": 300000
 *     }
 *   }
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const PLAYWRIGHT_PATH = "/Users/angelardanaztirapu/.pi/agent/npm/node_modules/playwright-core";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const CONFIG_PATH = join(homedir(), ".pi", "web-search.json");
const ENV_PATH = join(homedir(), ".pi", ".env");
const SEARCH_MODEL = "gemini-2.5-flash";
const FETCH_MODEL = "gemini-2.5-flash";
const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

type WebAccessConfig = {
  geminiApiKey?: string;
  exaApiKey?: string;
  perplexityApiKey?: string;
  politeness?: Partial<PolitenessConfig>;
};

type PolitenessConfig = {
  respectRobotsTxt: boolean;
  perHostConcurrency: number;
  minDelayMs: number;
  maxRetries: number;
  backoffMs: number;
  userAgent: string;
  cacheTtlMs: number;
};

const DEFAULT_POLITENESS: PolitenessConfig = {
  respectRobotsTxt: true,
  perHostConcurrency: 1,
  minDelayMs: 1000,
  maxRetries: 2,
  backoffMs: 1000,
  userAgent: "pi-web-access/1.0 (+https://github.com/earendil-works/pi)",
  cacheTtlMs: 5 * 60 * 1000,
};

function loadConfig(): WebAccessConfig {
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
  } catch {
    return {};
  }
}

function loadDotEnv(): Record<string, string> {
  try {
    const env: Record<string, string> = {};
    for (const line of readFileSync(ENV_PATH, "utf-8").split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (!match) continue;
      let value = match[2].trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
      env[match[1]] = value;
    }
    return env;
  } catch {
    return {};
  }
}

function loadApiKey(): string {
  const cfg = loadConfig();
  const env = loadDotEnv();
  return env.GEMINI_API_KEY ?? cfg.geminiApiKey ?? "";
}

function loadPolitenessConfig(): PolitenessConfig {
  const cfg = loadConfig().politeness ?? {};
  return { ...DEFAULT_POLITENESS, ...cfg };
}

// ---------------------------------------------------------------------------
// Gemini API helpers
// ---------------------------------------------------------------------------

async function geminiGenerate(model: string, apiKey: string, body: object): Promise<any> {
  const res = await fetch(`${GEMINI_BASE}/${model}:generateContent?key=${apiKey}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Gemini ${res.status}: ${errText.slice(0, 200)}`);
  }
  return res.json();
}

function extractText(data: any): string {
  return data?.candidates?.[0]?.content?.parts
    ?.filter((p: any) => p.text)
    ?.map((p: any) => p.text)
    ?.join("") ?? "";
}

function extractGroundingLinks(data: any): { title: string; url: string }[] {
  const chunks = data?.candidates?.[0]?.groundingMetadata?.groundingChunks ?? [];
  return chunks
    .filter((c: any) => c.web?.uri)
    .map((c: any) => ({ title: c.web.title ?? c.web.uri, url: c.web.uri }));
}

// ---------------------------------------------------------------------------
// HTML → readable text
// ---------------------------------------------------------------------------

function htmlToText(html: string): string {
  let text = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<svg[\s\S]*?<\/svg>/gi, "")
    .replace(/<nav[\s\S]*?<\/nav>/gi, "")
    .replace(/<header[\s\S]*?<\/header>/gi, "")
    .replace(/<footer[\s\S]*?<\/footer>/gi, "");

  text = text.replace(/<\/(p|div|li|h[1-6]|tr|blockquote)>/gi, "\n");
  text = text.replace(/<br\s*\/?>/gi, "\n");
  text = text.replace(/<[^>]+>/g, "");

  text = text
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ")
    .replace(/&#x27;/g, "'").replace(/&#x2F;/g, "/");

  return text.split("\n").map(l => l.trim()).filter(l => l.length > 0).join("\n");
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + `\n\n... (truncated at ${maxChars} chars)`;
}

// ---------------------------------------------------------------------------
// Chrome headless
// ---------------------------------------------------------------------------

const CHROME_PATHS = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
];

function findChrome(): string | null {
  return CHROME_PATHS.find(p => existsSync(p)) ?? null;
}

type Action =
  | { type: "click"; selector: string }
  | { type: "scroll"; direction?: "down" | "up"; amount?: number }
  | { type: "wait"; selector: string; timeout?: number }
  | { type: "fill"; selector: string; value: string };

async function playwrightFetch(url: string, actions?: Action[], screenshot?: boolean): Promise<{ text: string | null; screenshot?: string; blocked?: string }> {
  const polite = await beforeRequest(url);
  if (!polite.allowed) return { text: null, blocked: polite.reason };

  const chrome = findChrome();
  if (!chrome || !existsSync(PLAYWRIGHT_PATH)) return { text: null };
  let browser: any;
  try {
    const { chromium } = require(PLAYWRIGHT_PATH);
    browser = await chromium.launch({ executablePath: chrome, headless: true });
    const page = await browser.newPage({ userAgent: FETCH_HEADERS["User-Agent"] });
    const response = await page.goto(url, { waitUntil: "networkidle", timeout: 15000 });
    const blocked = detectBlock(response?.status() ?? 0, await page.content().catch(() => ""));
    if (blocked) return { text: null, blocked };
    for (const action of actions ?? []) {
      if (action.type === "click") {
        await page.click(action.selector, { timeout: 5000 }).catch(() => {});
        await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
      } else if (action.type === "scroll") {
        const amount = action.amount ?? 800;
        const dir = action.direction === "up" ? -amount : amount;
        await page.evaluate((y: number) => window.scrollBy(0, y), dir);
        await page.waitForTimeout(500);
      } else if (action.type === "wait") {
        await page.waitForSelector(action.selector, { timeout: action.timeout ?? 5000 }).catch(() => {});
      } else if (action.type === "fill") {
        await page.fill(action.selector, action.value, { timeout: 5000 }).catch(() => {});
      }
    }

    const text: string = await page.evaluate(() => (document as any).body.innerText);
    const result: { text: string | null; screenshot?: string } = { text: text.trim() || null };

    if (screenshot) {
      const buf: Buffer = await page.screenshot({ type: "png", fullPage: false });
      result.screenshot = buf.toString("base64");
    }

    return result;
  } catch (e: any) {
    return { text: null, blocked: detectBlock(0, String(e?.message ?? e)) ?? undefined };
  } finally {
    await browser?.close();
  }
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {

  // ─── web_search ───────────────────────────────────────────────────────────

  pi.registerTool({
    name: "web_search",
    label: "Web Search",
    description: "Search the web using Gemini with Google Search grounding. Returns a synthesized answer with source citations.",
    parameters: Type.Object({
      query: Type.String({ description: "Search query" }),
      recency: Type.Optional(Type.String({ description: "Recency filter: day, week, month, year" })),
    }) as any,

    async execute(_id, params) {
      const apiKey = loadApiKey();
      if (!apiKey) return err("No Gemini API key configured in ~/.pi/web-search.json");

      const query = params.query.trim();
      if (!query) return err("Query is required");

      const recencyNote = params.recency ? ` (results from the last ${params.recency})` : "";
      const prompt = `Search the web and answer this query with grounded, up-to-date information${recencyNote}: ${query}`;

      const data = await geminiGenerate(SEARCH_MODEL, apiKey, {
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        tools: [{ google_search: {} }],
      });

      const text = extractText(data);
      const links = extractGroundingLinks(data);

      let output = text.trim();
      if (links.length > 0) {
        output += "\n\n**Sources:**\n" + links.map(l => `- [${l.title}](${l.url})`).join("\n");
      }

      return ok(output || "No results returned.");
    },
  });

  // ─── fetch_content ────────────────────────────────────────────────────────

  pi.registerTool({
    name: "fetch_content",
    label: "Fetch Content",
    description: "Fetch a URL and return its readable content as text. Automatically handles JS-heavy SPAs via Playwright (networkidle). For YouTube, uses Gemini.",
    parameters: Type.Object({
      url: Type.String({ description: "URL to fetch" }),
      prompt: Type.Optional(Type.String({ description: "Question to answer from the page content" })),
      useGemini: Type.Optional(Type.Boolean({ description: "Force Gemini extraction (default: auto)" })),
      screenshot: Type.Optional(Type.Boolean({ description: "Capture a screenshot of the page and return it as base64 PNG" })),
      actions: Type.Optional(Type.Array(Type.Object({
        type: Type.String({ description: "Action type: click | scroll | wait | fill" }),
        selector: Type.Optional(Type.String({ description: "CSS selector (for click, wait, fill)" })),
        direction: Type.Optional(Type.String({ description: "scroll direction: down | up" })),
        amount: Type.Optional(Type.Number({ description: "scroll pixels (default 800)" })),
        timeout: Type.Optional(Type.Number({ description: "wait timeout ms (default 5000)" })),
        value: Type.Optional(Type.String({ description: "fill value" })),
      }), { description: "Playwright actions to run before extracting (click, scroll, wait, fill)" })),
    }) as any,

    async execute(_id, params) {
      const apiKey = loadApiKey();
      const url = params.url.trim();
      if (!url) return err("URL is required");

      // YouTube: always Gemini
      if (/youtube\.com|youtu\.be/.test(url)) {
        if (!apiKey) return err("Gemini API key required for YouTube content");
        const question = params.prompt ?? "Summarize this video. Include the main topics, key points, and any important details.";
        const data = await geminiGenerate(FETCH_MODEL, apiKey, {
          contents: [{
            role: "user",
            parts: [
              { text: question },
              { file_data: { file_uri: url, mime_type: "video/*" } },
            ],
          }],
        }).catch(async () =>
          geminiGenerate(FETCH_MODEL, apiKey, {
            contents: [{ role: "user", parts: [{ text: `${question}\n\nYouTube URL: ${url}` }] }],
            tools: [{ google_search: {} }],
          })
        );
        return ok(extractText(data) || "Could not extract YouTube content.");
      }

      // PDF: pass directly to Gemini
      const isPdf = /\.pdf(\?.*)?$/i.test(url) || params.prompt?.toLowerCase().includes("pdf");
      if (isPdf) {
        if (!apiKey) return err("Gemini API key required for PDF extraction");
        const question = params.prompt ?? "Extract and summarize the full content of this PDF. Include all important sections, data, and details.";
        // Try passing URL directly first; Gemini can fetch public PDFs
        const data = await geminiGenerate(FETCH_MODEL, apiKey, {
          contents: [{
            role: "user",
            parts: [
              { text: question },
              { file_data: { file_uri: url, mime_type: "application/pdf" } },
            ],
          }],
        }).catch(async () => {
          // Fallback: fetch PDF bytes and send as inline base64
          const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
          const buffer = await res.arrayBuffer();
          const base64 = Buffer.from(buffer).toString("base64");
          return geminiGenerate(FETCH_MODEL, apiKey, {
            contents: [{
              role: "user",
              parts: [
                { text: question },
                { inline_data: { mime_type: "application/pdf", data: base64 } },
              ],
            }],
          });
        });
        return ok(extractText(data) || "Could not extract PDF content.");
      }

      // Tier 1: plain fetch
      let plainText = "";
      let html = "";
      let blockedReason: string | null = null;
      try {
        const fetched = await politeFetchText(url, { timeoutMs: 15000 });
        html = fetched.text;
        plainText = htmlToText(html);
        blockedReason = fetched.blockedReason ?? null;
      } catch (e: any) {
        if (e instanceof PoliteFetchError && e.blocked) {
          blockedReason = e.message;
        }
      }

      // Tier 2: Playwright — JS-heavy pages, actions requested, or screenshot
      const isJsHeavy = plainText.length < 500 && html.length > 5000;
      const hasActions = params.actions && params.actions.length > 0;
      let screenshotB64: string | undefined;
      if ((isJsHeavy || hasActions || params.screenshot) && !params.useGemini) {
        const pw = await playwrightFetch(url, params.actions as Action[], params.screenshot);
        if (pw.blocked) blockedReason = pw.blocked;
        if (pw.text && pw.text.length > plainText.length) plainText = pw.text;
        if (pw.screenshot) screenshotB64 = pw.screenshot;
      }

      if (blockedReason) return err(`Blocked or disallowed while fetching ${url}: ${blockedReason}`);
      const truncated = truncate(plainText, 20000);

      // Tier 3: Gemini — forced, still empty, or prompt question
      const stillEmpty = plainText.length < 300;
      if (params.useGemini || stillEmpty) {
        if (!apiKey) return ok(truncated || "No readable content found.");
        const question = params.prompt ?? `Extract the main content from this page in a readable format. URL: ${url}`;
        const data = await geminiGenerate(FETCH_MODEL, apiKey, {
          contents: [{ role: "user", parts: [{ text: `${question}\n\nPage content:\n${truncated}` }] }],
        });
        return ok(extractText(data) || truncated);
      }

      if (params.prompt && apiKey) {
        const data = await geminiGenerate(FETCH_MODEL, apiKey, {
          contents: [{ role: "user", parts: [{ text: `${params.prompt}\n\nPage content from ${url}:\n${truncated}` }] }],
        });
        return ok(extractText(data) || truncated);
      }

      if (screenshotB64) {
        return {
          content: [
            { type: "text" as const, text: truncated || "(no text extracted)" },
            { type: "image" as const, source: { type: "base64" as const, media_type: "image/png" as const, data: screenshotB64 } },
          ],
          details: {},
        };
      }
      return ok(truncated || "No readable content found.");
    },
  });

  // ─── crawl_site ──────────────────────────────────────────────────────────

  pi.registerTool({
    name: "crawl_site",
    label: "Crawl Site",
    description: "Crawl a website and return the text content of multiple pages. Discovers URLs via sitemap.xml first, then link traversal. Useful for indexing docs or researching an entire site.",
    parameters: Type.Object({
      url: Type.String({ description: "Root URL to crawl" }),
      maxPages: Type.Optional(Type.Number({ description: "Max pages to fetch (default 10, max 50)" })),
      includePaths: Type.Optional(Type.String({ description: "Only include URLs matching this regex pattern (e.g. '/docs/')" })),
      excludePaths: Type.Optional(Type.String({ description: "Exclude URLs matching this regex pattern (e.g. '/blog/')" })),
      query: Type.Optional(Type.String({ description: "If provided, only return pages whose content is relevant to this query" })),
    }) as any,

    async execute(_id, params) {
      const url = params.url.trim().replace(/\/$/, "");
      if (!url) return err("URL is required");

      const maxPages = Math.min(params.maxPages ?? 10, 50);
      const includeRe = params.includePaths ? new RegExp(params.includePaths) : null;
      const excludeRe = params.excludePaths ? new RegExp(params.excludePaths) : null;

      let origin: string;
      try { origin = new URL(url).origin; } catch { return err(`Invalid URL: ${url}`); }

      // 1. Discover URLs
      const discovered = await discoverUrls(url, origin, maxPages, includeRe, excludeRe);

      // 2. Fetch each page with polite per-host rate limiting
      const results: { url: string; content: string }[] = [];
      const queue = [...discovered];
      const CONCURRENCY = loadPolitenessConfig().perHostConcurrency;

      while (queue.length > 0 && results.length < maxPages) {
        const batch = queue.splice(0, CONCURRENCY);
        const fetched = await Promise.all(batch.map(async (pageUrl) => {
          const content = await fetchPageText(pageUrl);
          return content ? { url: pageUrl, content: truncate(content, 3000) } : null;
        }));
        for (const r of fetched) {
          if (r && results.length < maxPages) results.push(r);
        }
      }

      if (!results.length) return err(`No pages found at ${url}`);

      // 3. Filter by query relevance if requested
      let pages = results;
      if (params.query) {
        const terms = params.query.toLowerCase().split(/\s+/).filter(Boolean);
        pages = results
          .map(r => ({ r, score: terms.filter(t => r.content.toLowerCase().includes(t)).length }))
          .filter(x => x.score > 0)
          .sort((a, b) => b.score - a.score)
          .map(x => x.r);
        if (!pages.length) pages = results; // fallback: return all if none match
      }

      const output = pages.map(r => `## ${r.url}\n${r.content}`).join("\n\n---\n\n");
      return ok(`Crawled ${pages.length} pages from ${url}:\n\n${output}`);
    },
  });
}

// ---------------------------------------------------------------------------
// Crawl helpers
// ---------------------------------------------------------------------------

function fetchHeaders(): Record<string, string> {
  return {
    "User-Agent": loadPolitenessConfig().userAgent,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.5",
  };
}

const FETCH_HEADERS = fetchHeaders();

type CachedText = { text: string; expiresAt: number };
type HostState = { lastRequestAt: number; chain: Promise<void>; blockedUntil?: number; blockedReason?: string };

const pageCache = new Map<string, CachedText>();
const robotsCache = new Map<string, { disallow: string[]; expiresAt: number }>();
const hostStates = new Map<string, HostState>();

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function jitter(ms: number): number {
  return Math.floor(ms * (0.75 + Math.random() * 0.5));
}

function hostState(hostname: string): HostState {
  let state = hostStates.get(hostname);
  if (!state) {
    state = { lastRequestAt: 0, chain: Promise.resolve() };
    hostStates.set(hostname, state);
  }
  return state;
}

function detectBlock(status: number, body: string): string | null {
  const lower = body.slice(0, 5000).toLowerCase();
  if (status === 429) return "rate limited (HTTP 429)";
  if (status === 403) return "forbidden (HTTP 403)";
  if (status >= 500 && lower.includes("cloudflare")) return `Cloudflare interstitial (HTTP ${status})`;
  if (/captcha|recaptcha|hcaptcha|cf-challenge|checking your browser|access denied|unusual traffic/.test(lower)) {
    return "bot protection or captcha detected";
  }
  return null;
}

async function beforeRequest(url: string, opts: { skipRobots?: boolean } = {}): Promise<{ allowed: boolean; reason?: string }> {
  const cfg = loadPolitenessConfig();
  const parsed = new URL(url);
  const state = hostState(parsed.hostname);

  if (state.blockedUntil && Date.now() < state.blockedUntil) {
    return { allowed: false, reason: state.blockedReason ?? "host temporarily blocked" };
  }

  if (!opts.skipRobots && cfg.respectRobotsTxt) {
    const robots = await getRobots(parsed.origin);
    if (robots && isDisallowed(parsed.pathname, robots.disallow)) {
      return { allowed: false, reason: "disallowed by robots.txt" };
    }
  }

  const previous = state.chain;
  let release!: () => void;
  state.chain = new Promise(resolve => { release = resolve; });
  await previous;

  const elapsed = Date.now() - state.lastRequestAt;
  if (elapsed < cfg.minDelayMs) await sleep(jitter(cfg.minDelayMs - elapsed));
  state.lastRequestAt = Date.now();
  release();
  return { allowed: true };
}

async function getRobots(origin: string): Promise<{ disallow: string[] } | null> {
  const cfg = loadPolitenessConfig();
  const cached = robotsCache.get(origin);
  if (cached && cached.expiresAt > Date.now()) return cached;

  try {
    const res = await fetch(`${origin}/robots.txt`, { headers: fetchHeaders(), signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    const text = await res.text();
    const disallow = parseRobots(text);
    const value = { disallow, expiresAt: Date.now() + cfg.cacheTtlMs };
    robotsCache.set(origin, value);
    return value;
  } catch {
    return null;
  }
}

function parseRobots(text: string): string[] {
  const disallow: string[] = [];
  let applies = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.split("#")[0].trim();
    if (!line) continue;
    const [keyRaw, ...valueParts] = line.split(":");
    const key = keyRaw?.trim().toLowerCase();
    const value = valueParts.join(":").trim();
    if (key === "user-agent") applies = value === "*" || value.toLowerCase().includes("pi-web-access");
    if (applies && key === "disallow" && value) disallow.push(value);
  }
  return disallow;
}

function isDisallowed(pathname: string, disallow: string[]): boolean {
  return disallow.some(rule => rule !== "/" ? pathname.startsWith(rule) : true);
}

class PoliteFetchError extends Error {
  constructor(message: string, readonly status?: number, readonly blocked = false) {
    super(message);
    this.name = "PoliteFetchError";
  }
}

async function politeFetchText(url: string, opts: { timeoutMs: number; skipRobots?: boolean }): Promise<{ text: string; blockedReason?: string }> {
  const cfg = loadPolitenessConfig();
  const cached = pageCache.get(url);
  if (cached && cached.expiresAt > Date.now()) return { text: cached.text };

  const allowed = await beforeRequest(url, opts);
  if (!allowed.allowed) throw new PoliteFetchError(allowed.reason ?? "request not allowed", undefined, true);

  let lastError: any;
  for (let attempt = 0; attempt <= cfg.maxRetries; attempt++) {
    try {
      const res = await fetch(url, { headers: fetchHeaders(), signal: AbortSignal.timeout(opts.timeoutMs) });
      const text = await res.text();
      const blockedReason = detectBlock(res.status, text);
      if (blockedReason) {
        const state = hostState(new URL(url).hostname);
        state.blockedUntil = Date.now() + 10 * 60 * 1000;
        state.blockedReason = blockedReason;
        return { text, blockedReason };
      }
      if (!res.ok) throw new PoliteFetchError(`HTTP ${res.status}`, res.status, res.status === 403 || res.status === 429);
      pageCache.set(url, { text, expiresAt: Date.now() + cfg.cacheTtlMs });
      return { text };
    } catch (e) {
      lastError = e;
      if (attempt < cfg.maxRetries) await sleep(jitter(cfg.backoffMs * Math.pow(2, attempt)));
    }
  }
  throw lastError;
}

async function discoverUrls(
  rootUrl: string,
  origin: string,
  maxPages: number,
  includeRe: RegExp | null,
  excludeRe: RegExp | null,
): Promise<string[]> {
  const urls = new Set<string>();

  // Try sitemap.xml first
  const sitemapUrls = await fetchSitemap(origin);
  for (const u of sitemapUrls) {
    if (filterUrl(u, origin, includeRe, excludeRe)) urls.add(u);
    if (urls.size >= maxPages * 3) break; // collect more than needed for filtering
  }

  // If sitemap gave enough, done
  if (urls.size >= maxPages) return [...urls].slice(0, maxPages);

  // Fallback: extract links from root page
  try {
    const fetched = await politeFetchText(rootUrl, { timeoutMs: 10000 });
    const html = fetched.text;
    const linkRe = /href=["']([^"'#?][^"']*)["']/gi;
    let m: RegExpExecArray | null;
    while ((m = linkRe.exec(html)) !== null) {
      try {
        const resolved = new URL(m[1], rootUrl).href.split("?")[0].split("#")[0];
        if (filterUrl(resolved, origin, includeRe, excludeRe)) urls.add(resolved);
      } catch {}
    }
  } catch {}

  // Always include the root
  urls.add(rootUrl);
  return [...urls].slice(0, maxPages);
}

async function fetchSitemap(origin: string): Promise<string[]> {
  const candidates = [`${origin}/sitemap.xml`, `${origin}/sitemap_index.xml`];
  for (const sitemapUrl of candidates) {
    try {
      const fetched = await politeFetchText(sitemapUrl, { timeoutMs: 8000, skipRobots: true });
      const xml = fetched.text;
      const urls: string[] = [];
      const locRe = /<loc>([^<]+)<\/loc>/gi;
      let m: RegExpExecArray | null;
      while ((m = locRe.exec(xml)) !== null) {
        const u = m[1].trim();
        // If it's a sitemap index, recurse one level
        if (u.endsWith(".xml")) {
          const sub = await fetchSitemap(new URL(u).origin + new URL(u).pathname.replace(/\/[^/]*$/, ""));
          urls.push(...sub);
        } else {
          urls.push(u);
        }
      }
      if (urls.length > 0) return urls;
    } catch {}
  }
  return [];
}

function filterUrl(u: string, origin: string, includeRe: RegExp | null, excludeRe: RegExp | null): boolean {
  if (!u.startsWith(origin)) return false;
  if (includeRe && !includeRe.test(u)) return false;
  if (excludeRe && excludeRe.test(u)) return false;
  // Skip assets
  if (/\.(css|js|png|jpg|jpeg|gif|svg|ico|woff|woff2|ttf|eot|pdf|zip)$/i.test(u)) return false;
  return true;
}

async function fetchPageText(url: string): Promise<string | null> {
  try {
    const fetched = await politeFetchText(url, { timeoutMs: 10000 });
    const html = fetched.text;
    const text = htmlToText(html);
    if (text.length >= 200) return text;
    // JS-heavy: try Playwright
    if (html.length > 3000) {
      const pw = await playwrightFetch(url);
      return pw.text;
    }
    return text || null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ok(text: string) {
  return { content: [{ type: "text" as const, text }], details: {} };
}

function err(text: string) {
  return { content: [{ type: "text" as const, text: `Error: ${text}` }], details: {} };
}
