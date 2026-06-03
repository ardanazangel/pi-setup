# pi setup

My personal [pi](https://github.com/mariozechner/pi) coding agent configuration.

## Structure

```
~/.pi/
├── settings.json          # Root pi settings
└── agent/
    ├── SYSTEM.md          # System prompt injected on every session
    ├── settings.json      # pi settings (model, extensions, subagents...)
    ├── package.json       # npm dependencies
    ├── npm/
    │   └── package.json   # pi plugins (context-mode, pi-bar, pi-intercom, pi-web-access...)
    └── extensions/
        ├── yeet.ts                  # /yeet — git add -A, scan for secrets, auto commit, push
        ├── web-fetch.ts             # Fetch URLs
        ├── youtube-transcript.ts    # YouTube transcripts
        ├── questionnaire.ts         # Interactive questionnaires
        ├── tps-meter.ts             # Token/s meter
        ├── context-viewer.ts        # Context mode viewer
        ├── plan-mode/               # /plan — read-only exploration mode
        └── subagents/               # Subagent delegation
```

## Installation

```bash
git clone https://github.com/ardanazangel/pi-setup ~/.pi
cd ~/.pi/agent && npm install
cd ~/.pi/agent/npm && npm install
```

No API keys required for basic usage. Web search works out of the box via [pi-web-access](https://pi.dev/packages/pi-web-access) (Exa MCP, zero-config).

### Optional — web search API keys

For more search providers, create `~/.pi/web-search.json`:

```json
{
  "exaApiKey": "exa-...",
  "perplexityApiKey": "pplx-...",
  "geminiApiKey": "AIza..."
}
```

### Skills

Custom skills live in `~/.agents/skills/`. Install them separately if needed — pi loads them on demand from that path.

## Notes

- `telegram.json`, `auth.json`, and other runtime/sensitive files are gitignored
- `context-mode/`, `memory/`, `session-search/` and other runtime dirs are gitignored
