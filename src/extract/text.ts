/**
 * Plain-text and Markdown backend.
 *
 * The extracted text is the input text itself (CRLF normalized, BOM dropped),
 * so a char anchor computed here indexes the stored `text/plain` snapshot
 * exactly. Markdown adds heading/code blocks and pipe tables on top.
 *
 * @module dsh-doc-anchor/extract/text
 */

import {
  markdownCodeBlocks,
  markdownHeadings,
  normalizeBlocks,
  normalizeWhitespace,
  paragraphBlocks,
  parsePipeTable,
  splitParagraphs,
} from './blocks.ts'
import { detectInjection } from './injection.ts'
import type { ExtractedDoc, ExtractedTable, ExtractInput } from './types.ts'

/**
 * Extract a plain-text or Markdown document.
 * @param input - the document bytes.
 * @param options - `markdown: true` enables heading/code/table parsing.
 * @returns the extraction result.
 */
export function extractText(input: ExtractInput, options: { markdown?: boolean } = {}): ExtractedDoc {
  const raw = input.bytes.toString('utf8').replace(/^\uFEFF/u, '')
  const text = normalizeWhitespace(raw)
  const warnings: string[] = []

  if (text.trim() === '') {
    return { text, pages: [], blocks: [], tables: [], warnings: ['document contains no text'], injectionSuspected: false }
  }

  const injections = detectInjection(text)
  warnings.push(...injections.map(finding => `prompt_injection_suspected: ${finding.description} (${finding.id}); treated as data`))
  const tables: ExtractedTable[] = []
  const structural = options.markdown === true ? [...markdownHeadings(text), ...markdownCodeBlocks(text)] : []
  if (options.markdown === true) {
    // Pipe tables: group consecutive table-looking lines.
    const lines = text.split('\n')
    let offset = 0
    let group: Array<{ line: string; start: number }> = []
    const flush = (): void => {
      if (group.length >= 2) {
        const grid = parsePipeTable(group.map(item => item.line))
        if (grid !== undefined) {
          tables.push({
            index: tables.length,
            ...(grid[0] === undefined ? {} : { header: grid[0] }),
            rows: grid.slice(1),
            start: group[0]!.start,
            end: group.at(-1)!.start + group.at(-1)!.line.length,
            source: 'text-grid',
          })
        }
      }
      group = []
    }
    for (const line of lines) {
      if (line.trim().startsWith('|') || (group.length > 0 && line.includes('|'))) {
        group.push({ line, start: offset })
      } else {
        flush()
      }
      offset += line.length + 1
    }
    flush()
    if (tables.length === 0) {
      const paragraphs = splitParagraphs(text)
      const tabSeparated = paragraphs.filter(paragraph => paragraph.text.includes('\t') && paragraph.text.split('\n').length >= 2)
      for (const paragraph of tabSeparated) {
        const rows = paragraph.text.split('\n').map(row => row.split('\t').map(cell => cell.trim()))
        if (rows.length >= 2) {
          tables.push({
            index: tables.length,
            ...(rows[0] === undefined ? {} : { header: rows[0] }),
            rows: rows.slice(1),
            start: paragraph.start,
            end: paragraph.end,
            source: 'text-grid',
          })
        }
      }
    }
  }

  const tableBlocks = tables.map(table => ({
    kind: 'table' as const,
    text: text.slice(table.start, table.end),
    start: table.start,
    end: table.end,
  }))
  const blocks = normalizeBlocks([...structural, ...tableBlocks, ...paragraphBlocks(text)])

  return {
    text,
    pages: [],
    blocks,
    tables,
    warnings,
    injectionSuspected: injections.length > 0,
  }
}
