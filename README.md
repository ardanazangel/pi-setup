# pi setup

My personal [pi](https://github.com/mariozechner/pi) coding agent configuration.

## Structure

```
~/.pi/
├── settings.json          # Root pi settings
└── agent/
    ├── SYSTEM.md          # System prompt injected on every session
    ├── settings.json      # pi settings (model, extensions, packages, theme)
    ├── package.json       # npm dependencies
    ├── mcp.json           # MCP server configs (Figma OAuth)
    ├── models.json        # Local Ollama model definitions
    ├── pi-bar.json        # Status bar segment configuration
    └── extensions/
        ├── ship.ts              # /ship — git add, scan secrets, commit, push
        ├── web-fetch.ts         # web_fetch tool — curl-based URL fetching
        ├── news.ts              # /news — Hacker News, Socket.dev, daily.dev
        ├── mail.ts              # /mail — Gmail digest & reply drafting
        ├── research.ts          # /research — deep web research workflow
        ├── questionnaire.ts     # questionnaire tool — interactive Q&A UI
        ├── tps-meter.ts         # Token/s meter in status bar
        ├── cost-meter.ts        # Session cost tracker in status bar
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
# 1. Install pi
npm install -g @mariozechner/pi-coding-agent

# 2. Clone this config
git clone https://github.com/ardanazangel/pi-setup ~/.pi

# 3. Install dependencies
cd ~/.pi/agent && npm install
```

No API keys required for basic usage. Web search works out of the box via [pi-web-access](https://pi.dev/packages/pi-web-access) (zero-config).

### Optional — web search API keys

For more search providers, create `~/.pi/web-search.json`:

```json
{
  "exaApiKey": "exa-...",
  "perplexityApiKey": "pplx-...",
  "geminiApiKey": "AIza..."
}
```

### Optional — Gmail integration

`/mail` requires OAuth credentials. Follow the setup in `extensions/mail.ts` — the token is stored at `~/.pi/MAIL/token.json` (gitignored).

### Optional — Figma MCP

`mcp.json` wires up the Figma MCP server via OAuth. Run the OAuth flow once; credentials are stored in `~/.pi/mcp-oauth/` (gitignored).

### Optional — local models

`models.json` defines Ollama models (`gpt-oss:20b`, `gemma4`, `gemma4:e4b`). Requires [Ollama](https://ollama.com) running locally.

## Extensions

| Command / Tool | File | Description |
|---|---|---|
| `/ship` | `ship.ts` | Runs `git add -A`, scans for secrets, auto-commits, pushes |
| `/news [hn\|socket\|dailydev\|all]` | `news.ts` | Curated tech news from multiple sources |
| `/mail [digest\|reply]` | `mail.ts` | Gmail inbox digest and reply drafting |
| `/research <query>` | `research.ts` | Multi-step web research with synthesis |
| `/context` | `context-viewer.ts` | Token usage breakdown as a grid |
| `web_fetch` tool | `web-fetch.ts` | Fetch raw HTML from any URL |
| `questionnaire` tool | `questionnaire.ts` | Interactive single/multi-question UI |
| status bar | `tps-meter.ts` | Real-time tokens/second display |
| status bar | `cost-meter.ts` | Running session cost in USD |

## Subagents

The `subagent` tool delegates tasks to one of three specialized agents:

| Agent | Model | Tools | Use for |
|---|---|---|---|
| `scout` | haiku | read, grep, find, ls | Fast codebase exploration |
| `researcher` | sonnet | web_search, web_fetch | Web research & synthesis |
| `worker` | sonnet | read, write, edit, safe_bash | Autonomous code changes |

Run a single agent or up to 4 in parallel:

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
