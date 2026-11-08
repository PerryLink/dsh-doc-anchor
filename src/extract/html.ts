/**
 * HTML backend — text and structure only, never execution.
 *
 * The parser is a bounded tag scanner, not a browser: it never runs scripts,
 * never resolves external resources, and ignores `<script>` / `<style>` /
 * `<iframe>` / `<object>` content entirely. Entity references are decoded so
 * quotes and numbers match the rendered text.
 *
 * @module dsh-doc-anchor/extract/html
 */

import { normalizeBlocks } from './blocks.ts'
import { detectInjection } from './injection.ts'
import type { ExtractedBlock, ExtractedDoc, ExtractedTable, ExtractInput } from './types.ts'

/** Tags that end the current line and start a new paragraph. */
const BLOCK_TAGS = new Set([
  'address', 'article', 'aside', 'blockquote', 'div', 'dl', 'fieldset', 'figcaption', 'figure',
  'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'main', 'nav', 'ol',
  'p', 'pre', 'section', 'table', 'ul',
])

/** Tags that only break the line. */
const LINE_TAGS = new Set(['br', 'dd', 'dt', 'li', 'tr'])

/** Elements whose content is dropped entirely. */
const SKIPPED_ELEMENTS = new Set(['script', 'style', 'noscript', 'template', 'svg', 'iframe', 'object', 'embed'])

/** Entities that appear in academic HTML often enough to matter. */
const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: '\u00a0',
  mdash: '—',
  ndash: '–',
  hellip: '…',
  copy: '©',
  reg: '®',
  times: '×',
  plusmn: '±',
  deg: '°',
  middot: '·',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  minus: '−',
  sup2: '²',
  sup3: '³',
  frac12: '½',
}

/**
 * Decode HTML character references.
 * @param text - raw text node.
 * @returns decoded text.
 */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/gu, (whole, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const code = Number.parseInt(body.slice(2), 16)
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole
    }
    if (body.startsWith('#')) {
      const code = Number.parseInt(body.slice(1), 10)
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole
  })
}

/** Incremental text builder: whitespace is normalized as text is appended. */
class TextBuilder {
  text = ''

  /** Current text length (anchor offsets are taken from here). */
  get length(): number {
    return this.text.length
  }

  /** Append text, collapsing whitespace and avoiding duplicate spaces. */
  push(raw: string): void {
    const collapsed = raw.replace(/\s+/gu, ' ')
    if (collapsed === '') return
    if (this.text === '' || /[\s]$/u.test(this.text)) {
      this.text += collapsed.replace(/^ /u, '')
    } else if (collapsed.startsWith(' ')) {
      this.text += collapsed
    } else {
      this.text += collapsed
    }
  }

  /** Ensure the builder ends with at least one newline (no trailing spaces). */
  newline(): void {
    this.text = this.text.replace(/[ \t]+$/u, '')
    if (!this.text.endsWith('\n')) this.text += '\n'
  }

  /** Ensure a blank line separates blocks. */
  blank(): void {
    this.newline()
    if (!this.text.endsWith('\n\n')) this.text += '\n'
  }

  /** Remove leading blank lines (safe: nothing has been anchored yet). */
  trimStart(): void {
    this.text = this.text.replace(/^\n+/u, '')
  }
}

/** One open table. */
interface OpenTable {
  readonly start: number
  readonly rows: string[][]
  headerRow: boolean
  row: string[]
  /** True while every cell of the current row has been a `<th>`. */
  rowAllTh: boolean
  label?: string
}

/**
 * Extract an HTML document.
 * @param input - the document bytes.
 * @returns the extraction result.
 */
export function extractHtml(input: ExtractInput): ExtractedDoc {
  const source = input.bytes.toString('utf8')
  const builder = new TextBuilder()
  const warnings: string[] = []
  const headings: ExtractedBlock[] = []
  const tables: ExtractedTable[] = []
  const openBlocks: Array<{ tag: string; start: number; level?: number }> = []
  let skipDepth = 0
  let skipTag: string | undefined
  let table: OpenTable | undefined
  let captionStart: number | undefined
  let heading: { level: number; start: number } | undefined
  let cursor = 0

  const closeHeading = (): void => {
    if (heading === undefined) return
    const text = builder.text.slice(heading.start).trim()
    if (text !== '') {
      headings.push({ kind: 'heading', level: heading.level, text, start: heading.start, end: builder.length })
    }
    heading = undefined
  }

  const tagPattern = /<([^>]*)>/gu
  for (const match of source.matchAll(tagPattern)) {
    const textNode = source.slice(cursor, match.index)
    cursor = match.index + match[0].length
    if (skipDepth === 0 && textNode !== '') {
      builder.push(decodeEntities(textNode))
      if (table !== undefined && captionStart === undefined) table.row.push(decodeEntities(textNode))
    }

    const raw = match[1] ?? ''
    if (raw.startsWith('!') || raw.startsWith('?')) continue // doctype / processing instruction
    const closing = raw.startsWith('/')
    const nameMatch = /^\s*\/?\s*([a-zA-Z][a-zA-Z0-9-]*)/u.exec(raw)
    if (nameMatch === null) continue
    const tag = nameMatch[1]!.toLowerCase()

    if (skipDepth > 0) {
      if (tag === skipTag) {
        if (closing) skipDepth -= 1
        else if (!raw.endsWith('/')) skipDepth += 1
      }
      continue
    }
    if (SKIPPED_ELEMENTS.has(tag)) {
      if (!closing && !raw.endsWith('/')) {
        skipDepth = 1
        skipTag = tag
        if (tag === 'script' || tag === 'iframe' || tag === 'object') {
          warnings.push(`<${tag}> content ignored (never executed)`)
        }
      }
      continue
    }

    if (closing) {
      if (tag === 'caption' && table !== undefined && captionStart !== undefined) {
        const label = builder.text.slice(captionStart).trim()
        if (label !== '') table.label = label
        captionStart = undefined
        builder.newline()
        continue
      }
      if (BLOCK_TAGS.has(tag)) {
        if (tag.startsWith('h') && /^h[1-6]$/u.test(tag)) closeHeading()
        if (tag === 'table' && table !== undefined) {
          builder.blank()
          const header = table.headerRow ? table.rows[0] : undefined
          tables.push({
            index: tables.length,
            ...(table.label === undefined ? {} : { label: table.label }),
            ...(header === undefined ? {} : { header }),
            rows: (header === undefined ? table.rows : table.rows.slice(1)).map(row => [...row]),
            start: table.start,
            end: builder.length,
            source: 'html-table',
          })
          table = undefined
        }
        builder.blank()
        const open = openBlocks.pop()
        if (open !== undefined && open.tag === tag && open.start < builder.length) {
          const text = builder.text.slice(open.start).trim()
          if (text !== '' && !tag.startsWith('h') && tag !== 'table') {
            headings.push({ kind: tag === 'li' ? 'list-item' : 'paragraph', text, start: open.start, end: builder.length })
          }
        }
      } else if (LINE_TAGS.has(tag)) {
        if (tag === 'tr' && table !== undefined) {
          if (table.rows.length === 0 && table.rowAllTh && table.row.length > 0) table.headerRow = true
          table.rows.push(table.row.map(cell => cell.trim()).filter(cell => cell !== ''))
          table.row = []
          table.rowAllTh = true
          builder.newline()
        }
        builder.newline()
      } else if (tag === 'td' || tag === 'th') {
        if (table !== undefined) table.row.push(' ')
        builder.push(' ')
      }
      continue
    }

    if (tag === 'td' || tag === 'th') {
      if (table !== undefined) {
        if (tag === 'td') table.rowAllTh = false
        table.row.push(' ')
      }
      continue
    }
    if (tag === 'table') {
      builder.blank()
      table = { start: builder.length, rows: [], headerRow: false, row: [], rowAllTh: true }
      continue
    }
    if (tag === 'caption' && table !== undefined) {
      captionStart = builder.length
      continue
    }
    if (BLOCK_TAGS.has(tag)) {
      if (tag.startsWith('h') && /^h[1-6]$/u.test(tag)) {
        builder.blank()
        heading = { level: Number(tag.slice(1)), start: builder.length }
      } else {
        builder.blank()
      }
      openBlocks.push({ tag, start: builder.length })
      continue
    }
    if (LINE_TAGS.has(tag)) {
      builder.newline()
      if (tag === 'li') openBlocks.push({ tag, start: builder.length })
      continue
    }
  }

  // Trailing text after the last tag.
  if (skipDepth === 0) {
    const tail = source.slice(cursor)
    if (tail !== '') builder.push(decodeEntities(tail))
  }
  closeHeading()
  builder.trimStart()

  const text = builder.text.replace(/\n{3,}/gu, '\n\n').replace(/\s+$/u, '\n')
  const tableBlocks = tables.map(item => ({ kind: 'table' as const, text: text.slice(item.start, item.end), start: item.start, end: item.end }))
  const blocks = normalizeBlocks([...headings, ...tableBlocks, ...simpleParagraphs(text)])
  const injection = detectInjection(text)
  if (text.trim() === '') warnings.push('document contains no extractable text')

  return {
    text,
    pages: [],
    blocks,
    tables,
    warnings: [...warnings, ...injection.map(finding => `prompt_injection_suspected: ${finding.description} (${finding.id}); treated as data`)],
    injectionSuspected: injection.length > 0,
  }
}

/** Paragraph blocks for text regions not already covered by a structural block. */
function simpleParagraphs(text: string): ExtractedBlock[] {
  const blocks: ExtractedBlock[] = []
  const pattern = /\n[ \t]*\n+/gu
  let cursor = 0
  const push = (from: number, to: number): void => {
    let start = from
    let end = to
    while (start < end && /\s/u.test(text[start]!)) start += 1
    while (end > start && /\s/u.test(text[end - 1]!)) end -= 1
    if (end > start) blocks.push({ kind: 'paragraph', text: text.slice(start, end), start, end })
  }
  for (const match of text.matchAll(pattern)) {
    push(cursor, match.index)
    cursor = match.index + match[0].length
  }
  push(cursor, text.length)
  return blocks
}
