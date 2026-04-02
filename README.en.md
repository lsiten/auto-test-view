# auto-test-view

[Chinese](README.md) | **English**

Electron + page-agent browser automation testing tool, exposed as an MCP Server for AI-driven web testing.

## What it does

auto-test-view turns any website into an automated testing playground. It launches an Electron window, injects [page-agent](https://www.npmjs.com/package/page-agent) into every page, and exposes 20+ MCP tools that AI clients (Claude Code, Cursor, etc.) can call to navigate, click, type, scroll, screenshot, and execute natural-language test tasks.

Key capabilities:

- **MCP Server** -- Streamable HTTP transport on `http://127.0.0.1:3399/mcp`, compatible with any MCP client
- **AI-driven testing** -- `execute_task` sends natural language instructions to page-agent for complex multi-step interactions
- **Recording & playback** -- Record user interactions as reusable test sequences, replay them automatically
- **Dual-scope storage** -- Recordings are stored per-project or globally (`~/.auto-test-view/`)
- **Semantic matching** -- When `execute_task` is called, existing recordings are matched via LLM-powered semantic search (PageIndex) and replayed if confidence is high enough
- **Multi-LLM support** -- Claude (built-in adapter), OpenAI, Qwen, or any OpenAI-compatible endpoint

## Installation

### Prerequisites

- Node.js >= 18
- Python 3.8+ (for PageIndex semantic indexing service)
- An LLM API key (Anthropic, OpenAI, or compatible)

### Quick start

```bash
# Clone the repository
git clone https://github.com/lsiten/auto-test-view.git
cd auto-test-view

# Install dependencies
npm install

# Configure LLM credentials
cp .env.example .env
# Edit .env with your API key

# Build and run
npm run dev
```

The app opens an Electron window and starts the MCP server at `http://127.0.0.1:3399/mcp`.

### LLM configuration

Edit `.env` to choose your LLM provider:

**Claude (recommended)** -- Built-in Anthropic-to-OpenAI adapter, no external proxy needed:
```
LLM_BASE_URL=https://api.anthropic.com/v1
LLM_API_KEY=your-anthropic-api-key
LLM_MODEL=claude-sonnet-4-20250514
```

**OpenAI:**
```
LLM_BASE_URL=https://api.openai.com/v1
LLM_API_KEY=your-openai-api-key
LLM_MODEL=gpt-4o
```

**Qwen (DashScope):**
```
LLM_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
LLM_API_KEY=your-dashscope-api-key
LLM_MODEL=qwen3.5-plus
```

**External proxy (e.g., LiteLLM):**
```
LLM_BASE_URL=http://localhost:4000/v1
LLM_API_KEY=your-api-key
LLM_MODEL=claude-sonnet-4-20250514
```

### Connect AI clients

auto-test-view includes a built-in [MCP (Model Context Protocol)](https://modelcontextprotocol.io/) server that exposes browser automation tools to any MCP-compatible AI client. After starting the app (`npm run dev`), connect as follows:

#### Claude Code

```bash
# Via CLI (recommended)
claude mcp add auto-test-view --transport http http://127.0.0.1:3399/mcp
```

Or manually edit `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "auto-test-view": {
      "url": "http://127.0.0.1:3399/mcp"
    }
  }
}
```

#### Cursor

In Cursor, go to **Settings > MCP Servers** and add:

```json
{
  "mcpServers": {
    "auto-test-view": {
      "url": "http://127.0.0.1:3399/mcp"
    }
  }
}
```

Or edit `.cursor/mcp.json` in your project root:

```json
{
  "mcpServers": {
    "auto-test-view": {
      "url": "http://127.0.0.1:3399/mcp"
    }
  }
}
```

#### OpenCode

Edit `~/.config/opencode/config.json` (or set via CLI):

```json
{
  "mcp": {
    "auto-test-view": {
      "type": "remote",
      "url": "http://127.0.0.1:3399/mcp"
    }
  }
}
```

#### Other MCP clients

Any MCP client that supports Streamable HTTP transport can connect. Point it to:

```
http://127.0.0.1:3399/mcp
```

### Install Skills (optional)

Skills are AI skill definitions that teach assistants how to use auto-test-view effectively. See the [Skills section](#skills) below for details.

```bash
# Install all skills for Claude Code
cp skill/auto-test.md ~/.claude/skills/auto-test.md
cp -r skill/test-generator ~/.claude/skills/test-generator
```

## MCP Server

**Transport**: Streamable HTTP (supports session management, SSE notifications)

**Endpoint**: `http://127.0.0.1:3399/mcp`

**Protocol flow**:
1. Client sends `initialize` via POST -- server creates a new session and returns a session ID
2. Subsequent requests include `mcp-session-id` header to route to the correct session
3. GET with session ID opens an SSE stream for server-initiated notifications
4. DELETE with session ID closes the session

## Available MCP tools

### Browser control

| Tool | Description |
|------|-------------|
| `navigate` | Navigate to a URL |
| `go_back` | Browser history back |
| `go_forward` | Browser history forward |
| `refresh` | Reload current page |
| `get_page_state` | Get current DOM state (simplified HTML) |
| `screenshot` | Capture page screenshot |
| `execute_js` | Execute JavaScript in page context |

### Page interaction

| Tool | Description |
|------|-------------|
| `execute_task` | AI-driven natural language task execution (auto-matches recordings first) |
| `click_element` | Click element by index |
| `input_text` | Type text into element by index |
| `scroll` | Scroll page (up/down/left/right) |
| `get_status` | Check page-agent execution status |
| `stop_task` | Stop running page-agent task |

### Recording

| Tool | Description |
|------|-------------|
| `start_recording` | Start recording interactions |
| `add_step_group` | Add a labeled group to current recording |
| `stop_recording` | Stop and save recording (project or global scope) |
| `list_recordings` | List saved recordings |
| `get_recording` | Get recording details by ID |
| `search_recordings` | Search recordings by keyword |
| `delete_recording` | Delete a recording |
| `update_recording` | Update recording metadata |
| `export_recording` | Export recording as JSON |
| `batch_delete_recordings` | Batch delete recordings |
| `batch_export_recordings` | Batch export recordings |
| `batch_move_recordings` | Move recordings between scopes |

### Semantic index

| Tool | Description |
|------|-------------|
| `index_recording` | Index a recording for semantic search |

## Skills

The `skill/` directory contains AI skill definitions that teach AI assistants how to use auto-test-view effectively. Copy them to your AI tool's skill directory to enable enhanced workflows.

### auto-test (skill/auto-test.md)

Core skill for browser automation via MCP. Teaches AI assistants:
- Available MCP tools and their parameters
- Typical test workflow (navigate -> inspect -> interact -> verify)
- Pre-defined test suite structure (107 cases across 13 suites)
- LLM configuration options

**Installation for Claude Code**:
```bash
cp skill/auto-test.md ~/.claude/skills/auto-test.md
```

### test-generator (skill/test-generator/)

Advanced skill for automated test case generation. Capabilities:
- **Multi-source input**: Generate tests from source code, requirements docs, CSV, Markdown, JSON, Excel, or XMind mind maps
- **Three test types**: Unit tests (vitest), E2E browser tests (auto-test-view MCP), integration tests
- **Challenger Agent review**: 3 parallel review agents (coverage, quality, adversarial) audit generated test cases
- **Lifecycle management**: draft -> confirmed -> running -> completed, with change tracking
- **Failure analysis**: Automated root cause analysis for failed test cases

Skill commands: `generate`, `confirm`, `modify`, `run`, `report`, `list`

**Installation for Claude Code**:
```bash
cp -r skill/test-generator ~/.claude/skills/test-generator
```

**Output location**: `.auto-test-view/tests/<task-name>/` (unit/, e2e/, integration/, meta.json, results.json, report.md)

### Using skills with Cursor / OpenCode

Skills are Claude Code-specific. For Cursor or OpenCode, reference the skill files as context:
- Add `skill/auto-test.md` to your project rules or system prompt
- Add `skill/test-generator/SKILL.md` for test generation guidance

## Project structure

```
electron/
  main.ts              # Electron entry point
  preload.ts           # Preload script for renderer
  core/
    agent-injector.ts  # page-agent injection into web pages
    ipc-handlers.ts    # IPC bridge between main and renderer
    llm-proxy.ts       # Built-in Anthropic-to-OpenAI adapter
    logger.ts          # Logging utility
  mcp/
    server.ts          # MCP server (20+ tools)
  recorder/
    recorder.ts        # Recording state machine
    store.ts           # Dual-scope recording persistence
    inject.ts          # Recorder UI injection
    semantic-index.ts  # PageIndex integration for semantic search
  playback/
    matcher.ts         # LLM-powered recording matcher
    trial-runner.ts    # Step-by-step recording replay
  ui/
    welcome.html       # Welcome page
    recorder-ui.html   # Recorder overlay UI
    test-page.html     # Test page
lib/
  pageindex/           # PageIndex library (tree-based retrieval)
  pageindex-service.py # Python HTTP service for PageIndex
tests/
  suites/              # Pre-defined test suites (107 cases, 13 suites)
  *.test.ts            # Unit and integration tests
skill/
  auto-test.md         # MCP skill documentation
  test-generator/      # Test case generation skill
```

## Test suites

Pre-defined test cases in `tests/suites/` covering 107 cases across 13 suites:

| Suite | Cases | Coverage |
|-------|-------|----------|
| navigation | 6 | URL navigation, cross-origin, subpages, anchors |
| click-interactions | 10 | Buttons, links, menus, dropdowns, tabs |
| input-forms | 10 | Search, login, multi-field, special characters |
| scroll-viewport | 10 | Directional scrolling, lazy loading, scroll + action |
| page-state-screenshot | 8 | DOM state retrieval, screenshots, state changes |
| natural-language-tasks | 10 | Descriptive tasks, conditionals, multi-step sequences |
| modal-popup | 5 | Cookie banners, marketing popups, dialogs |
| agent-control | 5 | Status queries, task stop/restart |
| e2e-workflows | 6 | Homepage exploration, search engine flows |
| login-auth | 12 | Account/password, form validation, third-party login |
| register | 6 | Form structure, field-by-field input, password validation |
| captcha-verification | 12 | Image/slider/click captchas, SMS/email verification |
| user-session | 7 | Login state detection, logout, session management |

## Running tests

```bash
# Run all tests
npm test

# Run unit tests only
npm run test:unit

# Run integration tests
npm run test:integration

# Watch mode
npm run test:watch
```

## Scripts

| Script | Description |
|--------|-------------|
| `npm run dev` | Build and start in development mode |
| `npm run build` | TypeScript compilation |
| `npm start` | Start from compiled output |
| `npm test` | Run test suite |

## How recording + replay works

1. **Record**: Call `start_recording` with a name, interact with the page (clicks, inputs, scrolls are captured as steps), then `stop_recording` to save
2. **Index**: Recordings are automatically converted to Markdown and indexed via PageIndex for semantic retrieval
3. **Match**: When `execute_task` is called, the system first searches for matching recordings using LLM-powered semantic matching (dual-scope: project first, then global)
4. **Replay**: If a recording matches with high confidence, it is replayed step-by-step instead of using page-agent from scratch -- faster and more reliable for known workflows

## License

MIT
