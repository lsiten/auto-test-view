# Auto Test Skill

Automated web testing via Electron + page-agent MCP integration.

## When to use

Use this skill when the user wants to:
- Run automated tests on a web page
- Navigate to a URL and verify page content
- Perform UI interactions (click, type, scroll) on a loaded page
- Take screenshots for visual verification
- Execute natural language test scenarios via page-agent AI

## Available MCP Tools

### navigate
Navigate the browser to a target URL.
```
tool: navigate
args: { "url": "https://example.com" }
```

### execute_task
Send a natural language task to page-agent for AI-driven execution.
```
tool: execute_task
args: { "task": "Click the login button and fill in username 'test@example.com'" }
```

### get_page_state
Retrieve the current page DOM state as simplified HTML structure.
```
tool: get_page_state
args: {}
```

### screenshot
Capture a screenshot of the current page.
```
tool: screenshot
args: { "path": "/tmp/test-screenshot.png" }
```

### click_element
Click a specific element by its index from the page-agent element tree.
```
tool: click_element
args: { "index": 5 }
```

### input_text
Type text into a specific element by its index.
```
tool: input_text
args: { "index": 3, "text": "Hello World" }
```

### scroll
Scroll the page in a given direction.
```
tool: scroll
args: { "direction": "down", "pages": 2 }
```

### get_status
Check the current page-agent execution status.
```
tool: get_status
args: {}
```

### stop_task
Stop the currently running page-agent task.
```
tool: stop_task
args: {}
```

## Typical Test Workflow

1. Use `navigate` to load the target page
2. Use `get_page_state` to understand the current DOM
3. Use `execute_task` for complex multi-step interactions, or use `click_element` / `input_text` for precise control
4. Use `screenshot` to capture visual state for verification
5. Use `get_page_state` again to verify the resulting DOM state
6. Repeat steps 2-5 for each test scenario

## Test Suites

Pre-defined test cases in `tests/suites/` covering 107 cases across 13 suites:

| Suite | Cases | Coverage |
|-------|-------|----------|
| navigation | 6 | URL 导航、跨域、子页面、锚点、刷新重注入 |
| click-interactions | 10 | 按钮、链接、索引点击、菜单、下拉、Tab、折叠、语言切换 |
| input-forms | 10 | 搜索、登录、多字段、特殊字符、长文本、下拉选择、复选单选 |
| scroll-viewport | 10 | 上下左右滚动、多页、懒加载、滚动后操作、返回顶部 |
| page-state-screenshot | 8 | DOM 状态获取、截图、导航后变化 |
| natural-language-tasks | 10 | 描述性操作、条件判断、信息提取、多步序列、JS 执行 |
| modal-popup | 5 | Cookie 弹窗、营销弹窗、对话框、Toast、遮罩层 |
| agent-control | 5 | 状态查询、停止任务、重启、连续执行 |
| e2e-workflows | 6 | 首页探索、搜索引擎流程、多页导航、综合序列 |
| login-auth | 12 | 账号密码、表单校验、找回密码、第三方登录、登录方式切换 |
| register | 6 | 表单结构、逐字段填写、密码校验、用户协议 |
| captcha-verification | 12 | 图片/滑块/点选验证码、reCAPTCHA、短信/邮箱验证码 |
| user-session | 7 | 登录态检测、用户菜单、退出登录、会话管理 |

Run a specific suite by reading `tests/suites/<suite>.json` and executing steps sequentially.

## Configuration

### LLM Setup

**直接使用 Claude（推荐）** -- 内置 Anthropic → OpenAI 格式适配层，自动检测并启动代理：
```
LLM_BASE_URL=https://api.anthropic.com/v1
LLM_API_KEY=your-anthropic-api-key
LLM_MODEL=claude-sonnet-4-20250514
```

也支持 OpenAI、通义千问等 OpenAI 兼容接口，详见 `.env.example`。

### Starting the Server

```bash
cp .env.example .env   # Edit .env with your LLM credentials
npm run dev             # Start Electron + MCP server
```

The Electron app will load camscanner.com/zh, inject page-agent with visual panel, and start MCP server on http://127.0.0.1:3399/mcp.

### MCP Configuration

1. Start the Electron app first: `npm run dev`
2. Add to your Claude Code MCP settings:
```json
{
  "mcpServers": {
    "auto-test-view": {
      "url": "http://127.0.0.1:3399/mcp"
    }
  }
}
```
