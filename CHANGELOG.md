# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.1] - 2026-11-08

### Changed

- Release-engineering refresh: CHANGELOG accuracy, package metadata and authors; no runtime changes.

## [0.1.0] - 2026-11-08

### Fixed

- HTML extraction prepended blank lines before the first block tag and then
  trimmed them, shifting every recorded offset; documents starting with
  `<h1>`/`<table>` lost the heading and stored table anchors pointed at the
  wrong text. Empty buffers no longer gain separators and ends are clamped to
  the final text.
- `doc_tables` let a `DocParseError` escape for an unsupported path (e.g.
  `.docx`) instead of returning the documented `{ok:false, error:{code,message}}`.
- `buildAnchors` reported `truncated:false` when page/section/table anchors
  exactly filled the cap and paragraphs were dropped; the drop is now reported.
- Re-anchoring unchanged bytes no longer fails with `STORE_ERROR`: identity
  includes the anchors and retrieval time comes from the immutable snapshot.
- A per-call `maxAnchors` was not validated and could exceed the REP v1 cap or
  be non-positive; it is now validated and clamped to the configured cap.
- `doc_locate` with `ignoreCase` lowercased both strings, so characters whose
  lowercase expands (e.g. `İ`) produced offsets that did not index the original
  text; when folding changes the length it now re-scans with a Unicode-aware
  case-insensitive regex and reports the real match span.

First release: the document → evidence step of the research plugin family.

### Added

- `doc_anchor`: dual content-addressed snapshots (original bytes + extracted
  text), page/section/table/paragraph anchors with exact char offsets, and a
  REP v1 evidence record per document.
- `doc_locate`: verbatim quote search in the extracted text, with PDF page
  mapping when the evidence carries page anchors.
- `doc_tables`: structural HTML `<table>` / LaTeX `tabular` extraction; PDF
  tables explicitly out of scope.
- Zero-dependency extractors: plain text / Markdown (headings, code, pipe
  tables), HTML (tag scanner, entity decoding, no script execution), LaTeX
  (sectioning, text commands, tabular, `\input` not followed), and a minimal PDF
  reader (object scan, FlateDecode, ASCIIHexDecode, ToUnicode CMaps, page tree).
- Path safety (realpath + workspace containment), byte/page/character caps,
  archive rejection, and prompt-injection *flagging* (never execution).
- Local core store fallback when `ctx.researchEvidence` is not mounted.
- 52 tests across extraction, runtime, tool surface and package contract.

### Known limitations

- No OCR (scanned PDFs fail explicitly), no PDF table reconstruction, no
  `\input` expansion, no DOCX/archive support.
- Real-world PDF corpus is not part of this release; tests use synthetic PDFs.
