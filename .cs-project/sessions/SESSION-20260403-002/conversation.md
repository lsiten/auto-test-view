# SESSION-20260403-002 Conversation Log

## Round 1 — investigating

**用户需求**：截屏和下载文件目前保存到全局 `os.tmpdir()` 目录，应改为项目本地临时文件夹。

**调查结果**：
- `electron/core/ipc-handlers.ts:445-447`：`takeScreenshot` 默认路径 `os.tmpdir()/screenshot-xxx.png`
- `electron/main.ts:73`：下载保存到 `os.tmpdir()/auto-test-downloads/filename`
- 项目目录已在 `main.ts:200` 通过 `process.env.AUTO_TEST_PROJECT_DIR || process.cwd()` 获取
- 项目本地目录结构已有 `.auto-test-view/` 前缀（recordings 用的就是 `<projectDir>/.auto-test-view/recordings`）

**方案**：将默认路径改为 `<projectDir>/.auto-test-view/tmp/screenshots/` 和 `<projectDir>/.auto-test-view/tmp/downloads/`，与现有 `.auto-test-view/recordings` 保持一致的目录结构。

## Round 2 — designing + developing (lightweight)

**需求澄清**：自动化测试 skill 场景下截屏跟项目目录走，非 skill 场景放 temp。最终确认默认存 `<projectDir>/.auto-test-view/tmp/`。

**实施（轻量模式）**：
1. `electron/core/ipc-handlers.ts` — 新增 `projectDir` + `setProjectDir` setter；`takeScreenshot` 默认路径改为 `<projectDir>/.auto-test-view/tmp/screenshots/`，未设置 projectDir 时 fallback 到 `os.tmpdir()`
2. `electron/main.ts` — `projectDir` 提升为模块级常量；bootstrap 中调用 `setProjectDir`；下载路径改为 `<projectDir>/.auto-test-view/tmp/downloads/`
3. `skill/browser-use/reference/tool-quick-ref.md` — 更新默认路径说明

**验证**：esbuild 构建成功（682ms），tsc --noEmit exit 0。

**提交**：核心代码已在 `102be6c`，文档更新在 `75ea129`。
