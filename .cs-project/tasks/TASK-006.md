# TASK-006: CDP 协议接入 + 文件上传 + 网络拦截

## 需求
接入 Chrome DevTools Protocol 完整协议操作能力，在此基础上实现：
- 文件选择自动化（upload_file）
- 拖拽上传自动化（drag_file）
- 通用 CDP 命令透传（execute_cdp）
- 网络请求拦截（network_intercept：mock/block/modify/delay/fail）
- 网络流量捕获（network_log）

所有操作零人工交互，全自动执行。

## 子任务
- TASK-006-01: CDP Client 基础层
- TASK-006-02: 文件上传工具
- TASK-006-03: 网络拦截

## 执行方案
01 → (02 + 03 并行)

## 验收标准
1. CDP Client 自动管理 debugger attach/detach，页面导航后自动恢复
2. execute_cdp 能执行任意 CDP 命令并返回结果
3. upload_file 通过 CDP 自动注入文件到 <input type="file">
4. drag_file 通过合成 DragEvent 将文件投递到 Drop zone
5. showOpenDialog 拦截支持待注入文件队列
6. network_intercept 支持 mock/block/modify/delay/fail 五种拦截动作
7. network_log 支持网络流量捕获、过滤、清除
8. 拦截规则在页面导航后自动重新注册
9. 所有工具零人工交互
10. 所有工具产生录制事件（支持回放）

## 状态
- [x] 方案设计
- [x] 拆分确认
- [ ] 开发
- [ ] 验证
- [ ] 完成
