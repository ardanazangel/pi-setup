# web-access.ts — TODO

## Hecho
- [x] `web_search` — Gemini con Google Search grounding + fuentes
- [x] `fetch_content` tier 1 — Node fetch para páginas estáticas
- [x] `fetch_content` tier 2 — Playwright networkidle para SPAs/JS-heavy
- [x] `fetch_content` tier 3 — Gemini como último recurso
- [x] YouTube — Gemini con file_data nativo
- [x] PDF — Gemini con file_data (URL directa) + fallback base64
- [x] `crawl_site` — sitemap.xml + link traversal, concurrencia 4, filtros includePaths/excludePaths/query
- [x] Actions en `fetch_content` — click, scroll, wait, fill vía Playwright
- [x] Screenshot en `fetch_content` — PNG base64 como imagen adjunta

## Descartado
- Proxies rotativos — anti-bot serio, complejidad alta, uso marginal
- Webhooks/streaming de crawls — somos sync, no aplica
- Rate limiting / credits — somos locales
