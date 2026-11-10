# dsh-doc-anchor

**把 PDF / HTML / LaTeX / Markdown 文档变成 DeepSeek Harness 里可定位的证据。**

*它不做阅读器，不做渲染，也不做翻译 —— 只提供坐标、不可变快照，以及一份任何人都能复核的证据记录。*

[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%5E22.19%20%7C%7C%20%3E%3D24.9-brightgreen.svg)]()
[![DSH plugin](https://img.shields.io/badge/dsh--plugin-✅-green)](https://github.com/topics/dsh-plugin)

[English](README.md) · 简体中文

---

## 它做什么

`dsh-doc-anchor` 是科研插件家族中 **PDF/HTML/LaTeX → 证据** 的那一步。它只回答一个问题：*这段文字究竟位于这份文档的哪个位置？*

- 每份文档保留两份不可变快照：**原始字节**与**抽取文本**。
- 对抽取文本提供这些定位方式：**页码区间**（PDF）、**章节**（标题）、**表格**、**段落**，以及精确的字符偏移。
- 生成一条 **REP v1 证据记录**（`@perrylink/dsh-research-core`），使 `claim-check`、`cite-verify`、`statcheck` 与 `research-report` 能够在不信任摘要的前提下引用该文档。
- 可选的辅助工具：`doc_locate`（查找逐字引文）与 `doc_tables`（读回表格网格）。

## 它不做什么

- **不内置 OCR。** 扫描版 PDF 默认以明确的 `parse_failed` 失败；可选外部后端（`pdf.backend: pdftotext | command`）可以跑调用方提供的抽取器，但不捆绑任何二进制，失败仍然显式。
- **不重建 PDF 表格。** `doc_tables` 会直说做不到，而不是凭空编造一张表格。
- **不渲染、不阅读、不翻译，也不总结。** 抽取文本就是原始文本层，只对空白做规范化处理。
- **不执行文档。** `<script>`/`<style>` 会被丢弃，LaTeX 宏永不展开，`\input` 指向的文件不会被跟进。
- **不解包归档文件。** DOCX/ODT/EPUB/ZIP 按扩展名直接拒绝 —— 不解包，zip 炸弹就没有可乘之机。

## 兼容性

| | |
|---|---|
| DeepSeek Harness | **`dsh-v0.2.1-rc.5`**（2026-11-08 实测）；peer 区间 `>=0.2.1-0 <0.3.0 \|\| >=0.2.2-0 <0.3.0` |
| Node | `^22.19.0 \|\| >=24.9.0`（实测 `24.22.1`），仅 ESM |
| Peer | `@perrylink/dsh-research-core ^0.1.0`（共享协议）、`@deepseek-ai/cordis ^4.0.5-alpha.1`、`@deepseek-ai/dsh-tools`、`@deepseek-ai/schemastery ^3.18.5-alpha.1` |
| 运行时依赖 | **零** |

REP core 包是**必需的 peer**（它是共享协议，而不是同级的另一个功能插件）。两个包需要一起安装：

```sh
dsh plugin --profile <name> add @perrylink/dsh-research-core dsh-doc-anchor
dsh --profile <name> --dump-config | grep -E "dsh-research-core|dsh-doc-anchor"
dsh plugin --profile <name> remove dsh-doc-anchor
```

挂载了 `ctx.researchEvidence` 时，证据写入该存储；否则插件会在 `root` 下自建一个 `EvidenceStore`，因此它单独使用也能工作。

## 工具

### `doc_anchor`

接受 `path` **或** `content`。

| 参数 | 类型 | 说明 |
|---|---|---|
| `path` | string | 工作区相对路径或绝对路径；必须位于 `workspaceRoot` 内（拒绝路径穿越与符号链接逃逸） |
| `content` | string | 内联文档文本（与 `path` 互斥） |
| `name` | string | 使用内联内容时用于判定媒体类型的文件名 |
| `mediaType` | enum | `application/pdf` · `text/html` · `text/x-latex` · `text/markdown` · `text/plain` |
| `title` | string | 证据标题（默认为文件名） |
| `persist` | boolean | `false` = 试运行，不写快照，也不写记录 |
| `maxAnchors` | integer | 单次调用上限（硬上限 500，REP v1） |

返回 `{ ok, evidenceId, snapshotId, textSnapshotId, mediaType, pages, chars, anchorCount, truncated, anchors[], tableCount, warnings[], injectionSuspected, recordPath }`。

**锚点索引的是 `textSnapshotId`。** `kind` 可以是 `page`（带 `page`）、`section`（带 `label: h1..h6`）、`table`（带 `value: t.N`）或 `paragraph`（带 `value: para.N`）；每个锚点都带有 `charStart`/`charEnd`。

### `doc_locate`

`{ query, evidenceId?, textSnapshotId?, maxResults?, ignoreCase? }` → `{ ok, count, hits[{charStart, charEnd, quote, page?}] }`。
对抽取文本做精确匹配；给出 `evidenceId` 时还会把命中位置映射到 PDF 页码。零命中也是一个正常答案。

### `doc_tables`

`{ evidenceId, maxRows? }` 或 `{ path, maxRows? }` → `{ ok, count, tables[{index, source, header?, rows, rowsTruncated, charStart, charEnd}], warnings[] }`。
HTML 的 `<table>` 与 LaTeX 的 `tabular` 会被结构化解析；PDF 表格则返回空结果并附一条警告。

### 错误码

`INVALID_INPUT` · `NOT_FOUND` · `NOT_A_FILE` · `PATH_ESCAPE` · `TOO_LARGE` · `PAGE_LIMIT` · `UNSUPPORTED_TYPE` · `PARSE_FAILED` · `EMPTY_DOCUMENT` · `STORE_ERROR` · `EVIDENCE_UNKNOWN`

所有失败都会被规范化为 `{ ok: false, error: { code, message } }` —— 不会有任何异常抛给模型。

## 配置

| 键 | 默认 | 含义 |
|---|---|---|
| `enabled` | `true` | `false` 时不挂载任何工具 |
| `root` | `.doc-anchor` | 存储与记录的根目录（工作区相对路径） |
| `workspaceRoot` | `process.cwd()` | 文档路径必须解析到该目录内 |
| `maxBytes` | `104857600` | 单文档字节上限（100 MiB） |
| `maxPages` | `500` | PDF 页数上限 —— 超出即失败，绝不截断 |
| `maxChars` | `5000000` | 抽取字符数上限 —— 超出即失败 |
| `maxAnchors` | `500` | 单文档锚点上限（schema 硬上限 500） |
| `pdf.backend` | `builtin` | `builtin`（文本层）、`pdftotext`、`command`（外部，经 `ctx.subprocess`） |
| `pdf.command` | — | `command` 的 argv，必须含 `{input}`（不走 shell） |
| `pdf.timeoutMs` / `pdf.maxOutputBytes` | `30000` / `20971520` | 外部调用上限 |
| `recordDir` | `anchors` | 每份文档的 REP 记录目录（位于 `<root>` 下） |
| `persist` | `true` | 写入快照与记录 |

非法取值会在挂载时直接报错（例如 `maxAnchors > 500`、`recordDir` 中含 `..`）。

## 安全边界

- **路径安全**：`path` 先相对工作区解析，再做 `realpath` 校验；`..`、工作区外的绝对路径、指向工作区外的符号链接一律以 `PATH_ESCAPE` 拒绝。
- **大小与时间**：字节、页数与字符上限在解析前或解析过程中强制执行；超限输入直接失败，而不是被截断。
- **不可信内容**：文档只是数据。脚本、样式与 iframe 会被丢弃，LaTeX 永不展开；出现类似指令的文本时，只会产生一条有界的、仅含元数据的 `prompt_injection_suspected` 警告，行为不变。
- **不联网**：插件从不抓取 URL。远程抓取由 `dsh-cite-verify` / `dsh-research-report` 负责。
- **不执行**：不运行 PDF JavaScript，不展开宏，不访问外部引用，也不解压归档。

## 已知限制（v0.1）

- **扫描版 PDF** 没有文本层 → 内置后端下 `PARSE_FAILED`。可选外部后端是显式逃生门；永不捆绑，失败会报告而不是静默降级。
- **已验证：** 2026-11-10，Ubuntu 24.04 + poppler `pdftotext` 24.02.0，`pdftotext` 与 `command` 两条外部路径，两页合成 PDF → `p.1`/`p.2` 页码锚点；无文本层 PDF 会 fail-closed。OCR 本身未测（本机未安装 OCR 二进制，也不捆绑）。
- **缺少 `ToUnicode` 的 CID 字体** 会渲染成替换字符；每页都会产生一条警告。
- **PDF 表格** 不做重建。
- **HTML** 采用标签扫描，而不是完整的 HTML5 解析器；畸形标记会优雅降级，但可能丢失嵌套结构。
- **LaTeX** 是一个结构化扫描器：不跟进 `\input`，不展开自定义宏，只扁平化常见的文本命令。
- **`.docx` / 归档文件** 按设计拒绝。

## 评测

- **52 个测试 / 4 个文件**：抽取（文本、markdown、HTML、LaTeX、PDF，含 FlateDecode、ToUnicode CMap、多页偏移、加密、页数上限、扫描件，以及文档以块级标签开头时的 HTML 偏移）、运行时（路径逃逸、符号链接逃逸、大小上限、persist=false、记录写入、锚点上限的截断边界与校验、不产生证据冲突的重复锚定、Unicode 大小写不敏感的 locate 偏移）、工具（schema、成功/失败渲染、locate 与 tables 端到端、不支持的 `doc_tables` 输入）、包契约。
- **合成 PDF fixture** 在测试中构建（`test/fixtures/make-pdf.ts`）—— 仓库不提交任何受版权保护的 PDF；“真实世界 PDF 语料”是一个明示的缺口，而不是被声称的结果。
- 本插件**不声称 precision / recall 数字**；它是基础设施。检测器指标属于 `dsh-cite-verify` / `dsh-claim-check` / `dsh-statcheck`。

## 开发

```sh
pnpm install
pnpm run typecheck
pnpm test
pnpm run build
pnpm run verify:package
```

## 许可

Apache-2.0。运行时不含任何第三方代码。
