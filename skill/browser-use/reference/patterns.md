# 复杂操作编排模式

常见的多步操作编排模式和序列模板。

## 模式一：登录流程

```
navigate { url: "https://example.com/login" }
execute_task { task: "输入用户名 xxx 和密码 xxx，点击登录按钮" }
screenshot {} → 验证登录成功
```

**变体**：
- 验证码登录：截图识别验证码 → 输入
- 第三方登录：execute_task { task: "点击微信登录按钮" } → 等待回调
- 短信登录：execute_task { task: "切换到短信登录，输入手机号 xxx" }

## 模式二：搜索-筛选-操作

```
navigate { url: "https://example.com" }
execute_task { task: "在搜索框输入 'xxx' 并搜索" }
screenshot {} → 确认搜索结果
execute_task { task: "选择价格从低到高排序" }
execute_task { task: "点击第一个结果" }
screenshot {} → 确认进入详情页
```

## 模式三：表单填写

**简单表单**（一步完成）：
```
execute_task { task: "填写姓名为 xxx，邮箱为 xxx@example.com，电话为 13800138000，点击提交" }
```

**复杂表单**（分步操作）：
```
get_page_state {} → 分析表单结构
execute_task { task: "填写基本信息：姓名 xxx，性别选择男" }
execute_task { task: "填写联系方式：邮箱 xxx，电话 xxx" }
execute_task { task: "在地址下拉框选择北京市" }
upload_file { filePaths: ["/path/to/id-card.jpg"], selector: "#id-upload" }
screenshot {} → 确认填写完成
execute_task { task: "勾选同意协议并点击提交" }
```

## 模式四：分页遍历

```
navigate { url: "https://example.com/list" }
# 第 1 页
get_page_state {} → 提取数据
screenshot {}
# 翻页
execute_task { task: "点击下一页" }
# 第 2 页
get_page_state {} → 提取数据
screenshot {}
# 重复直到最后一页
```

## 模式五：弹窗处理

```
navigate { url: "https://example.com" }
screenshot {} → 检查是否有弹窗
# 如有弹窗
execute_task { task: "关闭 Cookie 提示弹窗" }
# 或用 JS 直接处理
execute_js { code: "document.querySelector('.cookie-banner .close').click()" }
# 继续正常操作
```

## 模式六：Mock API + 页面验证

```
# 先设置 Mock
network_intercept {
  action: "add",
  rule: {
    urlPattern: "*/api/products*",
    action: "mock",
    responseCode: 200,
    responseBody: "{\"products\":[], \"total\": 0}"
  }
}
# 导航到页面（将看到空状态）
navigate { url: "https://example.com/products" }
screenshot {} → 验证空状态 UI
# 清理
network_intercept { action: "clear" }
```

## 模式七：网络请求验证

```
# 开始捕获
network_log { action: "start" }
# 执行操作
navigate { url: "https://example.com/login" }
execute_task { task: "输入用户名 test 密码 test123 并登录" }
# 验证请求
network_log {
  action: "get",
  filter: { urlPattern: "*/api/auth/login*", method: "POST" }
}
# → 检查请求体是否包含正确参数
network_log { action: "clear" }
```

## 模式八：移动端模拟

```
# 模拟 iPhone
execute_cdp {
  method: "Emulation.setDeviceMetricsOverride",
  params: { width: 375, height: 812, deviceScaleFactor: 3, mobile: true }
}
execute_cdp {
  method: "Emulation.setUserAgentOverride",
  params: { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X)..." }
}
navigate { url: "https://example.com" }
screenshot {} → 验证移动端布局
```

## 模式九：错误场景测试

```
# 模拟 500 错误
network_intercept {
  action: "add",
  rule: { urlPattern: "*/api/save*", action: "mock", responseCode: 500, responseBody: "{\"error\":\"Internal Server Error\"}" }
}
# 执行操作触发请求
execute_task { task: "填写表单并点击保存" }
screenshot {} → 验证错误提示 UI
network_intercept { action: "clear" }

# 模拟网络超时
network_intercept {
  action: "add",
  rule: { urlPattern: "*/api/save*", action: "fail", errorReason: "TimedOut" }
}
execute_task { task: "再次点击保存" }
screenshot {} → 验证超时提示 UI
network_intercept { action: "clear" }
```

## 模式十：录制 + 回放

```
# 录制阶段
start_recording { name: "完成注册流程", group: "auth" }
add_step_group { label: "填写注册表单" }
navigate { url: "https://example.com/register" }
execute_task { task: "填写用户名 testuser，邮箱 test@example.com，密码 Test123456" }
add_step_group { label: "提交并验证" }
execute_task { task: "点击注册按钮" }
screenshot {}
stop_recording { scope: "project" }

# 回放阶段（后续调用会自动匹配）
execute_task { task: "完成注册流程" }
# → source: "recording"，自动回放上面录制的步骤
```

## 编排原则

1. **一步一验证**：关键操作后用 screenshot 或 get_page_state 验证
2. **先探后做**：不确定页面结构时先 get_page_state 分析
3. **弹窗优先**：navigate 后先处理可能的弹窗再操作
4. **语义优先**：尽量用 execute_task（自然语言），只在精确控制时用 click_element/input_text
5. **及时截图**：失败时截图保留现场，成功时截图作为证据
6. **清理资源**：network_intercept 和 network_log 使用后及时 clear
