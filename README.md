# dsh-doc-anchor

**Turn PDF / HTML / LaTeX / Markdown documents into locatable evidence surfaces for DeepSeek Harness.**

*No reader, no renderer, no translation — just coordinates, immutable snapshots, and an evidence record anyone can re-check.*

[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%5E22.19%20%7C%7C%20%3E%3D24.9-brightgreen.svg)]()
[![DSH plugin](https://img.shields.io/badge/dsh--plugin-✅-green)](https://github.com/topics/dsh-plugin)

English · [简体中文](README-zh.md)

---

## What it does

`dsh-doc-anchor` is the **PDF/HTML/LaTeX → evidence** step of the research plugin family. It answers one question: *where exactly in this document does that text live?*

- Two immutable snapshots per document: the **original bytes** and the **extracted text**.
- Locators into the extracted text: **page ranges** (PDF), **sections** (headings), **tables**, **paragraphs**, plus exact char offsets.
- A **REP v1 evidence record** (`@perrylink/dsh-research-core`) so `claim-check`, `cite-verify`, `statcheck` and `research-report` can cite the document without trusting a summary.
- Optional helpers: `doc_locate` (find a verbatim quote), `doc_tables` (read table grids back).

## What it does not do

- **No OCR.** A scanned PDF fails with an explicit `parse_failed`; v0.1 never guesses text from pixels.
- **No PDF table reconstruction.** `doc_tables` says so instead of inventing a grid.
- **No rendering, reading, translating or summarising.** Extracted text is the raw text layer, normalized only in whitespace.
- **No document execution.** `<script>`/`<style>` are dropped, LaTeX macros are never expanded, `\input` files are not followed.
- **No archives.** DOCX/ODT/EPUB/ZIP are rejected by name — nothing is unpacked, so zip bombs have no surface.

## Compatibility

| | |
|---|---|
| DeepSeek Harness | **`dsh-v0.2.1-rc.5`** (verified 2026-11-08); peer line `>=0.2.1-0 <0.3.0 \|\| >=0.2.2-0 <0.3.0` |
| Node | `^22.19.0 \|\| >=24.9.0` (tested on `24.22.1`), ESM only |
| Peers | `@perrylink/dsh-research-core ^0.1.0` (shared protocol), `@deepseek-ai/cordis ^4.0.5-alpha.1`, `@deepseek-ai/dsh-tools`, `@deepseek-ai/schemastery ^3.18.5-alpha.1` |
| Runtime dependencies | **zero** |

The REP core package is a **required peer** (it is the shared protocol, not a sibling feature plugin). Install both:

```sh
dsh plugin --profile <name> add @perrylink/dsh-research-core dsh-doc-anchor
dsh --profile <name> --dump-config | grep -E "dsh-research-core|dsh-doc-anchor"
dsh plugin --profile <name> remove dsh-doc-anchor
```

When `ctx.researchEvidence` is mounted, evidence goes into that store; otherwise the plugin creates its own `EvidenceStore` under `root`, so it also works alone.

## Tools

### `doc_anchor`

Takes `path` **or** `content`.

| Parameter | Type | Notes |
|---|---|---|
| `path` | string | workspace-relative or absolute; must stay inside `workspaceRoot` (traversal + symlink escapes rejected) |
| `content` | string | inline document text (mutually exclusive with `path`) |
| `name` | string | file name for media-type detection with inline content |
| `mediaType` | enum | `application/pdf` · `text/html` · `text/x-latex` · `text/markdown` · `text/plain` |
| `title` | string | evidence title (defaults to the file name) |
| `persist` | boolean | `false` = dry run, no snapshots and no record |
| `maxAnchors` | integer | per-call cap (hard cap 500, REP v1) |

Returns `{ ok, evidenceId, snapshotId, textSnapshotId, mediaType, pages, chars, anchorCount, truncated, anchors[], tableCount, warnings[], injectionSuspected, recordPath }`.

**Anchors index into `textSnapshotId`.** `kind` is `page` (with `page`), `section` (with `label: h1..h6`), `table` (with `value: t.N`), or `paragraph` (with `value: para.N`); every anchor carries `charStart`/`charEnd`.

### `doc_locate`

`{ query, evidenceId?, textSnapshotId?, maxResults?, ignoreCase? }` → `{ ok, count, hits[{charStart, charEnd, quote, page?}] }`.
Exact match against the extracted text; `evidenceId` also maps hits to PDF pages. Zero hits is a normal answer.

### `doc_tables`

`{ evidenceId, maxRows? }` or `{ path, maxRows? }` → `{ ok, count, tables[{index, source, header?, rows, rowsTruncated, charStart, charEnd}], warnings[] }`.
HTML `<table>` and LaTeX `tabular` are parsed structurally; PDF tables report empty with a warning.

### Error codes

`INVALID_INPUT` · `NOT_FOUND` · `NOT_A_FILE` · `PATH_ESCAPE` · `TOO_LARGE` · `PAGE_LIMIT` · `UNSUPPORTED_TYPE` · `PARSE_FAILED` · `EMPTY_DOCUMENT` · `STORE_ERROR` · `EVIDENCE_UNKNOWN`

Every failure is a normalised `{ ok: false, error: { code, message } }` — no exception reaches the model.

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | `false` mounts no tools |
| `root` | `.doc-anchor` | store + records root (workspace-relative) |
| `workspaceRoot` | `process.cwd()` | document paths must resolve inside it |
| `maxBytes` | `104857600` | per-document byte cap (100 MiB) |
| `maxPages` | `500` | PDF page cap — exceeding fails, never truncates |
| `maxChars` | `5000000` | extracted-character cap — exceeding fails |
| `maxAnchors` | `500` | per-document anchor cap (schema hard cap 500) |
| `recordDir` | `anchors` | per-document REP records under `<root>` |
| `persist` | `true` | write snapshots + records |

Invalid values fail loud at mount (e.g. `maxAnchors > 500`, `recordDir` containing `..`).

## Security boundaries

- **Path safety**: `path` is resolved against the workspace, then `realpath`-checked; `..`, absolute paths outside, and symlinks pointing outside are rejected with `PATH_ESCAPE`.
- **Size/time**: byte, page and character caps are enforced before/while parsing; over-limit input fails instead of being truncated.
- **Untrusted content**: documents are data. Scripts/styles/iframes are dropped, LaTeX is never expanded, and instruction-like text raises `prompt_injection_suspected` (bounded, metadata-only warning) without changing behaviour.
- **No network**: the plugin never fetches a URL. Remote capture belongs to `dsh-cite-verify` / `dsh-research-report`.
- **No execution**: no PDF JavaScript, no macros, no external references, no archive extraction.

## Known limitations (v0.1)

- **Scanned PDFs** have no text layer → `PARSE_FAILED`. OCR is planned as an optional external backend, never bundled.
- **CID fonts without `ToUnicode`** render as replacement characters; a warning is emitted per page.
- **PDF tables** are not reconstructed.
- **HTML** is tag-scanned, not a full HTML5 parser; malformed markup degrades gracefully but may lose nested structure.
- **LaTeX** is a structural scanner: `\input` is not followed, custom macros are not expanded, and only common text commands are flattened.
- **`.docx` / archives** are rejected by design.

## Evaluation

- **52 tests / 4 files**: extraction (text, markdown, HTML, LaTeX, PDF incl. FlateDecode, ToUnicode CMap, multi-page offsets, encrypted, page cap, scans, HTML offsets when a document starts with a block tag), runtime (path escapes, symlink escape, size cap, persist=false, records, anchor-cap truncation boundary and validation, re-anchoring without an evidence conflict, Unicode case-insensitive locate offsets), tools (schemas, success/failure renders, end-to-end locate/tables, unsupported `doc_tables` input), package contract.
- **Synthetic PDF fixtures** are built in tests (`test/fixtures/make-pdf.ts`) — no copyrighted PDF is committed, and "real-world PDF corpus" is an explicit gap rather than a claimed result.
- **No precision/recall numbers** are claimed for this plugin; it is infrastructure. Detector metrics belong to `dsh-cite-verify` / `dsh-claim-check` / `dsh-statcheck`.

## Development

```sh
pnpm install
pnpm run typecheck
pnpm test
pnpm run build
pnpm run verify:package
```

## License

Apache-2.0. No third-party runtime code.
