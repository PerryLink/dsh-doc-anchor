/**
 * Synthetic PDF builder for tests.
 *
 * These are deliberately minimal PDFs (objects + trailer, no xref table): the
 * extractor scans objects and does not depend on an xref, so the fixture proves
 * the text pipeline without pretending to be a real-world PDF corpus. Real PDFs
 * are listed as a known limitation; no copyrighted PDF is committed.
 * @module test/fixtures/make-pdf
 */

import { deflateSync } from 'node:zlib'

/** One page description. */
export interface PdfPageInput {
  /** Text lines written with `Tj`, one text-positioning step apart. */
  readonly lines: readonly string[]
  /** Compress the content stream with FlateDecode. */
  readonly flate?: boolean
  /** Use a font with a ToUnicode CMap that maps `A` → `Ω`. */
  readonly cmap?: boolean
  /** Emit a page with an empty content stream (a "scan"). */
  readonly empty?: boolean
}

/** Escape a literal PDF string. */
function escapeLiteral(text: string): string {
  return text.replace(/\\/gu, '\\\\').replace(/\(/gu, '\\(').replace(/\)/gu, '\\)')
}

/** Build one page's content stream body. */
function contentFor(page: PdfPageInput): string {
  if (page.empty === true) return ''
  const parts = ['BT', '/F1 12 Tf', '72 720 Td']
  for (const [index, line] of page.lines.entries()) {
    if (index > 0) parts.push('0 -16 Td')
    parts.push(`(${escapeLiteral(line)}) Tj`)
  }
  parts.push('ET')
  return `${parts.join('\n')}\n`
}

/** The ToUnicode CMap used by `cmap: true` fonts. */
const CMAP = [
  '/CIDInit /ProcSet findresource begin',
  '12 dict begin',
  'begincmap',
  '1 begincodespacerange',
  '<00> <FF>',
  'endcodespacerange',
  '1 beginbfchar',
  '<41> <03A9>',
  'endbfchar',
  'endcmap',
  'CMapName currentdict /CMap defineresource pop',
  'end',
  'end',
].join('\n')

/**
 * Build a minimal PDF.
 * @param pages - page descriptions.
 * @param options - `encrypt` adds an `/Encrypt` marker (the extractor must refuse).
 * @returns the PDF bytes.
 */
export function buildPdf(pages: readonly PdfPageInput[], options: { encrypt?: boolean } = {}): Buffer {
  const chunks: string[] = ['%PDF-1.4\n']
  const pageObjectNumbers = pages.map((_, index) => 10 + index)
  const contentObjectNumbers = pages.map((_, index) => 40 + index)
  const fontObjectNumber = 80
  const cmapObjectNumber = 81

  chunks.push(`1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n`)
  chunks.push(
    `2 0 obj\n<< /Type /Pages /Kids [${pageObjectNumbers.map(number => `${number} 0 R`).join(' ')}] /Count ${pages.length} >>\nendobj\n`,
  )
  for (const [index, page] of pages.entries()) {
    const font = page.cmap === true ? `${fontObjectNumber} 0 R` : `${fontObjectNumber} 0 R`
    chunks.push(
      `${pageObjectNumbers[index]} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${font} >> >> /Contents ${contentObjectNumbers[index]} 0 R >>\nendobj\n`,
    )
    const content = Buffer.from(contentFor(page), 'latin1')
    if (page.flate === true) {
      const compressed = deflateSync(content)
      chunks.push(
        `${contentObjectNumbers[index]} 0 obj\n<< /Length ${compressed.byteLength} /Filter /FlateDecode >>\nstream\n${compressed.toString('latin1')}\nendstream\nendobj\n`,
      )
    } else {
      chunks.push(
        `${contentObjectNumbers[index]} 0 obj\n<< /Length ${content.byteLength} >>\nstream\n${content.toString('latin1')}\nendstream\nendobj\n`,
      )
    }
  }
  const usesCmap = pages.some(page => page.cmap === true)
  if (usesCmap) {
    chunks.push(
      `${fontObjectNumber} 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /FixtureCMap /ToUnicode ${cmapObjectNumber} 0 R >>\nendobj\n`,
    )
    chunks.push(
      `${cmapObjectNumber} 0 obj\n<< /Length ${Buffer.byteLength(CMAP)} >>\nstream\n${CMAP}\nendstream\nendobj\n`,
    )
  } else {
    chunks.push(`${fontObjectNumber} 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>\nendobj\n`)
  }
  chunks.push(`trailer\n<< /Root 1 0 R /Size 100${options.encrypt === true ? ' /Encrypt << /Filter /Standard >>' : ''} >>\n%%EOF\n`)
  return Buffer.from(chunks.join(''), 'latin1')
}
