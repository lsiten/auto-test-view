# auto-test-view

**中文** | [English](README.en.md)

基于 Electron + page-agent 的浏览器自动化测试工具，通过 MCP Server 为 AI 驱动的 Web 测试提供能力。

## 项目简介

auto-test-view 将任意网站变为自动化测试场。启动后会打开一个 Electron 窗口，自动向每个页面注入 [page-agent](https://www.npmjs.com/package/page-agent)，并通过 MCP Server 暴露 20+ 工具，供 AI 客户端（Claude Code、Cursor、OpenCode 等）调用，实现导航、点击、输入、滚动、截图、自然语言驱动测试等操作。

核心能力：

- **MCP Server** -- Streamable HTTP 传输协议，端点 `http://127.0.0.1:3399/mcp`，兼容所有 MCP 客户端
- **AI 驱动测试** -- `execute_task` 将自然语言指令发送给 page-agent，执行复杂多步交互
- **录制与回放** -- 录制用户操作为可复用的测试序列，后续自动回放
- **双作用域存储** -- 录制数据按项目或全局（`~/.auto-test-view/`）分别存储
- **语义匹配** -- 调用 `execute_task` 时，自动通过 LLM 语义检索（PageIndex）匹配已有录制，置信度足够高则直接回放
- **多 LLM 支持** -- Claude（内置适配层）、OpenAI、通义千问，或任何 OpenAI 兼容接口

## 安装

### 环境要求

- Node.js >= 18
- Python 3.8+（用于 PageIndex 语义索引服务）
- LLM API Key（Anthropic、OpenAI 或兼容接口）

### 快速开始

```bash
# 克隆仓库
git clone https://github.com/lsiten/auto-test-view.git
cd auto-test-view

# 安装依赖
npm install

# 配置 LLM 凭证
cp .env.example .env
# 编辑 .env 填入你的 API Key

# 编译并启动
npm run dev
```

启动后会打开 Electron 窗口，同时在 `http://127.0.0.1:3399/mcp` 启动 MCP Server。

### LLM 配置

编辑 `.env` 选择 LLM 提供商：

**Claude（推荐）** -- 内置 Anthropic 到 OpenAI 格式适配层，无需外部代理：
```
LLM_BASE_URL=https://api.anthropic.com/v1
LLM_API_KEY=your-anthropic-api-key
LLM_MODEL=claude-sonnet-4-20250514
```

**OpenAI：**
```
LLM_BASE_URL=https://api.openai.com/v1
LLM_API_KEY=your-openai-api-key
LLM_MODEL=gpt-4o
```

**通义千问（DashScope）：**
```
LLM_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
LLM_API_KEY=your-dashscope-api-key
LLM_MODEL=qwen3.5-plus
```

**外部代理（如 LiteLLM）：**
```
LLM_BASE_URL=http://localhost:4000/v1
LLM_API_KEY=your-api-key
LLM_MODEL=claude-sonnet-4-20250514
```

### 接入 AI 客户端

auto-test-view 内置了 [MCP (Model Context Protocol)](https://modelcontextprotocol.io/) 服务端，将浏览器自动化工具暴露给任何兼容 MCP 的 AI 客户端。启动应用后（`npm run dev`），按以下方式接入：

#### Claude Code

```bash
# 通过 CLI 添加（推荐）
claude mcp add auto-test-view --transport http http://127.0.0.1:3399/mcp
```

或手动编辑 `~/.claude/settings.json`：

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

在 Cursor 中，进入 **Settings > MCP Servers**，添加：

```json
{
  "mcpServers": {
    "auto-test-view": {
      "url": "http://127.0.0.1:3399/mcp"
    }
  }
}
```

或在项目根目录创建 `.cursor/mcp.json`：

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

编辑 `~/.config/opencode/config.json`（或通过 CLI 设置）：

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

#### 其他 MCP 客户端

任何支持 Streamable HTTP 传输的 MCP 客户端均可连接，指向：

```
http://127.0.0.1:3399/mcp
```

### 安装 Skills（可选）

Skills 是 AI 技能定义文件，安装后 AI 助手能更高效地使用 auto-test-view。详见下方 [Skills 章节](#skillsai-技能)。

```bash
# Claude Code 一键安装所有 Skills
cp skill/auto-test.md ~/.claude/skills/auto-test.md
cp -r skill/test-generator ~/.claude/skills/test-generator
```

## MCP Server

**传输协议**：Streamable HTTP（支持会话管理、SSE 通知）

**端点地址**：`http://127.0.0.1:3399/mcp`

**协议流程**：
1. 客户端发送 `initialize` POST 请求 -- 服务端创建新会话，返回 session ID
2. 后续请求通过 `mcp-session-id` 请求头路由到对应会话
3. 带 session ID 的 GET 请求打开 SSE 流接收服务端通知
4. 带 session ID 的 DELETE 请求关闭会话

## MCP 工具列表

### 浏览器控制

| 工具 | 说明 |
|------|------|
| `navigate` | 导航到指定 URL |
| `go_back` | 浏览器后退 |
| `go_forward` | 浏览器前进 |
| `refresh` | 刷新当前页面 |
| `get_page_state` | 获取当前页面 DOM 状态（简化 HTML） |
| `screenshot` | 截取页面截图 |
| `execute_js` | 在页面上下文中执行 JavaScript |

### 页面交互

| 工具 | 说明 |
|------|------|
| `execute_task` | AI 驱动的自然语言任务执行（自动优先匹配已有录制） |
| `click_element` | 按索引点击元素 |
| `input_text` | 按索引向元素输入文本 |
| `scroll` | 滚动页面（上/下/左/右） |
| `get_status` | 查询 page-agent 执行状态 |
| `stop_task` | 停止当前 page-agent 任务 |

### 录制管理

| 工具 | 说明 |
|------|------|
| `start_recording` | 开始录制用户操作 |
| `add_step_group` | 为当前录制添加步骤分组 |
| `stop_recording` | 停止录制并保存（project 或 global 作用域） |
| `list_recordings` | 列出所有录制 |
| `get_recording` | 按 ID 获取录制详情 |
| `search_recordings` | 按关键词搜索录制 |
| `delete_recording` | 删除录制 |
| `update_recording` | 更新录制元信息 |
| `export_recording` | 导出录制为 JSON |
| `batch_delete_recordings` | 批量删除录制 |
| `batch_export_recordings` | 批量导出录制 |
| `batch_move_recordings` | 在作用域间移动录制 |

### 语义索引

| 工具 | 说明 |
|------|------|
| `index_recording` | 将录制索引到语义检索库 |

## Skills（AI 技能）

`skill/` 目录包含 AI 技能定义文件，教会 AI 助手如何高效使用 auto-test-view。将它们复制到对应 AI 工具的技能目录即可启用增强工作流。

### auto-test（skill/auto-test.md）

浏览器自动化核心技能。教会 AI 助手：
- 所有 MCP 工具的用法和参数
- 典型测试工作流（导航 -> 检查 -> 交互 -> 验证）
- 预置测试套件结构（13 个套件，107 个用例）
- LLM 配置选项

**Claude Code 安装**：
```bash
cp skill/auto-test.md ~/.claude/skills/auto-test.md
```

### test-generator（skill/test-generator/）

高级测试用例生成技能。核心能力：
- **多源输入**：从源代码、需求文档、CSV、Markdown、JSON、Excel 或 XMind 思维导图生成测试
- **三种测试类型**：单元测试（vitest）、E2E 浏览器测试（auto-test-view MCP）、集成测试
- **Challenger Agent 审查**：3 个并行审查 Agent（覆盖率挑战者、质量挑战者、对抗挑战者）审计生成的测试用例
- **生命周期管理**：draft -> confirmed -> running -> completed，带变更追踪
- **失败分析**：自动化根因分析失败用例

技能命令：`generate`、`confirm`、`modify`、`run`、`report`、`list`

**Claude Code 安装**：
```bash
cp -r skill/test-generator ~/.claude/skills/test-generator
```

**输出目录**：`.auto-test-view/tests/<task-name>/`（unit/、e2e/、integration/、meta.json、results.json、report.md）

### Cursor / OpenCode 中使用 Skills

Skills 是 Claude Code 专属格式。在 Cursor 或 OpenCode 中，将技能文件作为上下文引用：
- 将 `skill/auto-test.md` 添加到项目规则或系统提示词中
- 将 `skill/test-generator/SKILL.md` 作为测试生成参考

## 项目结构

```
electron/
  main.ts              # Electron 主进程入口
  preload.ts           # 渲染进程预加载脚本
  core/
    agent-injector.ts  # page-agent 注入到网页
    ipc-handlers.ts    # 主进程与渲染进程 IPC 通信桥
    llm-proxy.ts       # 内置 Anthropic 到 OpenAI 格式适配层
    logger.ts          # 日志工具
  mcp/
    server.ts          # MCP 服务端（20+ 工具）
  recorder/
    recorder.ts        # 录制状态机
    store.ts           # 双作用域录制持久化存储
    inject.ts          # 录制器 UI 注入
    semantic-index.ts  # PageIndex 语义检索集成
  playback/
    matcher.ts         # LLM 驱动的录制匹配器
    trial-runner.ts    # 逐步录制回放执行器
  ui/
    welcome.html       # 欢迎页
    recorder-ui.html   # 录制器浮层 UI
    test-page.html     # 测试页面
lib/
  pageindex/           # PageIndex 库（树状检索）
  pageindex-service.py # PageIndex Python HTTP 服务
tests/
  suites/              # 预置测试套件（13 个套件，107 个用例）
  *.test.ts            # 单元测试和集成测试
skill/
  auto-test.md         # MCP 技能文档
  test-generator/      # 测试用例生成技能
```

## 预置测试套件

`tests/suites/` 中预置了 107 个测试用例，覆盖 13 个测试套件：

| 套件 | 用例数 | 覆盖范围 |
|------|--------|----------|
| navigation | 6 | URL 导航、跨域、子页面、锚点 |
| click-interactions | 10 | 按钮、链接、菜单、下拉框、Tab 切换 |
| input-forms | 10 | 搜索、登录、多字段表单、特殊字符 |
| scroll-viewport | 10 | 上下左右滚动、懒加载、滚动后操作 |
| page-state-screenshot | 8 | DOM 状态获取、截图、状态变化检测 |
| natural-language-tasks | 10 | 描述性操作、条件判断、多步序列 |
| modal-popup | 5 | Cookie 弹窗、营销弹窗、对话框 |
| agent-control | 5 | 状态查询、停止/重启任务 |
| e2e-workflows | 6 | 首页探索、搜索引擎流程 |
| login-auth | 12 | 账号密码、表单校验、第三方登录 |
| register | 6 | 表单结构、逐字段填写、密码校验 |
| captcha-verification | 12 | 图片/滑块/点选验证码、短信/邮箱验证 |
| user-session | 7 | 登录态检测、退出登录、会话管理 |

## 运行测试

```bash
# 运行所有测试
npm test

# 仅运行单元测试
npm run test:unit

# 运行集成测试
npm run test:integration

# 监听模式
npm run test:watch
```

## 可用脚本

| 脚本 | 说明 |
|------|------|
| `npm run dev` | 编译并以开发模式启动 |
| `npm run build` | TypeScript 编译 |
| `npm start` | 从编译产物启动 |
| `npm test` | 运行测试套件 |

## 录制与回放原理

1. **录制**：调用 `start_recording` 并命名，在页面上进行交互操作（点击、输入、滚动等会被捕获为步骤），然后 `stop_recording` 保存
2. **索引**：录制自动转换为 Markdown 文档，通过 PageIndex 建立语义索引
3. **匹配**：调用 `execute_task` 时，系统优先通过 LLM 语义匹配搜索已有录制（双作用域：先项目级，后全局级）
4. **回放**：如果匹配置信度足够高，直接逐步回放录制，而非让 page-agent 从零探索 -- 更快、更可靠

## 许可证

MIT
