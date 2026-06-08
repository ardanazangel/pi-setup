# pi setup

My personal [pi](https://github.com/mariozechner/pi) coding agent configuration.

## Structure

```
~/.pi/
├── web-search.json        # Web search config (allowBrowserCookies, API keys)
└── agent/
    ├── SYSTEM.md          # System prompt injected on every session
    ├── settings.json      # pi settings (model, extensions, packages, theme)
    ├── mcp.json           # MCP server configs (Paper + Figma OAuth)
    ├── models.json        # Local Ollama model definitions
    └── extensions/
        ├── ship.ts              # /ship — git add, scan secrets, commit, push
        ├── research.ts          # /research — deep web research workflow
        ├── questionnaire.ts     # questionnaire tool — interactive Q&A UI
        ├── caffeinate.ts        # Keeps Mac awake while agent is running
        ├── context-viewer.ts    # /context — token usage grid visualization
        ├── workflow.ts          # /workflow — multi-agent orchestration patterns
        ├── codex-image-gen-install.json # pi-codex-image-gen install state
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

### Optional — MCP servers

`mcp.json` currently wires:

- `paper` — Paper Design MCP at `http://127.0.0.1:29979/mcp` (requires Paper Desktop running)
- `figma` — Figma MCP via OAuth; credentials are stored in `~/.pi/mcp-oauth/` (gitignored)

### Optional — local models

`models.json` defines Ollama models. Requires [Ollama](https://ollama.com) running locally.

## Extensions

| Command / Tool | File | Description |
|---|---|---|
| `/ship` | `ship.ts` | Runs `git add -A`, scans for secrets, auto-commits, pushes |
| `/research <query>` | `research.ts` | Multi-step web research with synthesis |
| `/context` | `context-viewer.ts` | Token usage breakdown as a grid |
| `/workflow <task>` | `workflow.ts` | Multi-agent orchestration with configurable patterns and quality tiers |
| `questionnaire` tool | `questionnaire.ts` | Interactive single/multi-question UI |
| `codex_generate_image` tool | `npm:pi-codex-image-gen` | Generates bitmap images through Codex image generation |
| background | `caffeinate.ts` | Prevents macOS sleep during agent runs |
| background/UI | `context-mode`, `pi-total-recall`, `pi-intercom`, `pi-mcp-adapter`, `pi-web-access`, `pi-zentui` | Installed npm packages that add context, session history, MCP, web and UI tools |

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

The `subagent` tool delegates tasks to one of three specialized agents:

| Agent | Model | Tools | Use for |
|---|---|---|---|
| `scout` | haiku | read, rg, find, ls | Fast codebase exploration |
| `researcher` | sonnet | web_search, web_fetch | Web research & synthesis |
| `worker` | sonnet | read, write, edit, safe_bash | Autonomous code changes |

```json
{ "agent": "scout", "task": "find all API route definitions" }

{ "tasks": [
    { "agent": "scout", "task": "..." },
    { "agent": "researcher", "task": "..." }
]}
```

## Evals

El sistema de evals vive en `~/.pi/evals/` y testea que los cambios en `SYSTEM.md` y extensiones no introduzcan regresiones.

### Estructura

```
evals/
├── run.js               # Runner de evals LLM (comportamiento del agente)
├── run-extensions.js    # Runner de evals de extensiones (código)
├── cases/               # Casos de prueba para comportamiento LLM
│   ├── 01-no-slop.json
│   ├── 02-no-emojis.json
│   ├── 03-no-commit-sin-permiso.json
│   ├── 04-verificacion-antes-de-completar.json
│   ├── 05-conciseness.json
│   └── 06-tool-selection.json
└── results/             # Resultados históricos por run (gitignored)
```

### Uso

```bash
# Correr todos los casos LLM
node ~/.pi/evals/run.js

# Caso específico
node ~/.pi/evals/run.js 01-no-slop

# Comparar últimos dos runs
node ~/.pi/evals/run.js --compare

# Evals de extensiones
node ~/.pi/evals/run-extensions.js
node ~/.pi/evals/run-extensions.js ship
```

### Automatización (pre-commit hook)

`.git/hooks/pre-commit` dispara automáticamente los evals relevantes al hacer commit:

| Archivo cambiado | Eval | Duración |
|---|---|---|
| `agent/SYSTEM.md` | LLM behavior (6 casos, llama a la API) | ~3 min |
| `agent/extensions/*.ts` | Code checks (estructura + invariantes) | ~2s |

Si el score baja del 85%, el commit se bloquea. Para saltarse el check: `git commit --no-verify`.

### Añadir casos nuevos

Cuando el agente se comporte mal en una sesión real, añade ese caso a `evals/cases/` siguiendo la estructura de los existentes. Los checks pueden ser:
- `deterministic` — regex sobre la respuesta (sin coste de API)
- `llm-judge` — Claude evalúa la respuesta con un criterio en lenguaje natural

Para extensiones, añade los invariantes en `BEHAVIORAL_CHECKS` dentro de `run-extensions.js`.

## Notes

- Default runtime is configured in `agent/settings.json`; current package set includes `pi-codex-image-gen`
- Generated images are ignored via `agent/generated-images/`
- `telegram.json`, `auth.json`, `mcp-oauth/` and other secrets are gitignored
- `context-mode/`, `memory/`, `session-search/`, `sessions/` and other runtime dirs are gitignored
- System prompt (`SYSTEM.md`) is in Spanish — concise, no emojis, no AI filler phrases
