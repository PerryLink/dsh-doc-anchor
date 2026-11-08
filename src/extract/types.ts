/**
 * Extraction vocabulary shared by every backend.
 *
 * All offsets index into `ExtractedDoc.text` — the exact text that is stored as
 * the `text/plain` snapshot. That is what makes an anchor re-checkable: the
 * snapshot bytes are immutable and the offsets point into them.
 *
 * @module dsh-doc-anchor/extract/types
 */

/** One extracted table. */
export interface ExtractedTable {
  /** Zero-based table index in document order. */
  readonly index: number
  /** Optional caption/label (`<caption>`, `\caption{}`). */
  readonly label?: string
  /** Header row when the source distinguishes one. */
  readonly header?: readonly string[]
  /** Data rows. */
  readonly rows: readonly (readonly string[])[]
  /** Char offset of the table's text inside `ExtractedDoc.text`. */
  readonly start: number
  /** Char offset of the table's end inside `ExtractedDoc.text`. */
  readonly end: number
  /** Which backend produced it. */
  readonly source: 'html-table' | 'latex-tabular' | 'text-grid'
}

/** One structural block. */
export interface ExtractedBlock {
  readonly kind: 'heading' | 'paragraph' | 'list-item' | 'table' | 'code'
  /** Heading level (1–6) for `heading`. */
  readonly level?: number
  /** Block text, trimmed. */
  readonly text: string
  /** Char offset of the block inside `ExtractedDoc.text`. */
  readonly start: number
  /** Char offset just past the block inside `ExtractedDoc.text`. */
  readonly end: number
}

/** One page range (PDF only). */
export interface ExtractedPage {
  /** 1-based page number. */
  readonly page: number
  /** Char offset where the page text starts. */
  readonly start: number
  /** Char offset just past the page text. */
  readonly end: number
}

/** The canonical extraction result. */
export interface ExtractedDoc {
  /** Extracted text — stored verbatim as the `text/plain` snapshot. */
  readonly text: string
  /** Page ranges (PDF); empty for other formats. */
  readonly pages: readonly ExtractedPage[]
  /** Structural blocks in document order. */
  readonly blocks: readonly ExtractedBlock[]
  /** Tables in document order. */
  readonly tables: readonly ExtractedTable[]
  /** Honest warnings about degraded extraction (never errors when text exists). */
  readonly warnings: readonly string[]
  /** True when the content contains prompt-injection-like text (data, never executed). */
  readonly injectionSuspected: boolean
}

/** Stable parse failure codes. */
export type DocParseErrorCode =
  | 'parse_failed'
  | 'encrypted_pdf'
  | 'unsupported_media_type'
  | 'empty_document'
  | 'corrupt_document'

/** A parse failure with a stable code. */
export class DocParseError extends Error {
  /** The stable code. */
  readonly code: DocParseErrorCode

  constructor(code: DocParseErrorCode, message: string) {
    super(message)
    this.name = 'DocParseError'
    this.code = code
  }
}

/** Input handed to one backend. */
export interface ExtractInput {
  /** The original document bytes. */
  readonly bytes: Buffer
  /** Detected or declared media type. */
  readonly mediaType: string
  /** Optional original file name (used for warnings only). */
  readonly name?: string
}
