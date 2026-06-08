/**
 * web-verticals.ts — vertical extractors para fetch_content
 *
 * Intercepta resultados de fetch_content y los reemplaza con datos
 * estructurados cuando la URL coincide con un vertical conocido.
 *
 * Verticales:
 *   - pi.dev/packages/<name>  → npm registry (metadata + README)
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ─── Helpers ────────────────────────────────────────────────────────────────

function parsePiDevPackage(url: string): string | null {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return null; }
  if (parsed.hostname !== "pi.dev") return null;
  const match = parsed.pathname.match(/^\/packages\/((?:@[^/]+\/)?[^/?#]+)/);
  return match ? match[1] : null;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(iso: string): string {
  try { return new Date(iso).toLocaleDateString("en-GB", { year: "numeric", month: "short", day: "numeric" }); }
  catch { return iso; }
}

// ─── npm registry vertical ───────────────────────────────────────────────────

async function fetchNpmVertical(packageName: string, signal?: AbortSignal): Promise<string | null> {
  const registryUrl = `https://registry.npmjs.org/${encodeURIComponent(packageName).replace(/%40/, "@")}`;

  let res: Response;
  try {
    res = await fetch(registryUrl, {
      signal,
      headers: { Accept: "application/json" },
    });
  } catch {
    return null;
  }
  if (!res.ok) return null;

  let pkg: any;
  try { pkg = await res.json(); } catch { return null; }

  const latest = pkg["dist-tags"]?.latest ?? Object.keys(pkg.versions ?? {}).at(-1);
  const latestMeta = pkg.versions?.[latest] ?? {};
  const publishedAt = pkg.time?.[latest];
  const created = pkg.time?.created;
  const modified = pkg.time?.modified;

  // versions list (last 10)
  const allVersions = Object.keys(pkg.versions ?? {}).reverse();
  const recentVersions = allVersions.slice(0, 10);

  // dependencies
  const deps = Object.keys(latestMeta.dependencies ?? {});
  const peerDeps = Object.keys(latestMeta.peerDependencies ?? {});

  const lines: string[] = [];

  lines.push(`# ${pkg.name}`);
  if (pkg.description) lines.push(`\n${pkg.description}`);
  lines.push("");

  // metadata table
  lines.push("## Package info");
  lines.push(`- **Latest version:** ${latest}`);
  if (publishedAt) lines.push(`- **Published:** ${formatDate(publishedAt)}`);
  if (created) lines.push(`- **Created:** ${formatDate(created)}`);
  if (modified) lines.push(`- **Last modified:** ${formatDate(modified)}`);
  if (latestMeta.license) lines.push(`- **License:** ${latestMeta.license}`);
  if (pkg.author) {
    const author = typeof pkg.author === "string" ? pkg.author : pkg.author.name ?? pkg.author.email ?? "";
    if (author) lines.push(`- **Author:** ${author}`);
  }
  if (latestMeta.dist?.unpackedSize) lines.push(`- **Size:** ${formatBytes(latestMeta.dist.unpackedSize)}`);
  if (pkg.keywords?.length) lines.push(`- **Keywords:** ${pkg.keywords.slice(0, 8).join(", ")}`);
  lines.push("");

  // version history
  if (recentVersions.length > 0) {
    lines.push("## Recent versions");
    for (const v of recentVersions) {
      const date = pkg.time?.[v] ? ` — ${formatDate(pkg.time[v])}` : "";
      const tag = v === latest ? " *(latest)*" : "";
      lines.push(`- \`${v}\`${tag}${date}`);
    }
    if (allVersions.length > 10) lines.push(`- … and ${allVersions.length - 10} more`);
    lines.push("");
  }

  // dependencies
  if (deps.length > 0) {
    lines.push("## Dependencies");
    lines.push(deps.map(d => `- \`${d}\``).join("\n"));
    lines.push("");
  }
  if (peerDeps.length > 0) {
    lines.push("## Peer dependencies");
    lines.push(peerDeps.map(d => `- \`${d}\``).join("\n"));
    lines.push("");
  }

  // README
  const readme = pkg.readme ?? latestMeta.readme;
  if (readme && readme !== "ERROR: No README data found!") {
    lines.push("## README");
    lines.push(readme.length > 80_000 ? readme.slice(0, 80_000) + "\n\n[README truncated]" : readme);
  }

  return lines.join("\n");
}

// ─── Extension ───────────────────────────────────────────────────────────────

export default function webVerticalsExtension(pi: ExtensionAPI) {
  pi.on("tool_result", async (event, ctx) => {
    if (event.toolName !== "fetch_content") return;

    // find the URL from tool input
    const input = event.input as { url?: string; urls?: string[] };
    const urls = input.urls ?? (input.url ? [input.url] : []);
    if (urls.length !== 1) return; // only handle single-URL calls

    const url = urls[0];

    // pi.dev/packages vertical
    const pkgName = parsePiDevPackage(url);
    if (pkgName) {
      const content = await fetchNpmVertical(pkgName, ctx.signal ?? undefined);
      if (content) {
        return {
          content: [{ type: "text" as const, text: content }],
        };
      }
    }
  });
}
