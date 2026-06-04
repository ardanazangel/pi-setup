# pi setup

My personal [pi](https://github.com/mariozechner/pi) coding agent configuration.

## Structure

```
~/.pi/
├── web-search.json        # Web search config (allowBrowserCookies, API keys)
└── agent/
    ├── SYSTEM.md          # System prompt injected on every session
    ├── settings.json      # pi settings (model, extensions, packages, theme)
    ├── mcp.json           # MCP server configs (Figma OAuth)
    ├── models.json        # Local Ollama model definitions
    └── extensions/
        ├── ship.ts              # /ship — git add, scan secrets, commit, push
        ├── news.ts              # /news — Hacker News, Socket.dev, daily.dev
        ├── mail.ts              # /mail — Gmail digest & reply drafting
        ├── research.ts          # /research — deep web research workflow
        ├── questionnaire.ts     # questionnaire tool — interactive Q&A UI
        ├── tps-meter.ts         # Token/s meter per turn (notify)
        ├── caffeinate.ts        # Keeps Mac awake while agent is running
        ├── context-viewer.ts    # /context — token usage grid visualization
        └── subagents/           # Subagent delegation system
            ├── index.ts         # Entry point — exposes subagent tool
            ├── agents/
            │   ├── scout.md     # Fast codebase recon (haiku)
            │   ├── researcher.md # Web research specialist (sonnet)
            │   └── worker.md    # General-purpose code worker (sonnet)
            └── tools/
                └── safe-bash.ts # Bash with dangerous-command blocking
```

## Installation

```bash
git clone https://github.com/ardanazangel/pi-setup ~/.pi
cd ~/.pi/agent && npm install
```

### Optional — web search

`pi-web-access` (included via packages) supports multiple providers. Create `~/.pi/web-search.json` to configure:

```json
{
  "allowBrowserCookies": true
}
```

With `allowBrowserCookies: true`, Gemini Web is used via Chrome cookies (no API key needed). Requires being signed into `gemini.google.com` in Chrome.

For API-based providers:

```json
{
  "exaApiKey": "exa-...",
  "perplexityApiKey": "pplx-...",
  "geminiApiKey": "AIza..."
}
```

Provider priority (auto): Exa → Perplexity → Gemini API → Gemini Web.

### Optional — Gmail integration

`/mail` requires OAuth credentials. Follow the setup in `extensions/mail.ts` — the token is stored at `~/.pi/MAIL/token.json` (gitignored).

### Optional — Figma MCP

`mcp.json` wires up the Figma MCP server via OAuth. Run the OAuth flow once; credentials are stored in `~/.pi/mcp-oauth/` (gitignored).

### Optional — local models

`models.json` defines Ollama models. Requires [Ollama](https://ollama.com) running locally.

## Extensions

| Command / Tool | File | Description |
|---|---|---|
| `/ship` | `ship.ts` | Runs `git add -A`, scans for secrets, auto-commits, pushes |
| `/news [hn\|socket\|dailydev\|all]` | `news.ts` | Curated tech news from multiple sources |
| `/mail [digest\|reply]` | `mail.ts` | Gmail inbox digest and reply drafting |
| `/research <query>` | `research.ts` | Multi-step web research with synthesis |
| `/context` | `context-viewer.ts` | Token usage breakdown as a grid |
| `questionnaire` tool | `questionnaire.ts` | Interactive single/multi-question UI |
| notify per turn | `tps-meter.ts` | Tokens/second shown after each agent turn |
| background | `caffeinate.ts` | Prevents macOS sleep during agent runs |

## Subagents

The `subagent` tool delegates tasks to one of three specialized agents:

| Agent | Model | Tools | Use for |
|---|---|---|---|
| `scout` | haiku | read, grep, find, ls | Fast codebase exploration |
| `researcher` | sonnet | web_search, web_fetch | Web research & synthesis |
| `worker` | sonnet | read, write, edit, safe_bash | Autonomous code changes |

```json
{ "agent": "scout", "task": "find all API route definitions" }

{ "tasks": [
    { "agent": "scout", "task": "..." },
    { "agent": "researcher", "task": "..." }
]}
```

## Notes

- `telegram.json`, `auth.json`, `MAIL/token.json`, `mcp-oauth/` and other secrets are gitignored
- `context-mode/`, `memory/`, `session-search/`, `sessions/` and other runtime dirs are gitignored
- System prompt (`SYSTEM.md`) is in Spanish — concise, no emojis, no AI filler phrases
