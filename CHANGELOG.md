# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-11-08

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
- 46 tests across extraction, runtime, tool surface and package contract.

### Known limitations

- No OCR (scanned PDFs fail explicitly), no PDF table reconstruction, no
  `\input` expansion, no DOCX/archive support.
- Real-world PDF corpus is not part of this release; tests use synthetic PDFs.
