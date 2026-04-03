# 录制管理完整指南

## 录制生命周期

```
start_recording → [操作被捕获] → add_step_group → [更多操作] → stop_recording
                                                                      ↓
                                                              自动语义索引
                                                                      ↓
                                                        execute_task 自动匹配回放
```

## 哪些操作会被自动捕获

录制开启后，以下操作会被自动记录为步骤：

| 来源 | 操作 | 记录内容 |
|------|------|----------|
| MCP 工具调用 | navigate, click_element, input_text, scroll | 工具名 + 参数 + 当前 URL |
| MCP 工具调用 | execute_task | 任务描述 + 结果 |
| MCP 工具调用 | execute_cdp | CDP 方法 + 参数 |
| MCP 工具调用 | upload_file, drag_file | 文件路径 + 选择器 |
| MCP 工具调用 | network_intercept, network_log | 动作 + 规则/过滤器 |
| 页面内操作 | 用户在 Electron 窗口中的点击、输入 | 通过 recorder UI 捕获 |

## 步骤分组（Step Group）

步骤分组用于组织录制中的步骤，使回放更清晰。

```
start_recording { name: "完整购物流程", group: "e-commerce" }

add_step_group { label: "登录" }
  navigate → execute_task(登录)

add_step_group { label: "搜索商品" }
  execute_task(搜索) → execute_task(筛选)

add_step_group { label: "加购下单" }
  execute_task(加购) → execute_task(结算)

stop_recording { scope: "project" }
```

分组的作用：
- 回放时按组显示进度
- 导出为 JSON 套件时保持结构
- 便于阅读和维护录制内容

## 作用域（Scope）

| 作用域 | 存储位置 | 用途 |
|--------|----------|------|
| `project` | `.auto-test-view/recordings/` | 项目特定的录制，跟随项目 |
| `global` | `~/.auto-test-view/recordings/` | 跨项目共享的通用录制 |

**选择建议**：
- 项目特有的业务流程 → `project`
- 通用操作（关闭 Cookie 弹窗、处理通用验证码页面）→ `global`
- 不确定 → 默认 `project`，后续可通过 batch_move 迁移

## 语义匹配原理

### 索引过程

`stop_recording` 后自动执行：
1. 将录制步骤转换为 Markdown 文档
2. 通过 PageIndex 构建语义树索引
3. 索引存储在对应 scope 的目录中

### 匹配过程

`execute_task` 调用时：
1. 提取 task 描述作为查询
2. 获取当前页面 URL 作为上下文
3. 通过 LLM 语义检索匹配录制（先 project，再 global）
4. 返回匹配结果（含 confidence 和 reason）
5. 置信度足够高 → 回放；否则 → page-agent 执行

### 提升匹配率

| 做法 | 原因 |
|------|------|
| name 用动宾结构 | "登录系统" 比 "login-test-1" 更易匹配 |
| name 描述目的而非步骤 | "提交订单" 比 "点击提交按钮" 更通用 |
| 保持语言一致 | 录制用中文 name，execute_task 也用中文 |
| 合理粒度 | 一个录制对应一个完整操作，不要太细也不要太粗 |
| 及时清理废弃录制 | 避免过时录制干扰匹配 |

### 匹配失败的原因

| 原因 | 解决 |
|------|------|
| 没有相关录制 | 录制一个新的 |
| name 描述不够准确 | update_recording 更新 name |
| 语言不匹配 | 统一使用中文或英文 |
| 多个相似录制冲突 | 删除或重命名，减少歧义 |
| LLM 未配置 | 检查 .env 中的 LLM 配置 |

## 录制管理操作速查

### 日常管理

```
# 查看所有录制的概览
list_recordings {}

# 搜索特定录制
search_recordings { query: "登录" }

# 查看详细步骤
get_recording { id: "rec-xxx" }

# 更新名称使其更具描述性
update_recording { id: "rec-xxx", name: "使用手机号登录系统" }
```

### 整理分组

```
# 查看某分组下的录制
list_recordings { group: "auth" }

# 批量移动到新分组
batch_move_recordings { ids: ["rec-1", "rec-2"], group: "auth-v2" }
```

### 清理

```
# 删除单条废弃录制
delete_recording { id: "rec-xxx" }

# 批量清理
batch_delete_recordings { ids: ["rec-old-1", "rec-old-2", "rec-old-3"] }
```

### 导出为测试套件

```
# 导出单条
export_recording { id: "rec-xxx" }
# → 返回 JSON，兼容 tests/suites/*.json 格式

# 批量导出
batch_export_recordings { ids: ["rec-1", "rec-2"] }

# 导出后可保存为文件，纳入 CI/CD
```

## 录制最佳实践

1. **命名规范**：`动词 + 对象 [+ 条件]`，如 "登录系统"、"搜索商品并加购"、"使用优惠券下单"
2. **分组规范**：按功能模块，如 auth, search, checkout, admin
3. **粒度控制**：一个录制 = 一个完整的用户操作单元（不是单个点击，也不是整个用户旅程）
4. **定期审查**：页面改版后检查录制是否仍可回放，清理失效的
5. **版本管理**：重要录制导出为 JSON 并提交到 Git
