# pi setup

My personal [pi](https://github.com/mariozechner/pi) coding agent configuration.

## Structure

```
~/.pi/
├── web-search.json        # Web search config (allowBrowserCookies, API keys)
├── evals/                 # Eval system for SYSTEM.md and extensions
│   ├── run.js             # LLM behavior runner (uses pi CLI)
│   ├── run-extensions.js  # Extension code checker
│   └── cases/             # Test case definitions
└── agent/
    ├── SYSTEM.md          # System prompt injected on every session
    ├── settings.json      # pi settings (model, extensions, packages, theme)
    ├── models.json        # Local Ollama model definitions
    ├── skills/            # Autodiscovered skills
    │   ├── opinion/       # Direct recommendation style
    │   └── teach/         # Teaching/learning workflow formats
    ├── extensions/
    │   ├── autodiscover.ts      # Dynamic extension/skill info helper
    │   ├── context-viewer.ts    # /context — token usage grid visualization
    │   ├── memory.ts            # /memory-consolidate — memory consolidation
    │   ├── notify.ts            # Desktop/session notifications
    │   ├── questionnaire.ts     # questionnaire tool — interactive Q&A UI
    │   ├── ship.ts              # /ship — git add, scan secrets, commit, push
    │   ├── workflow.ts          # /workflow — multi-agent orchestration patterns
    │   └── subagents/           # Subagent delegation system
    │       ├── index.ts        # Entry point — exposes subagent tool
    │       ├── agents/         # planner, scout, researcher, worker, reviewer
    │       └── tools/
    │           └── safe-bash.ts # Bash with dangerous-command blocking
```

## Installation

```bash
git clone https://github.com/ardanazangel/pi-setup ~/.pi
cd ~/.pi/agent && npm install
```

### Optional — web search

`@ollama/pi-web-search` provides `web_search` and `web_fetch` through local Ollama web APIs. Create `~/.pi/web-search.json` for optional provider settings:

```json
{
  "allowBrowserCookies": true,
  "geminiApiKey": "AIza..."
}
```

YouTube/video fetching works best with `youtube.preferredModel` set to `gemini-2.5-flash` when using Gemini.

### Optional — local models

`models.json` defines Ollama models. Requires [Ollama](https://ollama.com) running locally.

## Extensions and packages

| Command / Tool | Source | Description |
|---|---|---|
| `/ship` | `extensions/ship.ts` | Runs `git add -A`, scans for secrets, auto-commits, pushes |
| `/context` | `extensions/context-viewer.ts` | Token usage breakdown as a grid |
| `/workflow <task>` | `extensions/workflow.ts` | Multi-agent orchestration with configurable patterns and quality tiers |
| `/memory-consolidate` | `extensions/memory.ts` | Manual memory consolidation trigger |
| `questionnaire` tool | `extensions/questionnaire.ts` | Interactive single/multi-question UI |
| `find` / `grep` tools | `npm:@ff-labs/pi-fff` | Frecency-ranked, git-aware file and content search |
| `read` / `edit` tools | `npm:pi-hashline-edit` | Hash-anchored file reads and surgical edits |
| `web_search` / `web_fetch` tools | `npm:@ollama/pi-web-search` | Ollama-backed web search and page extraction |
| UI/runtime | `npm:pi-zentui`, `autodiscover.ts`, `notify.ts` | UI helpers, dynamic prompt info, notifications |

## Workflows

`/workflow <task>` orchestrates multiple subagents using configurable execution patterns:

| Flag | Pattern | Description |
|---|---|---|
| (default) | `auto` | Agent selects the best pattern for the task |
| `--adversarial` | adversarial | One agent generates, another verifies |
| `--tournament` | tournament | Multiple approaches ranked by rubric |
| `--loop` | loop | Iterates until a stop condition is met |
| `--quick` | quick | Single-agent fast pass |

Quality tiers control which model each agent uses:

| Tier | Scout | Researcher / Worker |
|---|---|---|
| `--quality fast` | haiku | haiku |
| `--quality balanced` _(default)_ | haiku | sonnet |
| `--quality best` | sonnet | opus |

```bash
/workflow "refactor the database layer" --quality best
/workflow "write unit tests for auth module" --adversarial
/workflow "compare two API design approaches" --tournament
```

## Subagents

The `subagent` tool delegates tasks to specialized agents:

| Agent | Model | Tools | Use for |
|---|---|---|---|
| `planner` | sonnet | read, find/grep | Plans and decomposes work |
| `scout` | haiku | read, find/grep | Fast codebase exploration |
| `researcher` | sonnet | web_search, web_fetch | Web research & synthesis |
| `worker` | sonnet | read, write, edit, bash | Autonomous code changes |
| `reviewer` | sonnet | read, find/grep | Review, verification, critique |

```json
{ "agent": "scout", "task": "find all API route definitions" }

{ "tasks": [
    { "agent": "scout", "task": "..." },
    { "agent": "researcher", "task": "..." }
]}
```

## Evals

The eval system lives in `~/.pi/evals/` and tests that changes to `SYSTEM.md` and extensions don't introduce regressions.

### Structure

```
evals/
├── run.js               # LLM eval runner (agent behavior)
├── run-extensions.js    # Extension eval runner (code)
├── cases/               # Test cases for LLM behavior
│   ├── 01-no-slop.json
│   ├── 02-no-emojis.json
│   ├── 03-no-commit-sin-permiso.json
│   ├── 04-verificacion-antes-de-completar.json
│   ├── 05-conciseness.json
│   └── 06-tool-selection.json
└── results/             # Historical results per run (gitignored)
```

### Usage

```bash
# Run all LLM cases
node ~/.pi/evals/run.js

# Specific case
node ~/.pi/evals/run.js 01-no-slop

# Compare the last two runs
node ~/.pi/evals/run.js --compare

# Extension evals
node ~/.pi/evals/run-extensions.js
node ~/.pi/evals/run-extensions.js ship
```

### Provider

The runner uses the pi CLI (`pi --print`) for LLM calls, so it respects the provider and model configured in `agent/settings.json`. Switching from Anthropic to OpenAI, Gemini or another provider requires no runner changes.

### Automation (pre-commit hook)

`.git/hooks/pre-commit` automatically triggers the relevant evals on commit:

| Changed file | Eval | Duration |
|---|---|---|
| `agent/SYSTEM.md` | LLM behavior (6 cases, via pi CLI) | ~3 min |
| `agent/extensions/*.ts` | Code checks (structure + invariants) | ~2s |

If the score drops below 85%, the commit is blocked. To skip the check: `git commit --no-verify`.

### Adding new cases

When the agent misbehaves in a real session, add that case to `evals/cases/` following the structure of the existing ones. Checks can be:
- `deterministic` — regex over the response (no API cost)
- `llm-judge` — the LLM configured in settings.json evaluates the response against a natural-language criterion

For extensions, add the invariants in `BEHAVIORAL_CHECKS` inside `run-extensions.js`.

## Notes

- Default runtime is configured in `agent/settings.json`
- Generated images are ignored via `agent/generated-images/`
- `telegram.json`, `auth.json` and other secrets are gitignored
- `context-mode/`, `memory/`, `session-search/`, `sessions/` and other runtime dirs are gitignored
- System prompt (`SYSTEM.md`) is concise, no emojis, no AI filler phrases
