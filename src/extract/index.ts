/**
 * Backend dispatch and media-type detection.
 *
 * Detection trusts an explicit supported media type first, then the file name,
 * then content sniffing. Archives and office containers are rejected loudly:
 * this plugin never unpacks anything (that is where zip bombs live).
 *
 * @module dsh-doc-anchor/extract/index
 */

import { extractHtml } from './html.ts'
import { extractLatex } from './latex.ts'
import { extractPdf, looksLikePdf } from './pdf.ts'
import { extractText } from './text.ts'
import { DocParseError, type ExtractedDoc, type ExtractInput } from './types.ts'

/** Media types this version can turn into text. */
export const SUPPORTED_MEDIA_TYPES = [
  'application/pdf',
  'text/html',
  'application/xhtml+xml',
  'text/x-latex',
  'application/x-tex',
  'text/plain',
  'text/markdown',
] as const

/** Containers that are explicitly rejected (never unpacked). */
const REJECTED_EXTENSIONS: Readonly<Record<string, string>> = {
  docx: 'DOCX is a zip container and is not unpacked here; use dsh-table-ingest for tables or convert to PDF/HTML',
  doc: 'legacy .doc is unsupported; convert to PDF/DOCX/HTML first',
  odt: 'ODT is a zip container and is not unpacked here; convert to PDF/HTML',
  epub: 'EPUB is a zip container and is not unpacked here; convert to HTML first',
  zip: 'zip archives are never unpacked by doc-anchor',
  rar: 'archives are never unpacked by doc-anchor',
  '7z': 'archives are never unpacked by doc-anchor',
  gz: 'compressed files are never unpacked by doc-anchor',
  png: 'images are not text; OCR is out of scope in v0.1',
  jpg: 'images are not text; OCR is out of scope in v0.1',
  jpeg: 'images are not text; OCR is out of scope in v0.1',
  tif: 'images are not text; OCR is out of scope in v0.1',
  tiff: 'images are not text; OCR is out of scope in v0.1',
}

/** Normalize an alias to the canonical REP media type. */
function canonicalMediaType(value: string): string {
  const mediaType = value.toLowerCase().split(';')[0]!.trim()
  if (mediaType === 'application/x-tex' || mediaType === 'application/x-latex' || mediaType === 'text/x-tex') return 'text/x-latex'
  if (mediaType === 'application/xhtml+xml') return 'text/html'
  if (mediaType === 'text/x-markdown' || mediaType === 'text/md') return 'text/markdown'
  return mediaType
}

/** Guess a media type from a file extension. */
export function mediaTypeFromName(name: string): string | undefined {
  const extension = name.toLowerCase().split('.').pop() ?? ''
  switch (extension) {
    case 'pdf':
      return 'application/pdf'
    case 'html':
    case 'htm':
    case 'xhtml':
      return 'text/html'
    case 'tex':
    case 'latex':
    case 'ltx':
      return 'text/x-latex'
    case 'md':
    case 'markdown':
      return 'text/markdown'
    case 'txt':
    case 'text':
      return 'text/plain'
    default:
      return undefined
  }
}

/** Read the extension of a file name (lowercased, without a dot). */
export function extensionOf(name: string): string {
  return name.toLowerCase().split('.').pop() ?? ''
}

/**
 * Resolve the media type of a document.
 * @param bytes - the document bytes.
 * @param name - optional file name.
 * @param declared - optional caller-declared media type.
 * @returns the canonical media type.
 * @throws DocParseError('unsupported_media_type') when it cannot be handled.
 */
export function detectMediaType(bytes: Buffer, name?: string, declared?: string): string {
  if (declared !== undefined && declared.trim() !== '') {
    const canonical = canonicalMediaType(declared)
    if ((SUPPORTED_MEDIA_TYPES as readonly string[]).includes(canonical)) return canonical
  }
  if (name !== undefined) {
    const rejection = REJECTED_EXTENSIONS[extensionOf(name)]
    if (rejection !== undefined) throw new DocParseError('unsupported_media_type', rejection)
    const guessed = mediaTypeFromName(name)
    if (guessed !== undefined) return guessed
  }
  if (looksLikePdf(bytes)) return 'application/pdf'
  const head = bytes.subarray(0, 4096).toString('utf8').trimStart().toLowerCase()
  if (head.startsWith('<!doctype html') || head.startsWith('<html')) return 'text/html'
  const sample = bytes.subarray(0, 16384).toString('utf8')
  if (/\\documentclass|\\begin\{document\}/u.test(sample)) return 'text/x-latex'
  if (!bytes.includes(0)) return 'text/plain'
  throw new DocParseError(
    'unsupported_media_type',
    'cannot determine a supported document type (PDF, HTML, LaTeX, Markdown or plain text are supported)',
  )
}

/** Options for {@link extractDocument}. */
export interface ExtractDocumentOptions {
  /** Hard page cap (PDF). */
  readonly maxPages: number
  /** Hard cap on extracted characters. */
  readonly maxChars: number
}

/**
 * Extract one document.
 * @param input - bytes + media type.
 * @param options - caps.
 * @returns the extraction result.
 * @throws DocParseError on any failure (never a silent empty result).
 */
export function extractDocument(input: ExtractInput, options: ExtractDocumentOptions): ExtractedDoc {
  let doc: ExtractedDoc
  switch (input.mediaType) {
    case 'application/pdf':
      doc = extractPdf(input, { maxPages: options.maxPages })
      break
    case 'text/html':
      doc = extractHtml(input)
      break
    case 'text/x-latex':
      doc = extractLatex(input)
      break
    case 'text/markdown':
      doc = extractText(input, { markdown: true })
      break
    case 'text/plain':
      doc = extractText(input)
      break
    default:
      throw new DocParseError('unsupported_media_type', `unsupported media type ${input.mediaType}`)
  }
  if (doc.text.length > options.maxChars) {
    throw new DocParseError(
      'parse_failed',
      `extracted text is ${doc.text.length} characters, the cap is ${options.maxChars}; refusing to truncate silently`,
    )
  }
  if (doc.text.trim() === '') {
    throw new DocParseError('empty_document', 'the document contains no extractable text')
  }
  return doc
}

export { DocParseError } from './types.ts'
export type { ExtractedBlock, ExtractedDoc, ExtractedPage, ExtractedTable } from './types.ts'
