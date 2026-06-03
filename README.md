# pi setup

My personal [pi](https://github.com/mariozechner/pi) coding agent configuration.

## Structure

```
~/.pi/
├── settings.json          # Root pi settings
└── agent/
    ├── SYSTEM.md          # System prompt injected on every session
    ├── settings.json      # pi settings (model, extensions, subagents...)
    ├── package.json       # npm dependencies (firecrawl)
    ├── npm/
    │   └── package.json   # pi plugins (context-mode, pi-bar, pi-intercom...)
    └── extensions/
        ├── yeet.ts                  # /yeet — git add -A, scan for secrets, auto commit, push
        ├── web-fetch.ts             # Fetch URLs
        ├── youtube-transcript.ts    # YouTube transcripts
        ├── questionnaire.ts         # Interactive questionnaires
        ├── tps-meter.ts             # Token/s meter
        ├── firecrawl-search.ts      # Web search via Firecrawl
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

### Environment variables

Create `~/.pi/agent/.env`:

```env
FIRECRAWL_API_KEY=your_key_here
```

### Skills

Custom skills live in `~/.agents/skills/`. Install them separately if needed — pi loads them on demand from that path.

## Notes

- `telegram.json`, `auth.json`, and other runtime/sensitive files are gitignored
- `context-mode/`, `memory/`, `session-search/` and other runtime dirs are gitignored
