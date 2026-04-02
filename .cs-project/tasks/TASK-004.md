# TASK-004: electron/ 目录重构

## 需求
将 electron/ 下 14 个平铺文件按功能域重组为子目录，提升可维护性。

## 重构结果

```
electron/
├── main.ts                  # 入口（保留）
├── preload.ts               # IPC bridge（保留）
├── core/                    # 核心模块
│   ├── logger.ts
│   ├── llm-proxy.ts
│   ├── ipc-handlers.ts
│   └── agent-injector.ts
├── recorder/                # 录制功能
│   ├── recorder.ts
│   ├── store.ts             # was recorder-store.ts
│   ├── inject.ts            # was recorder-inject.ts
│   └── semantic-index.ts    # was recording-semantic-index.ts
├── playback/                # 回放功能
│   ├── matcher.ts           # was recording-matcher.ts
│   └── trial-runner.ts
├── mcp/                     # MCP 服务
│   └── server.ts            # was mcp-server.ts
└── ui/                      # HTML 页面
    ├── welcome.html
    ├── recorder-ui.html
    └── test-page.html
```

## 变更范围
- 14 个文件移动到子目录
- 11 个 TypeScript 文件的 import 路径更新
- 3 个文件的 `__dirname` 路径修复（多一层 `..`）
- 2 个测试文件的 mock 路径更新

## 验证
- [x] `npx tsc --noEmit` 编译通过
- [x] `npx vitest run` 47 测试通过

## 状态
- [x] 方案设计（Plan Mode）
- [x] 开发
- [x] 验证
- [x] 完成

## 完成记录
- 完成时间: 2026-04-02
