# Auto Test Skill

Automated web testing via Electron + page-agent MCP integration.

## When to use

Use this skill when the user wants to:
- Run automated tests on a web page
- Navigate to a URL and verify page content
- Perform UI interactions (click, type, scroll) on a loaded page
- Take screenshots for visual verification
- Execute natural language test scenarios via page-agent AI
- Record user interactions and replay them later
- Intercept or mock network requests for testing
- Upload files or drag-and-drop files for testing
- Execute raw CDP commands for advanced browser control

## Available MCP Tools

### Browser Navigation

#### navigate
Navigate the browser to a target URL.
```
tool: navigate
args: { "url": "https://example.com" }
```

#### go_back
Navigate back in browser history.
```
tool: go_back
args: {}
```

#### go_forward
Navigate forward in browser history.
```
tool: go_forward
args: {}
```

#### refresh
Reload the current page.
```
tool: refresh
args: {}
```

### Page Inspection

#### get_page_state
Retrieve the current page DOM state as simplified HTML structure.
```
tool: get_page_state
args: {}
```

#### screenshot
Capture a screenshot of the current page.
```
tool: screenshot
args: { "path": "/tmp/test-screenshot.png" }
```

#### get_status
Check the current page-agent execution status.
```
tool: get_status
args: {}
```

### Page Interaction

#### execute_task
Send a natural language task to page-agent for AI-driven execution.
Automatically checks for matching recorded sequences first — if a recording matches with high confidence, it replays that instead of using page-agent from scratch.
```
tool: execute_task
args: { "task": "Click the login button and fill in username 'test@example.com'" }
```

#### click_element
Click a specific element by its index from the page-agent element tree.
```
tool: click_element
args: { "index": 5 }
```

#### input_text
Type text into a specific element by its index.
```
tool: input_text
args: { "index": 3, "text": "Hello World" }
```

#### scroll
Scroll the page in a given direction.
```
tool: scroll
args: { "direction": "down", "pages": 2 }
```

#### stop_task
Stop the currently running page-agent task.
```
tool: stop_task
args: {}
```

### JavaScript Execution

#### execute_js
Execute JavaScript code in the page context and return the result. Useful for reading page state, modifying DOM, or running custom assertions.
```
tool: execute_js
args: { "code": "document.title" }
```

### File Operations

#### upload_file
Upload files to a file input element automatically (no dialog, fully automated). Auto-detects the file input if no selector is provided.
```
tool: upload_file
args: { "filePaths": ["/path/to/file.pdf"], "selector": "input[type=file]" }
```

#### drag_file
Drag and drop files onto a drop zone element.
```
tool: drag_file
args: { "filePaths": ["/path/to/image.png"], "selector": ".dropzone" }
```

### Network Interception & Logging

#### network_intercept
Manage network request interception rules. Supports mock, block, modify, delay, and fail actions.
```
# Add a mock rule
tool: network_intercept
args: {
  "action": "add",
  "rule": {
    "urlPattern": "*/api/users*",
    "action": "mock",
    "responseCode": 200,
    "responseBody": "{\"users\": []}"
  }
}

# Block image requests
tool: network_intercept
args: {
  "action": "add",
  "rule": {
    "urlPattern": "*.png",
    "resourceType": "Image",
    "action": "block"
  }
}

# Simulate network delay
tool: network_intercept
args: {
  "action": "add",
  "rule": {
    "urlPattern": "*/api/*",
    "action": "delay",
    "delayMs": 3000
  }
}

# Simulate network failure
tool: network_intercept
args: {
  "action": "add",
  "rule": {
    "urlPattern": "*/api/checkout*",
    "action": "fail",
    "errorReason": "TimedOut"
  }
}

# List all active rules
tool: network_intercept
args: { "action": "list" }

# Clear all rules
tool: network_intercept
args: { "action": "clear" }
```

#### network_log
Capture and inspect network traffic.
```
# Start capturing
tool: network_log
args: { "action": "start" }

# Get captured logs (with optional filter)
tool: network_log
args: {
  "action": "get",
  "filter": { "urlPattern": "*/api/*", "method": "POST" }
}

# Stop capturing
tool: network_log
args: { "action": "stop" }

# Clear logs
tool: network_log
args: { "action": "clear" }
```

### Chrome DevTools Protocol

#### execute_cdp
Execute a Chrome DevTools Protocol command directly. For advanced scenarios not covered by other tools.
```
tool: execute_cdp
args: { "method": "DOM.getDocument", "params": {} }
```

### Recording & Playback

#### start_recording
Start recording user interactions.
```
tool: start_recording
args: { "name": "Login flow", "group": "auth" }
```

#### add_step_group
Add a new step group to the current recording for better organization.
```
tool: add_step_group
args: { "label": "Fill login form" }
```

#### stop_recording
Stop the current recording and save it. Automatically indexes for semantic matching.
```
tool: stop_recording
args: { "scope": "project" }
```

#### list_recordings
List all recordings, optionally filtered by group and scope.
```
tool: list_recordings
args: { "group": "auth", "scope": "project" }
```

#### get_recording
Get a single recording by ID with full step details.
```
tool: get_recording
args: { "id": "rec-abc123", "scope": "project" }
```

#### search_recordings
Search recordings by name, group, URL, or summary.
```
tool: search_recordings
args: { "query": "login", "scope": "project" }
```

#### update_recording
Update a recording's name or group.
```
tool: update_recording
args: { "id": "rec-abc123", "name": "New name", "group": "new-group" }
```

#### delete_recording
Delete a recording by ID.
```
tool: delete_recording
args: { "id": "rec-abc123" }
```

#### export_recording
Export a recording as a test suite JSON compatible with tests/suites/*.json.
```
tool: export_recording
args: { "id": "rec-abc123" }
```

#### Batch Operations

```
# Delete multiple recordings
tool: batch_delete_recordings
args: { "ids": ["rec-1", "rec-2"] }

# Export multiple recordings
tool: batch_export_recordings
args: { "ids": ["rec-1", "rec-2"] }

# Move recordings to a new group
tool: batch_move_recordings
args: { "ids": ["rec-1", "rec-2"], "group": "regression" }
```

## Typical Workflows

### Basic Test Workflow

1. Use `navigate` to load the target page
2. Use `get_page_state` to understand the current DOM
3. Use `execute_task` for complex multi-step interactions, or use `click_element` / `input_text` for precise control
4. Use `screenshot` to capture visual state for verification
5. Use `get_page_state` again to verify the resulting DOM state
6. Repeat steps 2-5 for each test scenario

### Recording & Replay Workflow

1. `start_recording` with a descriptive name and group
2. Perform interactions manually or via tools (`click_element`, `input_text`, `navigate`)
3. Use `add_step_group` to organize steps by phase (e.g., "Fill form", "Submit", "Verify")
4. `stop_recording` with scope "project" or "global"
5. Later, `execute_task` with a similar description will automatically match and replay the recording

### API Mocking Workflow

1. Use `network_intercept` to add mock rules for API endpoints before navigating
2. `navigate` to the target page
3. The page will receive mocked API responses
4. Use `get_page_state` / `screenshot` to verify the UI renders correctly with mocked data
5. `network_intercept` with action "clear" to remove rules when done

### Network Debugging Workflow

1. `network_log` with action "start" to begin capturing
2. Perform page interactions
3. `network_log` with action "get" and filters to inspect specific requests
4. Verify request payloads, response codes, headers
5. `network_log` with action "stop" when done

### File Upload Testing

1. `navigate` to the page with a file upload form
2. Use `upload_file` for standard file inputs (auto-detects the input or provide a CSS selector)
3. Use `drag_file` for drag-and-drop upload zones
4. Verify upload success via `get_page_state` or `screenshot`

### Advanced CDP Workflow

Use `execute_cdp` for scenarios like:
- Emulating devices or geolocation
- Overriding user agent
- Manipulating cookies directly
- Performance profiling
- Accessibility audits

## Test Suites

Pre-defined test cases in `tests/suites/` covering 107 cases across 13 suites:

| Suite | Cases | Coverage |
|-------|-------|----------|
| navigation | 6 | URL navigation, cross-domain, sub-pages, anchors |
| click-interactions | 10 | Buttons, links, index clicks, menus, dropdowns, tabs, collapse |
| input-forms | 10 | Search, login, multi-field, special chars, long text, select, checkboxes |
| scroll-viewport | 10 | Up/down/left/right scroll, multi-page, lazy load, scroll-then-act |
| page-state-screenshot | 8 | DOM state, screenshots, state change detection |
| natural-language-tasks | 10 | Descriptive ops, conditionals, info extraction, multi-step sequences |
| modal-popup | 5 | Cookie banners, marketing popups, dialogs, toasts, overlays |
| agent-control | 5 | Status query, stop/restart task, sequential execution |
| e2e-workflows | 6 | Homepage exploration, search engine flow, multi-page navigation |
| login-auth | 12 | Credentials, form validation, password recovery, third-party login |
| register | 6 | Form structure, field-by-field fill, password validation, terms |
| captcha-verification | 12 | Image/slider/click captcha, reCAPTCHA, SMS/email verification |
| user-session | 7 | Login state detection, user menu, logout, session management |

Run a specific suite by reading `tests/suites/<suite>.json` and executing steps sequentially.

## Configuration

### LLM Setup

**Claude (recommended)** -- built-in Anthropic-to-OpenAI adapter, no external proxy needed:
```
LLM_BASE_URL=https://api.anthropic.com/v1
LLM_API_KEY=your-anthropic-api-key
LLM_MODEL=claude-sonnet-4-20250514
```

Also supports OpenAI, DashScope (Qwen), and any OpenAI-compatible endpoint. See `.env.example`.

### Starting the Server

```bash
cp .env.example .env   # Edit .env with your LLM credentials
npm run dev             # Start Electron + MCP server
```

The Electron app will inject page-agent and start MCP server on http://127.0.0.1:3399/mcp.

### MCP Configuration

1. Start the Electron app first: `npm run dev`
2. Add to your AI client's MCP settings:
```json
{
  "mcpServers": {
    "auto-test-view": {
      "url": "http://127.0.0.1:3399/mcp"
    }
  }
}
```
