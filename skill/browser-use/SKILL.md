# browser-use: 浏览器自动化操作

> 通过 auto-test-view MCP 工具实现自然语言驱动的浏览器自动化操作。
> 支持自然语言页面交互、复杂多步操作编排、录制回放管理。

## 触发词

`打开页面`、`操作页面`、`点击`、`输入`、`浏览器`、`录制`、`回放`、`自动化操作`、`browser`、`navigate`、`page`、`recording`、`/browser-use`

## 文档索引

| 文件 | 内容 | 何时阅读 |
|------|------|----------|
| **本文件** | 核心流程、决策树、工作流模式 | **每次执行前** |
| [reference/tool-quick-ref.md](reference/tool-quick-ref.md) | 全部 28 个 MCP 工具速查表 | 需要确认工具参数时 |
| [reference/patterns.md](reference/patterns.md) | 复杂操作编排模式、多步序列模板 | 编排复杂操作时 |
| [reference/recording-guide.md](reference/recording-guide.md) | 录制生命周期、管理操作、语义匹配原理 | 录制相关操作时 |

---

## 一、前置条件

1. auto-test-view 已启动（`npm run dev`）
2. MCP 连接已配置（endpoint: `http://127.0.0.1:3399/mcp`）
3. 验证连接：调用 `get_status` 确认服务可用

**首次使用检查**：
```
get_status → 成功 → 就绪
get_status → 失败 → 提示用户启动 auto-test-view
```

---

## 二、决策树：用户意图 -> 执行路径

```
用户意图
├── 自然语言操作（"帮我点击登录按钮"、"填写表单"）
│   └── → 自然语言操作流程（三）
├── 精确操作（"点击第 5 个元素"、"在索引 3 输入文本"）
│   └── → 精确操作流程（四）
├── 复杂多步操作（"完成登录流程"、"测试购物车到支付"）
│   └── → 多步编排流程（五）
├── 录制（"录制这个操作"、"开始录制"）
│   └── → 录制流程（六）
├── 录制管理（"查看录制"、"搜索录制"、"导出录制"）
│   └── → 录制管理流程（七）
├── 网络调试（"拦截请求"、"查看网络日志"）
│   └── → 网络操作流程（八）
└── 文件操作（"上传文件"、"拖拽文件"）
    └── → 文件操作流程（九）
```

---

## 三、自然语言操作流程

**核心工具**：`execute_task` — 将自然语言指令发送给 page-agent AI 执行。

**内置智能**：`execute_task` 调用时自动执行以下流程：
1. 语义检索已有录制（先项目级，再全局级）
2. 匹配置信度足够高 → 直接回放录制（更快、更稳定）
3. 置信度不够 → page-agent AI 从零执行（更灵活）

**使用原则**：
- 优先使用 `execute_task`，它能处理绝大多数交互场景
- 指令要具体、明确，避免歧义
- 一次一个任务目标，不要在单条指令里塞多个不相关操作

**执行步骤**：

```
1. [可选] navigate → 导航到目标页面（已在目标页则跳过）
2. execute_task → 发送自然语言指令
3. 检查返回值的 source 字段：
   - "recording" → 通过录制回放完成，附带 confidence 和 matchReason
   - "page-agent" → 通过 AI 实时执行完成
4. [验证] screenshot 或 get_page_state → 确认操作结果
```

**示例**：

```
用户：帮我在百度搜索 "auto-test-view"

执行：
  1. navigate { url: "https://www.baidu.com" }
  2. execute_task { task: "在搜索框输入 'auto-test-view' 并点击搜索按钮" }
  3. screenshot {} → 返回截图路径，读取截图确认结果
```

**返回值解读**：

| source | 含义 | 后续动作 |
|--------|------|----------|
| `recording` | 匹配到已有录制并回放成功 | 直接验证结果 |
| `page-agent` | AI 实时执行 | 验证结果，如操作有价值考虑录制 |

---

## 四、精确操作流程

**适用场景**：已知元素索引、需要精确控制、或 `execute_task` 无法准确理解时。

**步骤**：

```
1. get_page_state → 获取 DOM 结构和元素索引
2. 根据元素索引选择操作：
   - click_element { index: N }     → 点击
   - input_text { index: N, text }  → 输入
   - scroll { direction, pages }    → 滚动
3. [验证] get_page_state 或 screenshot
```

**注意事项**：
- 元素索引在页面变化后可能失效，每次操作前建议刷新 `get_page_state`
- 如果页面动态加载内容，先 scroll 到目标区域再获取状态
- 对于隐藏元素（需要 hover 才显示的菜单等），优先用 `execute_task`

---

## 五、复杂多步操作编排

**核心原则**：拆解为原子步骤，每步验证，失败时重试或降级。

### 编排策略

| 复杂度 | 判断 | 策略 |
|--------|------|------|
| 简单 | 1-2 步，单页面 | 单个 `execute_task` 搞定 |
| 中等 | 3-5 步，可能跨页 | 拆为多个 `execute_task`，每步验证 |
| 复杂 | 5+ 步，跨多页，有条件分支 | 混合使用工具，关键节点截图 |

### 编排模式

**模式 A：串行执行（最常用）**
```
navigate → execute_task(步骤1) → 验证 → execute_task(步骤2) → 验证 → ...
```

**模式 B：探索-定位-操作**
```
navigate → get_page_state → [分析 DOM 找到目标] → click/input → 验证
```

**模式 C：条件分支**
```
navigate → get_page_state → [检查页面状态]
  → 状态 A：execute_task(操作 A)
  → 状态 B：execute_task(操作 B)
  → 异常：screenshot → 报告
```

**模式 D：跨页面流程**
```
navigate(页面1) → 操作 → [页面跳转] → get_page_state(确认新页面) → 操作 → ...
```

### 多步操作示例

```
用户：完成从登录到下单的完整流程

编排：
  1. navigate { url: "https://example.com/login" }
  2. execute_task { task: "输入用户名 test@example.com 和密码 Test123，点击登录" }
  3. screenshot → 确认登录成功（看到用户名或跳转到首页）
  4. execute_task { task: "搜索商品 '无线鼠标'" }
  5. screenshot → 确认搜索结果
  6. execute_task { task: "点击第一个商品进入详情页" }
  7. execute_task { task: "点击加入购物车" }
  8. screenshot → 确认加购成功
  9. execute_task { task: "进入购物车页面" }
  10. execute_task { task: "点击结算按钮" }
  11. screenshot → 确认到达订单确认页
```

### 失败处理策略

| 失败类型 | 处理 |
|----------|------|
| 元素未找到 | scroll 页面 → 重试 / 用 execute_task 换一种描述 |
| 页面未加载 | refresh → 等待 → 重试 |
| 弹窗遮挡 | execute_task("关闭弹窗/广告") → 重试原操作 |
| 登录态丢失 | 检测 URL → 重新登录 → 继续流程 |
| 超时 | stop_task → 分析 get_page_state → 调整指令重试 |

---

## 六、录制流程

### 为什么要录制

- 重复操作只需录制一次，后续 `execute_task` 自动匹配回放
- 回放比 AI 实时执行更快、更稳定
- 录制可导出为 JSON 测试套件，集成到自动化测试

### 录制步骤

```
1. start_recording { name: "描述性名称", group: "分组" }
   → 返回 recording ID

2. 执行操作（以下操作会被自动捕获）：
   - navigate / click_element / input_text / scroll
   - execute_task（内部步骤也会被记录）
   - execute_cdp / upload_file / drag_file / network_intercept

3. [可选] add_step_group { label: "阶段名称" }
   → 为步骤添加逻辑分组（如 "填写表单"、"提交验证"）

4. stop_recording { scope: "project" 或 "global" }
   → 保存录制，自动建立语义索引
```

### 录制命名规范

| 要素 | 说明 | 示例 |
|------|------|------|
| name | 描述操作目的，动宾结构 | "登录系统"、"搜索商品" |
| group | 功能模块分组 | "auth"、"search"、"checkout" |
| scope | project = 项目内共享，global = 跨项目复用 | 通用操作用 global |

### 录制的自动匹配

录制保存后自动语义索引。之后任何 `execute_task` 调用都会：
1. 将 task 描述与所有录制进行语义匹配
2. 先搜索项目级录制，再搜索全局级录制
3. 置信度足够高时直接回放（更快更稳定）

**提升匹配率的建议**：
- name 要描述清楚"做什么"，而非"怎么做"
- 用中文或英文保持一致，与后续 execute_task 指令语言一致
- 为不同变体录制不同版本（如 "密码登录"、"验证码登录"）

---

## 七、录制管理

### 查看与搜索

```
# 列出所有录制
list_recordings {}

# 按分组查看
list_recordings { group: "auth" }

# 按作用域查看
list_recordings { scope: "project" }

# 关键词搜索（搜索 name、group、URL、summary）
search_recordings { query: "登录" }

# 查看录制详情（含完整步骤）
get_recording { id: "rec-xxx" }
```

### 修改与删除

```
# 更新名称或分组
update_recording { id: "rec-xxx", name: "新名称", group: "新分组" }

# 删除单条
delete_recording { id: "rec-xxx" }

# 批量删除
batch_delete_recordings { ids: ["rec-1", "rec-2", "rec-3"] }

# 批量移动到新分组
batch_move_recordings { ids: ["rec-1", "rec-2"], group: "regression" }
```

### 导出

```
# 导出为 JSON 测试套件（兼容 tests/suites/*.json 格式）
export_recording { id: "rec-xxx" }

# 批量导出
batch_export_recordings { ids: ["rec-1", "rec-2"] }
```

### 录制管理最佳实践

1. **及时清理**：删除失败或废弃的录制，避免干扰语义匹配
2. **合理分组**：按功能模块分组（auth, search, checkout），便于检索
3. **定期导出**：重要录制导出为 JSON，纳入版本控制
4. **作用域选择**：
   - `project`：与特定项目绑定的操作（如项目内的登录流程）
   - `global`：跨项目通用的操作（如通用的 Cookie 弹窗关闭）

---

## 八、网络操作

### 请求拦截

```
# Mock API 响应
network_intercept {
  action: "add",
  rule: {
    urlPattern: "*/api/users*",
    action: "mock",
    responseCode: 200,
    responseBody: "{\"users\": [{\"name\": \"test\"}]}"
  }
}

# 屏蔽广告/追踪请求
network_intercept {
  action: "add",
  rule: { urlPattern: "*analytics*", action: "block" }
}

# 模拟慢网络
network_intercept {
  action: "add",
  rule: { urlPattern: "*/api/*", action: "delay", delayMs: 3000 }
}

# 模拟网络错误
network_intercept {
  action: "add",
  rule: { urlPattern: "*/api/pay*", action: "fail", errorReason: "TimedOut" }
}

# 修改请求头
network_intercept {
  action: "add",
  rule: {
    urlPattern: "*/api/*",
    action: "modify",
    requestHeaders: { "Authorization": "Bearer test-token" }
  }
}

# 查看当前规则
network_intercept { action: "list" }

# 清除所有规则
network_intercept { action: "clear" }
```

### 网络流量监控

```
# 开始捕获
network_log { action: "start" }

# 执行页面操作...

# 查看捕获的请求（可过滤）
network_log { action: "get", filter: { urlPattern: "*/api/*", method: "POST" } }

# 按状态码过滤
network_log { action: "get", filter: { statusCode: 500 } }

# 停止捕获
network_log { action: "stop" }

# 清除日志
network_log { action: "clear" }
```

**典型场景**：验证前端是否正确发送 API 请求、调试请求参数、确认响应格式。

---

## 九、文件操作

### 文件上传

```
# 自动检测 file input（最常用）
upload_file { filePaths: ["/path/to/document.pdf"] }

# 指定 CSS 选择器
upload_file { filePaths: ["/path/to/photo.jpg"], selector: "#avatar-upload" }

# 多文件上传
upload_file { filePaths: ["/path/to/a.pdf", "/path/to/b.pdf"] }
```

### 拖拽上传

```
# 拖拽文件到 drop zone
drag_file { filePaths: ["/path/to/image.png"], selector: ".upload-dropzone" }
```

**注意**：filePaths 必须是绝对路径，文件必须在本地磁盘上存在。

---

## 十、高级操作

### JavaScript 执行

```
# 读取页面信息
execute_js { code: "document.title" }
execute_js { code: "document.querySelectorAll('.item').length" }
execute_js { code: "localStorage.getItem('token')" }

# 修改页面状态
execute_js { code: "document.querySelector('.modal').style.display = 'none'" }

# 执行复杂逻辑
execute_js { code: "Array.from(document.querySelectorAll('a')).map(a => a.href)" }
```

### CDP 命令

```
# 设备模拟
execute_cdp {
  method: "Emulation.setDeviceMetricsOverride",
  params: { width: 375, height: 812, deviceScaleFactor: 3, mobile: true }
}

# Cookie 操作
execute_cdp { method: "Network.getAllCookies" }
execute_cdp {
  method: "Network.setCookie",
  params: { name: "session", value: "abc123", domain: "example.com" }
}

# 地理位置模拟
execute_cdp {
  method: "Emulation.setGeolocationOverride",
  params: { latitude: 31.2304, longitude: 121.4737, accuracy: 100 }
}
```

---

## 十一、操作验证策略

每次操作后选择合适的验证方式：

| 方式 | 工具 | 适用场景 |
|------|------|----------|
| 视觉验证 | `screenshot` | 页面布局、视觉回归、用户可见状态 |
| DOM 验证 | `get_page_state` | 元素存在性、文本内容、结构变化 |
| URL 验证 | `execute_js { code: "location.href" }` | 页面跳转是否正确 |
| 网络验证 | `network_log { action: "get" }` | API 请求是否正确发送 |
| JS 验证 | `execute_js { code: "..." }` | 应用状态、localStorage、变量值 |

**验证原则**：
- 关键操作必须验证（登录、支付、提交表单）
- 中间步骤可以跳过验证（滚动、简单导航）
- 失败后先截图再分析

---

## 十二、常见问题处理

| 问题 | 诊断 | 解决 |
|------|------|------|
| page-agent 未就绪 | `get_status` 返回错误 | `refresh` 后重试（page-agent 会重新注入） |
| 元素被遮挡 | `screenshot` 看到弹窗/遮罩 | `execute_task("关闭弹窗")` 或 `execute_js` 隐藏遮罩 |
| 页面加载慢 | 操作超时 | 增加等待，或 `get_page_state` 轮询直到目标元素出现 |
| 动态内容未加载 | `get_page_state` 缺少元素 | `scroll { direction: "down" }` 触发懒加载 |
| 跨域页面 | navigate 到新域名后操作失败 | page-agent 会自动重新注入，等待 `get_status` 恢复 |
| 录制匹配到错误的录制 | execute_task 返回 source: recording 但结果不对 | 更新录制 name 使其更精确，或删除干扰录制 |
