# MCP 工具速查表

auto-test-view 全部 28 个 MCP 工具，按功能分类。

## 浏览器导航

| 工具 | 参数 | 说明 |
|------|------|------|
| `navigate` | `{ url: string }` | 导航到 URL，等待 page-agent 注入完成 |
| `go_back` | `{}` | 浏览器后退 |
| `go_forward` | `{}` | 浏览器前进 |
| `refresh` | `{}` | 刷新页面（page-agent 会重新注入） |

## 页面检查

| 工具 | 参数 | 说明 |
|------|------|------|
| `get_page_state` | `{}` | 获取简化 DOM 结构（含元素索引） |
| `screenshot` | `{ path?: string }` | 截图，返回文件路径（默认存 `<projectDir>/.auto-test-view/tmp/screenshots/`） |
| `get_status` | `{}` | page-agent 执行状态 |

## 页面交互

| 工具 | 参数 | 说明 |
|------|------|------|
| `execute_task` | `{ task: string }` | 自然语言任务（自动优先匹配录制） |
| `click_element` | `{ index: number }` | 按索引点击（索引来自 get_page_state） |
| `input_text` | `{ index: number, text: string }` | 按索引输入文本 |
| `scroll` | `{ direction: "up"\|"down"\|"left"\|"right", pages?: number }` | 滚动（默认 1 页） |
| `stop_task` | `{}` | 停止当前 page-agent 任务 |

## JavaScript & CDP

| 工具 | 参数 | 说明 |
|------|------|------|
| `execute_js` | `{ code: string }` | 在页面上下文执行 JS，返回结果 |
| `execute_cdp` | `{ method: string, params?: object }` | 执行 CDP 命令（设备模拟、Cookie 等） |

## 文件操作

| 工具 | 参数 | 说明 |
|------|------|------|
| `upload_file` | `{ filePaths: string[], selector?: string }` | 上传文件到 file input（自动检测或指定选择器） |
| `drag_file` | `{ filePaths: string[], selector: string }` | 拖拽文件到 drop zone |

## 网络操作

| 工具 | 参数 | 说明 |
|------|------|------|
| `network_intercept` | `{ action, rule? }` | 管理拦截规则（mock/block/modify/delay/fail） |
| `network_log` | `{ action, filter? }` | 捕获和查看网络流量 |

### network_intercept 详细参数

**action**: `"add"` | `"remove"` | `"list"` | `"clear"`

**rule 字段（add 时使用）**:

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `urlPattern` | string | add 时必填 | URL glob 匹配（如 `*/api/*`） |
| `action` | string | add 时必填 | `mock` / `block` / `modify` / `delay` / `fail` |
| `id` | string | remove 时必填 | 规则 ID |
| `resourceType` | string | 否 | Document, Script, XHR, Fetch, Image, Stylesheet, Font, Media |
| `method` | string | 否 | GET, POST, PUT, DELETE 等 |
| `responseCode` | number | mock 时 | 响应状态码 |
| `responseHeaders` | object | mock 时 | 响应头 |
| `responseBody` | string | mock 时 | 响应体 |
| `requestHeaders` | object | modify 时 | 要添加/覆盖的请求头 |
| `delayMs` | number | delay 时 | 延迟毫秒数 |
| `errorReason` | string | fail 时 | Failed, Aborted, TimedOut, AccessDenied, ConnectionRefused |

### network_log 详细参数

**action**: `"start"` | `"stop"` | `"get"` | `"clear"`

**filter 字段（get 时使用）**:

| 字段 | 类型 | 说明 |
|------|------|------|
| `urlPattern` | string | URL 匹配 |
| `method` | string | HTTP 方法 |
| `statusCode` | number | 状态码 |

## 录制操作

| 工具 | 参数 | 说明 |
|------|------|------|
| `start_recording` | `{ name: string, group?: string }` | 开始录制 |
| `add_step_group` | `{ label: string }` | 当前录制添加步骤分组 |
| `stop_recording` | `{ scope?: "project"\|"global" }` | 停止并保存（自动语义索引） |

## 录制管理

| 工具 | 参数 | 说明 |
|------|------|------|
| `list_recordings` | `{ group?, scope? }` | 列出录制 |
| `get_recording` | `{ id, scope? }` | 获取录制详情 |
| `search_recordings` | `{ query, scope? }` | 搜索录制（name/group/URL/summary） |
| `update_recording` | `{ id, name?, group?, scope? }` | 更新元信息 |
| `delete_recording` | `{ id, scope? }` | 删除录制 |
| `export_recording` | `{ id, scope? }` | 导出为 JSON 测试套件 |

## 批量操作

| 工具 | 参数 | 说明 |
|------|------|------|
| `batch_delete_recordings` | `{ ids: string[], scope? }` | 批量删除 |
| `batch_export_recordings` | `{ ids: string[], scope? }` | 批量导出 |
| `batch_move_recordings` | `{ ids: string[], group: string, scope? }` | 批量移动到新分组 |

## 超时说明

| 操作 | 默认超时 |
|------|----------|
| 通用操作（click, input, scroll 等） | 120 秒 |
| `execute_task`（AI 任务） | 300 秒 |
| `navigate`（等待 page-agent 注入） | 30 秒 |
