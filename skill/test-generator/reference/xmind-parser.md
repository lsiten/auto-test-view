# XMind 解析规则

`.xmind` 文件本质是 ZIP 压缩包，内含 `content.json`（XMind Zen / XMind 2020+）或 `content.xml`（XMind 8 旧版）。

---

## 提取步骤

```bash
# 新版 XMind（优先）
unzip -p <file>.xmind content.json > /tmp/xmind-content.json

# 旧版 XMind 8（降级）
unzip -p <file>.xmind content.xml > /tmp/xmind-content.xml
```

先尝试提取 `content.json`，若不存在则降级为 `content.xml`。

---

## content.json 结构

```json
[{
  "title": "Sheet 1",
  "rootTopic": {
    "title": "测试套件名",
    "children": {
      "attached": [
        {
          "title": "用例组 A",
          "children": {
            "attached": [
              {
                "title": "测试用例 1",
                "notes": { "plain": { "content": "预期结果" } },
                "markers": [{ "markerId": "priority-1" }]
              },
              { "title": "测试用例 2" }
            ]
          }
        }
      ]
    }
  }
}]
```

关键字段：

| 字段 | 说明 |
|------|------|
| `title` | 节点标题文本 |
| `children.attached` | 子节点数组（主分支） |
| `children.detached` | 自由节点（通常忽略） |
| `notes.plain.content` | 节点备注（纯文本） |
| `notes.html.content` | 节点备注（HTML，降级使用） |
| `markers` | 标记数组，每项含 `markerId` |
| `labels` | 标签数组（字符串） |
| `href` | 超链接（可能指向需求文档） |

---

## 层级映射

| 树层级 | 映射目标 | 说明 |
|--------|----------|------|
| Root topic | 测试套件名 | 作为 describe 的顶层名称 |
| Level 1 children | 测试用例组 | 对应 describe 块 |
| Level 2 children | 单条测试用例 | 对应 it 块 |
| Level 3+ children | 测试步骤 / 预期结果 | 拼接为用例的 steps 和 expected |

多 Sheet 场景：每个 Sheet 视为独立的测试套件，分别按上述规则映射。

---

## 标记与备注提取

| XMind 元素 | 提取规则 |
|------------|----------|
| `markers` 含 `priority-1` | 映射为 P0（高优先级） |
| `markers` 含 `priority-2` | 映射为 P1（中优先级） |
| `markers` 含 `priority-3` | 映射为 P2（低优先级） |
| `markers` 含 `task-done` / `symbol-exclam` | 跳过或标记为已完成 |
| `notes.plain.content` | 提取为预期结果或补充说明 |
| `labels` 数组 | 提取为用例标签（unit/e2e/integration 类型提示） |
| 带删除线样式的 topic | 跳过，视为已废弃用例 |

---

## 旧版 content.xml 解析

XMind 8 使用 XML 格式，结构示例：

```xml
<xmap-content>
  <sheet>
    <topic>
      <title>测试套件名</title>
      <children>
        <topics type="attached">
          <topic>
            <title>用例组 A</title>
            <children>
              <topics type="attached">
                <topic>
                  <title>测试用例 1</title>
                  <notes><plain>预期结果</plain></notes>
                  <marker-refs>
                    <marker-ref marker-id="priority-1"/>
                  </marker-refs>
                </topic>
              </topics>
            </children>
          </topic>
        </topics>
      </children>
    </topic>
  </sheet>
</xmap-content>
```

使用与 JSON 版本相同的层级映射规则。XML 中 `<topic>` 嵌套对应 JSON 中 `children.attached` 数组。
