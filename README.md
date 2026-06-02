# pi setup

My personal [pi](https://github.com/mariozechner/pi) coding agent configuration.

## Structure

```
~/.pi/
└── agent/
    ├── SYSTEM.md          # System prompt injected on every session
    ├── settings.json      # pi settings (model, extensions, subagents...)
    ├── package.json       # npm dependencies
    └── extensions/
        ├── yeet.ts                  # /yeet — git add -A, auto commit, push
        ├── web-fetch.ts             # Fetch URLs
        ├── youtube-transcript.ts    # YouTube transcripts
        ├── questionnaire.ts         # Interactive questionnaires
        ├── tps-meter.ts             # Token/s meter
        ├── firecrawl-search.ts      # Web search via Firecrawl
        ├── plan-mode/               # /plan — read-only exploration mode
        └── subagent/                # Subagent delegation
```

## Installation

```bash
git clone https://github.com/ardanazangel/pi-setup ~/.pi
cd ~/.pi && pnpm install
cd ~/.pi/agent && pnpm install
cd ~/.pi/agent/npm && pnpm install && pnpm rebuild
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
- `settings.json` references extensions by absolute path (`~/.pi/agent/extensions/...`)
