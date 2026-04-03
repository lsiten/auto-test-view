# E2E 测试 — auto-test-view MCP 工具参考

## JSON Suite Schema

```json
{
  "suite": "string — suite 名称",
  "description": "string — 描述",
  "taskName": "string — 关联任务名",
  "cases": [
    {
      "id": "string — case ID（如 LOGIN-001）",
      "name": "string — 用例名称",
      "sourceId": "string — 来源手工用例 ID",
      "description": "string",
      "steps": [
        {
          "tool": "string — MCP 工具名",
          "args": {},
          "assert": {},
          "note": "string — 步骤说明（可选）"
        }
      ]
    }
  ]
}
```

## 可用 MCP 工具

### 浏览器导航

| 工具 | 参数 | 用途 |
|------|------|------|
| `navigate` | `{ url: string }` | 导航到指定 URL |
| `go_back` | `{}` | 浏览器后退 |
| `go_forward` | `{}` | 浏览器前进 |
| `refresh` | `{}` | 刷新当前页面 |

### 页面检查

| 工具 | 参数 | 用途 |
|------|------|------|
| `get_page_state` | `{}` | 获取当前页面 DOM 状态 |
| `screenshot` | `{ path?: string }` | 截取页面截图 |
| `get_status` | `{}` | 查询 page-agent 状态 |

### 页面交互

| 工具 | 参数 | 用途 |
|------|------|------|
| `execute_task` | `{ task: string }` | 自然语言任务（AI 驱动，自动优先匹配已有录制） |
| `click_element` | `{ index: number }` | 按索引点击元素 |
| `input_text` | `{ index: number, text: string }` | 按索引输入文本 |
| `scroll` | `{ direction: "up"\|"down"\|"left"\|"right", pages?: number }` | 滚动页面 |
| `stop_task` | `{}` | 停止当前任务 |

### JavaScript 执行

| 工具 | 参数 | 用途 |
|------|------|------|
| `execute_js` | `{ code: string }` | 在页面上下文执行 JS 并返回结果 |

### 文件操作

| 工具 | 参数 | 用途 |
|------|------|------|
| `upload_file` | `{ filePaths: string[], selector?: string }` | 自动上传文件到 file input（无需弹窗） |
| `drag_file` | `{ filePaths: string[], selector: string }` | 拖拽文件到 drop zone |

### 网络拦截与日志

| 工具 | 参数 | 用途 |
|------|------|------|
| `network_intercept` | `{ action: "add"\|"remove"\|"list"\|"clear", rule?: {...} }` | 管理网络拦截规则（mock/block/modify/delay/fail） |
| `network_log` | `{ action: "start"\|"stop"\|"get"\|"clear", filter?: {...} }` | 捕获和查看网络流量 |

**network_intercept rule 参数**：

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | string | 规则 ID（remove 时必填） |
| `urlPattern` | string | URL glob 匹配模式（如 `*/api/*`） |
| `resourceType` | string | 资源类型过滤：Document, Script, XHR, Fetch, Image 等 |
| `method` | string | HTTP 方法过滤：GET, POST 等 |
| `action` | string | 拦截动作：mock, block, modify, delay, fail |
| `responseCode` | number | mock 响应状态码 |
| `responseHeaders` | object | mock 响应头 |
| `responseBody` | string | mock 响应体 |
| `requestHeaders` | object | 请求头覆盖（modify 动作） |
| `delayMs` | number | 延迟毫秒数（delay 动作） |
| `errorReason` | string | 错误原因（fail 动作）：Failed, Aborted, TimedOut 等 |

**network_log filter 参数**（仅 get 动作）：

| 字段 | 类型 | 说明 |
|------|------|------|
| `urlPattern` | string | URL 匹配模式 |
| `method` | string | HTTP 方法过滤 |
| `statusCode` | number | 状态码过滤 |

### Chrome DevTools Protocol

| 工具 | 参数 | 用途 |
|------|------|------|
| `execute_cdp` | `{ method: string, params?: object }` | 直接执行 CDP 命令 |

### 录制管理

| 工具 | 参数 | 用途 |
|------|------|------|
| `start_recording` | `{ name: string, group?: string }` | 启动操作录制 |
| `stop_recording` | `{ scope?: "project"\|"global" }` | 停止录制并保存（自动语义索引） |
| `add_step_group` | `{ label: string }` | 录制中添加步骤分组 |
| `list_recordings` | `{ group?: string, scope?: "project"\|"global" }` | 列出录制 |
| `get_recording` | `{ id: string, scope?: "project"\|"global" }` | 获取录制详情 |
| `delete_recording` | `{ id: string, scope?: "project"\|"global" }` | 删除录制 |
| `update_recording` | `{ id: string, name?: string, group?: string, scope?: "project"\|"global" }` | 更新录制元信息 |
| `export_recording` | `{ id: string, scope?: "project"\|"global" }` | 导出录制为 JSON suite |
| `search_recordings` | `{ query: string, scope?: "project"\|"global" }` | 搜索录制 |
| `batch_delete_recordings` | `{ ids: string[], scope?: "project"\|"global" }` | 批量删除录制 |
| `batch_export_recordings` | `{ ids: string[], scope?: "project"\|"global" }` | 批量导出录制 |
| `batch_move_recordings` | `{ ids: string[], group: string, scope?: "project"\|"global" }` | 批量移动录制到新分组 |

## Assert 规则

| 断言 | 说明 | 示例 |
|------|------|------|
| `url_contains` | URL 包含字符串 | `{ "url_contains": "/dashboard" }` |
| `has_status` | agent 状态存在 | `{ "has_status": true }` |
| `has_field` | 响应包含字段 | `{ "has_field": "id" }` |
| `has_url` | 响应包含 URL | `{ "has_url": true }` |
| `response_contains` | 响应文本包含 | `{ "response_contains": "success" }` |
| `field_gte` | 字段值 >= | `{ "field_gte": { "field": "totalSteps", "value": 1 } }` |
| `has_id` | 响应包含 id | `{ "has_id": true }` |
| `js_returns` | JS 表达式返回值匹配 | `{ "js_returns": { "code": "document.title", "expected": "Home" } }` |
| `network_called` | 指定 URL 被请求过 | `{ "network_called": { "urlPattern": "*/api/login*", "method": "POST" } }` |
| `screenshot_taken` | 截图文件存在 | `{ "screenshot_taken": true }` |

## E2E 执行策略

1. 确认 auto-test-view MCP 服务可用（尝试 `get_status`）
2. 按 suite 文件顺序逐个执行
3. 每个 case 内按 steps 顺序执行
4. 每个 step：调用 MCP tool -> 检查 assert -> 记录结果
5. step 失败时：截图保存 -> 记录错误 -> 继续下一个 case（不中断 suite）
6. 全部执行完毕 -> 汇总结果

## 常见 E2E 模式

### API Mock 测试

先设置网络拦截规则，再执行页面交互，最后验证 UI 状态：
```json
{
  "steps": [
    {
      "tool": "network_intercept",
      "args": { "action": "add", "rule": { "urlPattern": "*/api/users*", "action": "mock", "responseCode": 200, "responseBody": "{\"users\":[]}" } },
      "note": "Mock empty user list"
    },
    {
      "tool": "navigate",
      "args": { "url": "https://example.com/users" }
    },
    {
      "tool": "get_page_state",
      "args": {},
      "assert": { "response_contains": "empty" }
    },
    {
      "tool": "network_intercept",
      "args": { "action": "clear" },
      "note": "Clean up rules"
    }
  ]
}
```

### 文件上传测试

```json
{
  "steps": [
    {
      "tool": "navigate",
      "args": { "url": "https://example.com/upload" }
    },
    {
      "tool": "upload_file",
      "args": { "filePaths": ["/tmp/test-file.pdf"] },
      "note": "Auto-detect file input"
    },
    {
      "tool": "get_page_state",
      "args": {},
      "assert": { "response_contains": "test-file.pdf" }
    }
  ]
}
```

### 网络请求验证

```json
{
  "steps": [
    {
      "tool": "network_log",
      "args": { "action": "start" }
    },
    {
      "tool": "execute_task",
      "args": { "task": "Fill the login form and submit" }
    },
    {
      "tool": "network_log",
      "args": { "action": "get", "filter": { "urlPattern": "*/api/login*", "method": "POST" } },
      "assert": { "has_field": "entries" }
    },
    {
      "tool": "network_log",
      "args": { "action": "clear" }
    }
  ]
}
```

### JS 断言

```json
{
  "steps": [
    {
      "tool": "execute_js",
      "args": { "code": "document.querySelectorAll('.item').length" },
      "assert": { "field_gte": { "field": "result", "value": 5 } }
    }
  ]
}
```
