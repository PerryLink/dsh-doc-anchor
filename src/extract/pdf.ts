/**
 * Minimal, dependency-free PDF text extraction.
 *
 * This is intentionally not a renderer: it walks the page tree, decodes content
 * streams (`FlateDecode` / `ASCIIHexDecode`), reads text-showing operators and
 * maps glyphs through each font's `ToUnicode` CMap when one exists. It does not
 * execute JavaScript, does not follow external references, and refuses
 * encrypted files instead of guessing.
 *
 * Known limits (reported as warnings, never silently): CID fonts without a
 * `ToUnicode` map render as replacement characters; Type3/embedded fonts with
 * custom encodings may be approximate; tables and figures are not reconstructed.
 *
 * @module dsh-doc-anchor/extract/pdf
 */

import { inflateSync } from 'node:zlib'
import { detectInjection } from './injection.ts'
import { DocParseError, type ExtractedDoc, type ExtractedPage, type ExtractInput } from './types.ts'

/** Options accepted by the PDF backend. */
export interface PdfExtractOptions {
  /** Hard page cap; exceeding it fails instead of truncating. */
  readonly maxPages: number
}

/** One parsed indirect object. */
interface PdfObject {
  readonly num: number
  readonly dict: string
  readonly stream?: Buffer
}

/** A decoded font map. */
interface FontMap {
  /** Glyph code → unicode text. */
  readonly map: ReadonlyMap<number, string>
  /** Code width in bytes (1 or 2). */
  readonly codeBytes: number
  /** True when the map came from a ToUnicode CMap. */
  readonly fromToUnicode: boolean
}

/** Parse `N 0 obj ... endobj` objects (no xref dependency). */
function parseObjects(bytes: Buffer): Map<number, PdfObject> {
  const text = bytes.toString('latin1')
  const objects = new Map<number, PdfObject>()
  const pattern = /(\d+)\s+(\d+)\s+obj\b/gu
  for (const match of text.matchAll(pattern)) {
    const num = Number(match[1])
    const dictStart = match.index + match[0].length
    const endobj = text.indexOf('endobj', dictStart)
    const segmentEnd = endobj === -1 ? text.length : endobj
    const streamKeyword = text.indexOf('stream', dictStart)
    let dict: string
    let stream: Buffer | undefined
    if (streamKeyword !== -1 && streamKeyword < segmentEnd) {
      dict = text.slice(dictStart, streamKeyword)
      let dataStart = streamKeyword + 'stream'.length
      if (text.startsWith('\r\n', dataStart)) dataStart += 2
      else if (text[dataStart] === '\n' || text[dataStart] === '\r') dataStart += 1
      const endStream = text.indexOf('endstream', dataStart)
      const dataEnd = endStream === -1 ? segmentEnd : endStream
      stream = bytes.subarray(dataStart, Math.max(dataStart, dataEnd))
    } else {
      dict = text.slice(dictStart, segmentEnd)
    }
    if (!objects.has(num)) objects.set(num, { num, dict, ...(stream === undefined ? {} : { stream }) })
  }
  return objects
}

/** Decode one stream according to its filters. */
function decodeStream(object: PdfObject, warnings: string[]): Buffer | undefined {
  if (object.stream === undefined) return undefined
  const filter = /\/Filter\s*(\[[^\]]*\]|\/\w+)/u.exec(object.dict)?.[1] ?? ''
  let data = object.stream
  if (filter.includes('FlateDecode')) {
    try {
      data = inflateSync(data, { finishFlush: 2 /* Z_SYNC_FLUSH */ })
    } catch {
      warnings.push('a FlateDecode stream could not be inflated; its text is missing')
      return undefined
    }
  }
  if (filter.includes('ASCIIHexDecode')) {
    const hex = data.toString('latin1').replace(/>.*$/su, '').replace(/[^0-9a-fA-F]/gu, '')
    data = Buffer.from(hex.length % 2 === 0 ? hex : `${hex}0`, 'hex')
  }
  if (filter.includes('ASCII85Decode') || filter.includes('LZWDecode') || filter.includes('RunLengthDecode')) {
    warnings.push(`unsupported stream filter (${filter}); its text is missing`)
    return undefined
  }
  return data
}

/** Find a reference `N 0 R` value for a dictionary key. */
function refFor(dict: string, key: string): number | undefined {
  const pattern = new RegExp(`/${key}\\s+(\\d+)\\s+\\d+\\s+R`, 'u')
  const match = pattern.exec(dict)
  return match === null ? undefined : Number(match[1])
}

/** Resolve an inline `<<...>>` or a referenced object to its dictionary text. */
function resolveDict(dict: string, key: string, objects: ReadonlyMap<number, PdfObject>): string | undefined {
  const pattern = new RegExp(`/${key}\\s*`, 'u')
  const match = pattern.exec(dict)
  if (match === null) return undefined
  const start = match.index + match[0].length
  const ref = /^(\d+)\s+\d+\s+R/u.exec(dict.slice(start))
  if (ref !== null) return objects.get(Number(ref[1]))?.dict
  if (dict.startsWith('<<', start)) {
    let depth = 0
    for (let index = start; index < dict.length - 1; index += 1) {
      if (dict.startsWith('<<', index)) {
        depth += 1
        index += 1
      } else if (dict.startsWith('>>', index)) {
        depth -= 1
        index += 1
        if (depth === 0) return dict.slice(start, index + 1)
      }
    }
  }
  return undefined
}

/** Page object numbers in document order (page tree first, object order as fallback). */
function pagesOf(objects: ReadonlyMap<number, PdfObject>): number[] {
  const pages: number[] = []
  const catalog = [...objects.values()].find(object => /\/Type\s*\/Catalog/u.test(object.dict))
  const root = catalog === undefined ? undefined : refFor(catalog.dict, 'Pages')
  const visit = (num: number, depth: number): void => {
    if (depth > 64) return
    const object = objects.get(num)
    if (object === undefined) return
    if (/\/Type\s*\/Page\b/u.test(object.dict)) {
      pages.push(num)
      return
    }
    const kids = /\/Kids\s*\[([^\]]*)\]/u.exec(object.dict)
    if (kids !== null) {
      for (const ref of kids[1]!.matchAll(/(\d+)\s+\d+\s+R/gu)) visit(Number(ref[1]), depth + 1)
    }
  }
  if (root !== undefined) visit(root, 0)
  if (pages.length === 0) {
    for (const object of objects.values()) {
      if (/\/Type\s*\/Page\b/u.test(object.dict)) pages.push(object.num)
    }
    pages.sort((left, right) => left - right)
  }
  return pages
}

/** Parse a ToUnicode CMap. */
function parseToUnicode(cmap: string): FontMap {
  const map = new Map<number, string>()
  let codeBytes = 1
  const space = /begincodespacerange\s*<([0-9a-fA-F]+)>/u.exec(cmap)
  if (space !== null) codeBytes = Math.max(1, space[1]!.length / 2)

  const hexToText = (hex: string): string => {
    const clean = hex.replace(/[^0-9a-fA-F]/gu, '')
    let out = ''
    for (let index = 0; index + 4 <= clean.length; index += 4) {
      out += String.fromCharCode(Number.parseInt(clean.slice(index, index + 4), 16))
    }
    if (out === '' && clean.length >= 2) out = String.fromCharCode(Number.parseInt(clean.slice(0, 2), 16))
    return out
  }

  for (const block of cmap.matchAll(/beginbfchar([\s\S]*?)endbfchar/gu)) {
    for (const pair of block[1]!.matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/gu)) {
      map.set(Number.parseInt(pair[1]!, 16), hexToText(pair[2]!))
    }
  }
  for (const block of cmap.matchAll(/beginbfrange([\s\S]*?)endbfrange/gu)) {
    const body = block[1]!
    for (const range of body.matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(<([0-9a-fA-F]+)>|\[([^\]]*)\])/gu)) {
      const from = Number.parseInt(range[1]!, 16)
      const to = Number.parseInt(range[2]!, 16)
      if (to - from > 65535) continue
      if (range[4] !== undefined) {
        const base = hexToText(range[4])
        const prefix = base.slice(0, -1)
        const last = base.charCodeAt(base.length - 1)
        for (let code = from; code <= to; code += 1) {
          map.set(code, `${prefix}${String.fromCharCode(last + (code - from))}`)
        }
      } else {
        const items = [...(range[5] ?? '').matchAll(/<([0-9a-fA-F]+)>/gu)].map(item => hexToText(item[1]!))
        for (let code = from; code <= to; code += 1) {
          const target = items[code - from]
          if (target !== undefined) map.set(code, target)
        }
      }
    }
  }
  return { map, codeBytes, fromToUnicode: map.size > 0 }
}

/** Windows-1252 fallback for the 0x80–0x9F range. */
const CP1252: Readonly<Record<number, string>> = {
  0x80: '€', 0x82: '‚', 0x83: 'ƒ', 0x84: '„', 0x85: '…', 0x86: '†', 0x87: '‡',
  0x88: 'ˆ', 0x89: '‰', 0x8a: 'Š', 0x8b: '‹', 0x8c: 'Œ', 0x8e: 'Ž', 0x91: '‘',
  0x92: '’', 0x93: '“', 0x94: '”', 0x95: '•', 0x96: '–', 0x97: '—', 0x98: '˜',
  0x99: '™', 0x9a: 'š', 0x9b: '›', 0x9c: 'œ', 0x9e: 'ž', 0x9f: 'Ÿ',
}

/** Decode one PDF string with the active font map. */
function decodeString(bytes: Buffer, font: FontMap | undefined): string {
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return bytes.subarray(2).toString('utf16le').replace(/\u0000/gu, '')
  }
  if (font !== undefined && font.fromToUnicode) {
    let out = ''
    const width = font.codeBytes
    for (let index = 0; index + width <= bytes.length; index += width) {
      const code = width === 1 ? bytes[index]! : (bytes[index]! << 8) | bytes[index + 1]!
      out += font.map.get(code) ?? ''
    }
    return out
  }
  let out = ''
  for (const byte of bytes) out += CP1252[byte] ?? String.fromCharCode(byte)
  return out
}

/** Read a PDF literal string starting at `(`. */
function readLiteral(content: string, index: number): { bytes: Buffer; next: number } | undefined {
  const out: number[] = []
  let depth = 1
  for (let cursor = index + 1; cursor < content.length; cursor += 1) {
    const char = content[cursor]!
    if (char === '\\') {
      const next = content[cursor + 1]
      cursor += 1
      if (next === undefined) break
      if (next === 'n') out.push(0x0a)
      else if (next === 'r') out.push(0x0d)
      else if (next === 't') out.push(0x09)
      else if (next === 'b') out.push(0x08)
      else if (next === 'f') out.push(0x0c)
      else if (next === '(' || next === ')' || next === '\\') out.push(next.charCodeAt(0))
      else if (next >= '0' && next <= '7') {
        let octal = next
        for (let extra = 0; extra < 2 && content[cursor + 1] !== undefined && /[0-7]/u.test(content[cursor + 1]!); extra += 1) {
          cursor += 1
          octal += content[cursor]
        }
        out.push(Number.parseInt(octal, 8) & 0xff)
      } else if (next === '\n') {
        // line continuation
      } else out.push(next.charCodeAt(0))
      continue
    }
    if (char === '(') {
      depth += 1
      out.push(char.charCodeAt(0))
      continue
    }
    if (char === ')') {
      depth -= 1
      if (depth === 0) return { bytes: Buffer.from(out), next: cursor + 1 }
      out.push(char.charCodeAt(0))
      continue
    }
    out.push(char.charCodeAt(0))
  }
  return undefined
}

/** Extract text-showing content from one page's content stream. */
function extractPageText(
  content: string,
  fonts: ReadonlyMap<string, FontMap>,
  warnings: string[],
): string {
  type Token = { kind: 'name'; value: string } | { kind: 'number'; value: number } | { kind: 'string'; value: Buffer } | { kind: 'array'; items: Token[] }
  const operands: Token[] = []
  let font: FontMap | undefined
  let out = ''
  let usedUnmapped = false

  const newline = (): void => {
    if (out !== '' && !out.endsWith('\n')) out += '\n'
  }
  const space = (): void => {
    if (out !== '' && !/[\s]$/u.test(out)) out += ' '
  }
  const show = (bytes: Buffer): void => {
    if (font === undefined) usedUnmapped = true
    out += decodeString(bytes, font)
  }
  const flushOperator = (operator: string): void => {
    try {
      if (operator === 'Tf') {
        const name = operands.find(token => token.kind === 'name')
        if (name?.kind === 'name') font = fonts.get(name.value.replace(/^\//u, ''))
      } else if (operator === 'Tj' || operator === "'" || operator === '"') {
        if (operator === "'" || operator === '"') newline()
        const string = operands.find(token => token.kind === 'string')
        if (string?.kind === 'string') show(string.value)
      } else if (operator === 'TJ') {
        const array = operands.find(token => token.kind === 'array')
        if (array?.kind === 'array') {
          for (const item of array.items) {
            if (item.kind === 'string') show(item.value)
            else if (item.kind === 'number' && item.value <= -250) space()
          }
        }
      } else if (operator === 'Td' || operator === 'TD') {
        const numbers = operands.filter((token): token is { kind: 'number'; value: number } => token.kind === 'number')
        if (numbers.length >= 2 && Math.abs(numbers[1]!.value) > 0.01) newline()
      } else if (operator === 'Tm') {
        const numbers = operands.filter((token): token is { kind: 'number'; value: number } => token.kind === 'number')
        if (numbers.length >= 6 && Math.abs(numbers[5]!.value) > 0.01) newline()
      } else if (operator === 'T*') {
        newline()
      } else if (operator === 'ET') {
        newline()
      }
    } finally {
      operands.length = 0
    }
  }

  let index = 0
  while (index < content.length) {
    const char = content[index]!
    if (char === '%') {
      const end = content.indexOf('\n', index)
      index = end === -1 ? content.length : end + 1
      continue
    }
    if (char === '(') {
      const literal = readLiteral(content, index)
      if (literal === undefined) break
      operands.push({ kind: 'string', value: literal.bytes })
      index = literal.next
      continue
    }
    if (char === '<' && content[index + 1] !== '<') {
      const end = content.indexOf('>', index)
      if (end === -1) break
      const hex = content.slice(index + 1, end).replace(/[^0-9a-fA-F]/gu, '')
      operands.push({ kind: 'string', value: Buffer.from(hex.length % 2 === 0 ? hex : `${hex}0`, 'hex') })
      index = end + 1
      continue
    }
    if (char === '<' && content[index + 1] === '<') {
      let depth = 0
      let cursor = index
      while (cursor < content.length) {
        if (content.startsWith('<<', cursor)) {
          depth += 1
          cursor += 2
        } else if (content.startsWith('>>', cursor)) {
          depth -= 1
          cursor += 2
          if (depth === 0) break
        } else cursor += 1
      }
      index = cursor
      continue
    }
    if (char === '[') {
      const items: Token[] = []
      let cursor = index + 1
      while (cursor < content.length && content[cursor] !== ']') {
        if (content[cursor] === '(') {
          const literal = readLiteral(content, cursor)
          if (literal === undefined) break
          items.push({ kind: 'string', value: literal.bytes })
          cursor = literal.next
          continue
        }
        if (content[cursor] === '<') {
          const end = content.indexOf('>', cursor)
          if (end === -1) break
          const hex = content.slice(cursor + 1, end).replace(/[^0-9a-fA-F]/gu, '')
          items.push({ kind: 'string', value: Buffer.from(hex.length % 2 === 0 ? hex : `${hex}0`, 'hex') })
          cursor = end + 1
          continue
        }
        const number = /^[+-]?(?:\d+\.?\d*|\.\d+)/u.exec(content.slice(cursor))
        if (number !== null) {
          items.push({ kind: 'number', value: Number(number[0]) })
          cursor += number[0].length
          continue
        }
        cursor += 1
      }
      operands.push({ kind: 'array', items })
      index = cursor + 1
      continue
    }
    const name = /^\/[^\s/<>[\]()]+/u.exec(content.slice(index))
    if (name !== null) {
      operands.push({ kind: 'name', value: name[0] })
      index += name[0].length
      continue
    }
    const number = /^[+-]?(?:\d+\.?\d*|\.\d+)/u.exec(content.slice(index))
    if (number !== null) {
      operands.push({ kind: 'number', value: Number(number[0]) })
      index += number[0].length
      continue
    }
    const operator = /^(?:[A-Za-z*'"]{1,3})/u.exec(content.slice(index))
    if (operator !== null) {
      flushOperator(operator[0])
      index += operator[0].length
      continue
    }
    index += 1
  }

  if (usedUnmapped && /[^\u0000-\u007f]/u.test(out) === false) {
    warnings.push('a page used a font without a ToUnicode map; non-ASCII glyphs may be missing')
  }
  return out
}

/** Read the font maps referenced by one page's resource dictionary. */
function fontsOf(
  pageDict: string,
  objects: ReadonlyMap<number, PdfObject>,
  warnings: string[],
): Map<string, FontMap> {
  const fonts = new Map<string, FontMap>()
  const resources = resolveDict(pageDict, 'Resources', objects)
  if (resources === undefined) return fonts
  const fontDict = resolveDict(resources, 'Font', objects)
  if (fontDict === undefined) return fonts
  for (const entry of fontDict.matchAll(/\/([A-Za-z0-9#+._-]+)\s+(\d+)\s+\d+\s+R/gu)) {
    const fontObject = objects.get(Number(entry[2]))
    if (fontObject === undefined) continue
    const toUnicodeRef = refFor(fontObject.dict, 'ToUnicode')
    if (toUnicodeRef === undefined) continue
    const cmapObject = objects.get(toUnicodeRef)
    if (cmapObject === undefined) continue
    const bytes = decodeStream(cmapObject, warnings)
    if (bytes === undefined) continue
    fonts.set(entry[1]!, parseToUnicode(bytes.toString('latin1')))
  }
  return fonts
}

/**
 * Extract text and page ranges from a PDF.
 * @param input - the PDF bytes.
 * @param options - page cap.
 * @returns the extraction result.
 */
export function extractPdf(input: ExtractInput, options: PdfExtractOptions): ExtractedDoc {
  const text = input.bytes.toString('latin1')
  if (/\/Encrypt\b/u.test(text)) {
    throw new DocParseError('encrypted_pdf', 'the PDF is encrypted; decrypt it before anchoring (this plugin never guesses passwords)')
  }
  const objects = parseObjects(input.bytes)
  if (objects.size === 0) throw new DocParseError('parse_failed', 'no PDF objects found (not a PDF, or a linearized/xref-stream-only file)')
  const pageNumbers = pagesOf(objects)
  if (pageNumbers.length === 0) throw new DocParseError('parse_failed', 'the PDF page tree contains no pages')
  if (pageNumbers.length > options.maxPages) {
    throw new DocParseError('parse_failed', `the PDF has ${pageNumbers.length} pages, the limit is ${options.maxPages}`)
  }

  const warnings: string[] = []
  const parts: string[] = []
  const pages: ExtractedPage[] = []
  let offset = 0
  for (const [index, pageNumber] of pageNumbers.entries()) {
    const page = objects.get(pageNumber)!
    const fonts = fontsOf(page.dict, objects, warnings)
    const contentRefs: number[] = []
    const contentsRef = /\/Contents\s*(\[\s*([^\]]*)\]|(\d+\s+\d+\s+R))/u.exec(page.dict)
    if (contentsRef !== null) {
      // Bracket body (multiple streams) or the single reference itself.
      const refsText = contentsRef[2] ?? contentsRef[1]
      if (refsText !== undefined) {
        for (const ref of refsText.matchAll(/(\d+)\s+\d+\s+R/gu)) contentRefs.push(Number(ref[1]))
      }
    }
    const chunks: string[] = []
    for (const contentRef of contentRefs) {
      const contentObject = objects.get(contentRef)
      if (contentObject === undefined) continue
      const bytes = decodeStream(contentObject, warnings)
      if (bytes !== undefined) chunks.push(bytes.toString('latin1'))
    }
    const pageText = extractPageText(chunks.join('\n'), fonts, warnings)
    if (pageText.trim() === '') warnings.push(`page ${index + 1} produced no text (scanned image or unsupported encoding)`)
    const separator = pages.length === 0 ? '' : '\n\n'
    const start = offset + separator.length
    parts.push(separator, pageText.trim())
    const end = start + pageText.trim().length
    pages.push({ page: index + 1, start, end })
    offset = end
  }

  const joined = parts.join('').replace(/\n{3,}/gu, '\n\n').replace(/^\n+/u, '').replace(/[ \t]+$/gmu, '')
  if (joined.trim() === '') {
    throw new DocParseError(
      'parse_failed',
      'no extractable text: the PDF is probably a scan (OCR is out of scope in v0.1) or uses an unsupported font encoding',
    )
  }
  const injection = detectInjection(joined)
  return {
    text: joined,
    pages: pages.map(page => ({ page: page.page, start: Math.min(page.start, joined.length), end: Math.min(page.end, joined.length) })),
    blocks: [],
    tables: [],
    warnings: [...warnings, ...injection.map(finding => `prompt_injection_suspected: ${finding.description} (${finding.id}); treated as data`)],
    injectionSuspected: injection.length > 0,
  }
}

/** Detect the `%PDF-` magic. */
export function looksLikePdf(bytes: Buffer): boolean {
  return bytes.subarray(0, 1024).toString('latin1').includes('%PDF-')
}
