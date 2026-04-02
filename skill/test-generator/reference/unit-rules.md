# 单元测试生成规则

## 检测项目框架

```
读取 package.json → devDependencies
  vitest → import { describe, it, expect, vi } from "vitest"
  jest   → describe/it/expect (全局) 或 import from "@jest/globals"
  mocha  → import { describe, it } from "mocha"; import { expect } from "chai"
  无     → 默认 vitest，提示安装
```

## 生成模式

对每个被测模块，生成以下测试结构：

```typescript
describe("<模块名>", () => {
  // Mock 依赖（根据 import 分析）
  // beforeEach: 重置状态

  describe("<函数名>", () => {
    // Happy path（正常输入 → 期望输出）
    it("should <正常行为描述>", () => { ... });

    // Edge cases（边界值、空输入、极端情况）
    it("should handle <边界条件>", () => { ... });

    // Error handling（异常输入 → 期望错误）
    it("should throw when <错误条件>", () => { ... });
  });
});
```

## Mock 约定

- 分析被测文件的 import → 自动生成 mock
- 外部服务（HTTP/DB/文件系统）→ 必须 mock
- 项目内模块 → 按需 mock（如果依赖链太深）
- Electron 特有模块 → `vi.mock("electron", () => ({ ... }))`
