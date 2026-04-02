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

| 工具 | 参数 | 用途 |
|------|------|------|
| `navigate` | `{ url: string }` | 导航到指定 URL |
| `execute_task` | `{ task: string }` | 自然语言任务（AI 驱动，适合复杂交互） |
| `get_page_state` | `{}` | 获取当前页面 DOM 状态 |
| `screenshot` | `{ path?: string }` | 截取页面截图 |
| `click_element` | `{ index: number }` | 按索引点击元素 |
| `input_text` | `{ index: number, text: string }` | 按索引输入文本 |
| `scroll` | `{ direction: "up"|"down"|"left"|"right", pages?: number }` | 滚动页面 |
| `get_status` | `{}` | 查询 page-agent 状态 |
| `stop_task` | `{}` | 停止当前任务 |
| `start_recording` | `{ name: string, group?: string }` | 启动操作录制 |
| `stop_recording` | `{ scope?: "project"|"global" }` | 停止录制并保存 |
| `add_step_group` | `{ label: string }` | 录制中添加步骤分组 |
| `list_recordings` | `{ group?: string, scope?: "project"|"global" }` | 列出录制 |
| `get_recording` | `{ id: string, scope?: "project"|"global" }` | 获取录制详情 |
| `delete_recording` | `{ id: string, scope?: "project"|"global" }` | 删除录制 |
| `search_recordings` | `{ query: string, scope?: "project"|"global" }` | 搜索录制 |
| `execute_recording` | `{ task: string, url: string }` | 匹配并回放录制 |

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

## E2E 执行策略

1. 确认 auto-test-view MCP 服务可用（尝试 `get_status`）
2. 按 suite 文件顺序逐个执行
3. 每个 case 内按 steps 顺序执行
4. 每个 step：调用 MCP tool → 检查 assert → 记录结果
5. step 失败时：截图保存 → 记录错误 → 继续下一个 case（不中断 suite）
6. 全部执行完毕 → 汇总结果
