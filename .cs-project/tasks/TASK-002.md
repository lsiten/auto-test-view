# TASK-002: 操作录制功能

## 概述
在 Electron 应用中支持用户录制浏览器操作，将操作命名、分组管理，提供管理页面和录制控制。

## 验收标准

### 录制核心
1. 通过 MCP 工具 `start_recording` 开始录制，`stop_recording` 停止，录制数据保存到 `recordings/` 目录
2. 录制期间用户的点击、输入、滚动操作自动捕获为 MCP tool call 格式的步骤
3. 每个步骤记录当前页面 URL，页面导航时自动插入 navigate 步骤
4. 每个步骤记录元素文本（text 字段），AI 可直接理解操作含义

### 命名和分组
5. 录制支持命名和分组（group），`list_recordings` 返回含摘要的列表，可按分组过滤
6. 录制内支持步骤分组（step group），通过 `add_step_group` 或浮窗「新建分组」创建
7. index.json 包含 `urls` 字段（涉及域名列表），AI 可区分不同网站的同名操作

### 管理页面
8. `recorder-ui.html` 管理页面按分组折叠展示所有录制
9. 管理页面支持重命名、修改分组、删除、导出为测试套件 JSON
10. 导出格式与现有 `tests/suites/*.json` 兼容

### 录制控制
11. 录制期间页面底部显示浮窗控制条（录制状态、步骤计数、当前分组名、新建分组、停止按钮）
12. Welcome 页面有「录制管理」入口链接

### 工程质量
13. TypeScript 编译通过（`npx tsc` 无错误）
14. 录制数据 JSON 格式 AI 友好：精简字段、摘要内联、tool call 对齐

## 涉及文件（重构后路径）

| 文件 | 操作 |
|------|------|
| electron/recorder/recorder.ts | 新建 |
| electron/recorder/store.ts | 新建 |
| electron/recorder/inject.ts | 新建 |
| electron/ui/recorder-ui.html | 新建 |
| electron/preload.ts | 修改 |
| electron/core/ipc-handlers.ts | 修改 |
| electron/mcp/server.ts | 修改 |
| electron/main.ts | 修改 |
| electron/ui/welcome.html | 修改 |

## 状态
- [x] 方案设计
- [x] 开发
- [x] Spec 审查
- [x] 质量审查
- [x] 验证

## 完成记录
- 完成时间: 2026-04-01
- 录制核心功能、管理页面、录制控制全部实现
- 文件路径已随 TASK-004 目录重构更新（2026-04-02）
