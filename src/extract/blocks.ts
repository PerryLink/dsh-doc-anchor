/**
 * Block/offset helpers shared by the text, HTML and LaTeX backends.
 *
 * Every offset indexes into the extracted text, so blocks must be computed on
 * the final text — never on an intermediate buffer.
 *
 * @module dsh-doc-anchor/extract/blocks
 */

import type { ExtractedBlock } from './types.ts'

/** A trimmed paragraph and its offsets in the document text. */
export interface ParagraphRange {
  readonly start: number
  readonly end: number
  readonly text: string
}

/**
 * Split text into paragraphs on blank lines, trimming each paragraph and
 * adjusting its offsets accordingly.
 * @param text - the extracted document text.
 * @returns paragraph ranges in document order.
 */
export function splitParagraphs(text: string): ParagraphRange[] {
  const ranges: ParagraphRange[] = []
  const separator = /\n[ \t]*\n+/gu
  let cursor = 0
  const push = (from: number, to: number): void => {
    let start = from
    let end = to
    while (start < end && /\s/u.test(text[start]!)) start += 1
    while (end > start && /\s/u.test(text[end - 1]!)) end -= 1
    if (end > start) ranges.push({ start, end, text: text.slice(start, end) })
  }
  for (const match of text.matchAll(separator)) {
    push(cursor, match.index)
    cursor = match.index + match[0].length
  }
  push(cursor, text.length)
  return ranges
}

/**
 * Sort blocks by position and drop any block that overlaps an earlier one
 * (headings win over the paragraph they were carved out of).
 * @param blocks - candidate blocks.
 * @returns the non-overlapping blocks in document order.
 */
export function normalizeBlocks(blocks: readonly ExtractedBlock[]): ExtractedBlock[] {
  const sorted = [...blocks].filter(block => block.end > block.start).sort((left, right) => left.start - right.start)
  const kept: ExtractedBlock[] = []
  for (const block of sorted) {
    const previous = kept.at(-1)
    if (previous !== undefined && block.start < previous.end) continue
    kept.push(block)
  }
  return kept
}

/**
 * Collapse runs of 3+ newlines to a single blank line and trim trailing spaces.
 * Offsets are computed AFTER this normalization, so callers must apply it before
 * deriving blocks.
 * @param text - the raw extracted text.
 * @returns the normalized text.
 */
export function normalizeWhitespace(text: string): string {
  return text
    .replace(/\r\n?/gu, '\n')
    .replace(/[ \t]+$/gmu, '')
    .replace(/\n{3,}/gu, '\n\n')
    .replace(/^\n+/u, '')
    .replace(/\n+$/u, '\n')
}

/**
 * Build paragraph blocks for text that has no richer structure.
 * @param text - the normalized document text.
 * @returns paragraph blocks.
 */
export function paragraphBlocks(text: string): ExtractedBlock[] {
  return splitParagraphs(text).map(range => ({
    kind: 'paragraph' as const,
    text: range.text,
    start: range.start,
    end: range.end,
  }))
}

/**
 * Find markdown ATX headings.
 * @param text - the document text.
 * @returns heading blocks.
 */
export function markdownHeadings(text: string): ExtractedBlock[] {
  const blocks: ExtractedBlock[] = []
  const pattern = /^(#{1,6})[ \t]+(.+?)[ \t]*#*$/gmu
  for (const match of text.matchAll(pattern)) {
    const heading = match[2]?.trim()
    if (heading === undefined || heading === '') continue
    const start = match.index
    blocks.push({
      kind: 'heading',
      level: match[1]!.length,
      text: heading,
      start,
      end: start + match[0].length,
    })
  }
  return blocks
}

/**
 * Find fenced code blocks.
 * @param text - the document text.
 * @returns code blocks.
 */
export function markdownCodeBlocks(text: string): ExtractedBlock[] {
  const blocks: ExtractedBlock[] = []
  const pattern = /^```[^\n]*\n([\s\S]*?)^```[ \t]*$/gmu
  for (const match of text.matchAll(pattern)) {
    const start = match.index
    const end = start + match[0].length
    blocks.push({ kind: 'code', text: match[1]?.trimEnd() ?? '', start, end })
  }
  return blocks
}

/**
 * Parse a GitHub-flavored markdown pipe table into a grid.
 * @param lines - the table's lines.
 * @returns rows of cells, or undefined when the block is not a table.
 */
export function parsePipeTable(lines: readonly string[]): string[][] | undefined {
  const rows = lines
    .filter(line => line.trim().startsWith('|'))
    .map(line => line.trim().replace(/^\|/u, '').replace(/\|$/u, '').split('|').map(cell => cell.trim()))
  if (rows.length < 2) return undefined
  const separatorIndex = rows.findIndex(row => row.every(cell => /^:?-{2,}:?$/u.test(cell)))
  if (separatorIndex === -1) return undefined
  return rows.filter((_, index) => index !== separatorIndex)
}
