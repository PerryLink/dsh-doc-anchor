# dsh-doc-anchor

**把 PDF / HTML / LaTeX / Markdown 文档变成可定位的证据面。**

*不做阅读器、不做渲染、不做翻译 —— 只给坐标、不可变快照，和一份谁都能复算的证据记录。*

[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%5E22.19%20%7C%7C%20%3E%3D24.9-brightgreen.svg)]()

[English](README.md) · 简体中文

---

## 它做什么

`dsh-doc-anchor` 是科研插件家族里 **PDF/HTML/LaTeX → 证据** 这一环。它只回答一个问题：*这段文字在这份文档里的确切位置是什么？*

- 每份文档两份不可变快照：**原始字节** + **抽取文本**。
- 抽取文本上的定位：**页码区间**（PDF）、**章节**（标题）、**表格**、**段落**，以及精确字符偏移。
- 一条 **REP v1 证据记录**（`@perrylink/dsh-research-core`），让 `claim-check`、`cite-verify`、`statcheck`、`research-report` 无需相信摘要即可引用原文。
- 可选辅助：`doc_locate`（找原文引用）、`doc_tables`（读回表格）。

## 它不做什么

- **不做 OCR**：扫描件直接 `parse_failed`，v0.1 绝不从像素猜文字。
- **不做 PDF 表格重建**：`doc_tables` 明说做不到，而不是编一个网格。
- **不渲染/不精读/不翻译/不总结**：抽取文本就是文字层，只做空白规范化。
- **不执行文档**：`<script>`/`<style>` 丢弃，LaTeX 宏不展开，`\input` 不跟随。
- **不解压**：DOCX/ODT/EPUB/ZIP 按名字直接拒绝 —— 不解压就没有 zip 炸弹面。

## 兼容性

| 项 | 值 |
|---|---|
| DeepSeek Harness | **`dsh-v0.2.1-rc.5`**（2026-11-08 实测）；peer 区间 `>=0.2.1-0 <0.3.0 \|\| >=0.2.2-0 <0.3.0` |
| Node | `^22.19.0 \|\| >=24.9.0`（实测 `24.22.1`），仅 ESM |
| Peer | `@perrylink/dsh-research-core ^0.1.0`（共享协议）、`@deepseek-ai/cordis ^4.0.5-alpha.1`、`@deepseek-ai/dsh-tools`、`@deepseek-ai/schemastery ^3.18.5-alpha.1` |
| 运行时依赖 | **零** |

REP core 是**必需 peer**（它是共享协议，不是同级的另一个功能插件）。两个一起装：

```sh
dsh plugin --profile <name> add @perrylink/dsh-research-core dsh-doc-anchor
dsh --profile <name> --dump-config | grep -E "dsh-research-core|dsh-doc-anchor"
dsh plugin --profile <name> remove dsh-doc-anchor
```

挂载了 `ctx.researchEvidence` 就写那个存储；没有就在 `root` 下自建 `EvidenceStore`，因此单独也能跑。

## 工具

### `doc_anchor`

传 `path` **或** `content`。

| 参数 | 类型 | 说明 |
|---|---|---|
| `path` | string | 工作区相对/绝对路径；必须落在 `workspaceRoot` 内（拒绝越界与符号链接逃逸） |
| `content` | string | 内联文本（与 `path` 互斥） |
| `name` | string | 内联时用于类型识别的文件名 |
| `mediaType` | enum | `application/pdf` · `text/html` · `text/x-latex` · `text/markdown` · `text/plain` |
| `title` | string | 证据标题（默认文件名） |
| `persist` | boolean | `false` = 试运行，不落快照/记录 |
| `maxAnchors` | integer | 本次锚点上限（REP v1 硬上限 500） |

返回 `{ ok, evidenceId, snapshotId, textSnapshotId, mediaType, pages, chars, anchorCount, truncated, anchors[], tableCount, warnings[], injectionSuspected, recordPath }`。

**锚点索引的是 `textSnapshotId`**。`kind` 为 `page`（带 `page`）、`section`（带 `label: h1..h6`）、`table`（`value: t.N`）或 `paragraph`（`value: para.N`）；每个锚点都带 `charStart`/`charEnd`。

### `doc_locate`

`{ query, evidenceId?, textSnapshotId?, maxResults?, ignoreCase? }` → `{ ok, count, hits[{charStart, charEnd, quote, page?}] }`。
精确匹配；给 `evidenceId` 时同时映射 PDF 页码。0 命中是正常答案。

### `doc_tables`

`{ evidenceId, maxRows? }` 或 `{ path, maxRows? }` → `{ ok, count, tables[{index, source, header?, rows, rowsTruncated, charStart, charEnd}], warnings[] }`。
HTML `<table>` 与 LaTeX `tabular` 结构化解析；PDF 表格返回空并附警告。

### 错误码

`INVALID_INPUT` · `NOT_FOUND` · `NOT_A_FILE` · `PATH_ESCAPE` · `TOO_LARGE` · `PAGE_LIMIT` · `UNSUPPORTED_TYPE` · `PARSE_FAILED` · `EMPTY_DOCUMENT` · `STORE_ERROR` · `EVIDENCE_UNKNOWN`

所有失败都规范化为 `{ ok: false, error: { code, message } }`，异常不会抛给模型。

## 配置

| 键 | 默认 | 含义 |
|---|---|---|
| `enabled` | `true` | `false` 时不挂载工具 |
| `root` | `.doc-anchor` | 存储与记录根（工作区相对） |
| `workspaceRoot` | `process.cwd()` | 文档路径必须解析在其内 |
| `maxBytes` | `104857600` | 单文档字节上限（100 MiB） |
| `maxPages` | `500` | PDF 页数上限 —— 超过即失败，不截断 |
| `maxChars` | `5000000` | 抽取字符上限 —— 超过即失败 |
| `maxAnchors` | `500` | 单文档锚点上限（schema 硬上限 500） |
| `recordDir` | `anchors` | 每文档 REP 记录目录（在 `root` 下） |
| `persist` | `true` | 是否落快照与记录 |

非法值在挂载期响亮失败（如 `maxAnchors > 500`、`recordDir` 含 `..`）。

## 安全边界

- **路径安全**：先按工作区解析，再 `realpath` 校验；`..`、工作区外绝对路径、指向外部的符号链接一律 `PATH_ESCAPE`。
- **大小/时间**：字节、页数、字符上限在解析前/解析中强制；超限失败而非静默截断。
- **不可信内容**：文档只是数据。脚本/样式/iframe 丢弃，LaTeX 不展开；命中指令式文本只产生有界元数据警告 `prompt_injection_suspected`，不改变行为。
- **不联网**：插件从不抓 URL；远程抓取属于 `dsh-cite-verify` / `dsh-research-report`。
- **不执行**：PDF JavaScript、宏、外部引用、解压，全都不做。

## 已知限制（v0.1）

- **扫描件**没有文字层 → `PARSE_FAILED`；OCR 计划为可选外部后端，永不内置。
- **无 `ToUnicode` 的 CID 字体**会出替换字符，并逐页告警。
- **PDF 表格**不重建。
- **HTML** 是标签扫描器而非完整 HTML5 解析器；畸形标记会优雅降级但可能丢嵌套结构。
- **LaTeX** 是结构化扫描器：不跟随 `\input`、不展开自定义宏，只扁平化常见文本命令。
- **`.docx` / 压缩包**按设计拒绝。

## 评测

- **51 个测试 / 4 个文件**：抽取（文本、markdown、HTML、LaTeX、PDF 含 FlateDecode/ToUnicode/多页偏移/加密/页数上限/扫描件、文档以块级标签开头时的 HTML 偏移）、运行时（路径逃逸、符号链接逃逸、大小上限、persist=false、记录写入、锚点上限截断边界与校验、重复锚定不产生证据冲突）、工具（schema、成功/失败渲染、locate/tables 端到端、不支持的 `doc_tables` 输入）、包契约。
- **合成 PDF fixture** 由测试内构建（`test/fixtures/make-pdf.ts`）—— 不提交任何受版权保护的 PDF；“真实 PDF 语料”是明示的缺口，不是已得结果。
- 本插件**不声称 precision/recall** —— 它是基础设施。检测指标属于 `dsh-cite-verify` / `dsh-claim-check` / `dsh-statcheck`。

## 开发

```sh
pnpm install
pnpm run typecheck
pnpm test
pnpm run build
pnpm run verify:package
```

## 许可

Apache-2.0。运行时零第三方代码。
