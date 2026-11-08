/**
 * LaTeX backend — a structural scanner, not a TeX engine.
 *
 * It strips comments and preamble, keeps sectioning as headings, flattens common
 * text commands to their argument, renders `tabular` environments as text
 * grids, and never expands macros, reads `\input`, or runs anything. A
 * paragraph it cannot understand is kept verbatim rather than dropped.
 *
 * @module dsh-doc-anchor/extract/latex
 */

import { normalizeBlocks, normalizeWhitespace, splitParagraphs } from './blocks.ts'
import { detectInjection } from './injection.ts'
import type { ExtractedBlock, ExtractedDoc, ExtractedTable, ExtractInput } from './types.ts'

/** Sectioning commands → heading level. */
const SECTION_LEVELS: Readonly<Record<string, number>> = {
  part: 1,
  chapter: 1,
  section: 2,
  subsection: 3,
  subsubsection: 4,
  paragraph: 5,
  subparagraph: 6,
}

/** Commands whose single braced argument is plain text worth keeping. */
const TEXT_COMMANDS = new Set([
  'emph', 'textbf', 'textit', 'texttt', 'textrm', 'textsf', 'textsc', 'textup', 'textsl',
  'text', 'mbox', 'mathrm', 'mathbf', 'mathit', 'mathsf', 'mathtt', 'underline', 'footnote',
  'caption', 'ensuremath', 'textnormal', 'hspace', 'vspace',
])

/** Commands whose argument should be dropped. */
const DROP_ARG_COMMANDS = new Set([
  'label', 'index', 'includegraphics', 'setlength', 'addtolength', 'pagestyle', 'thispagestyle',
  'bibliographystyle', 'usepackage', 'documentclass', 'bibliography', 'nocite', 'newcommand',
  'renewcommand', 'hypersetup', 'geometry', 'linespread', 'graphicspath', 'urlstyle',
])

/** Citation commands → `[key]`. */
const CITE_COMMANDS = new Set(['cite', 'citep', 'citet', 'parencite', 'textcite', 'autocite', 'footcite'])

/** Reference commands → `key`. */
const REF_COMMANDS = new Set(['ref', 'eqref', 'autoref', 'cref', 'Cref', 'pageref'])

/** Remove `%` comments while keeping escaped `\%`. */
function stripComments(source: string): string {
  return source.replace(/(^|[^\\])%.*$/gmu, '$1')
}

/** Keep only the document body when `\begin{document}` exists. */
function documentBody(source: string): string {
  const begin = source.indexOf('\\begin{document}')
  const end = source.lastIndexOf('\\end{document}')
  if (begin === -1) return source
  const from = begin + '\\begin{document}'.length
  return source.slice(from, end === -1 ? undefined : end)
}

/** Read one braced argument starting at `index` (skipping whitespace). */
function readBraced(source: string, index: number): { content: string; next: number } | undefined {
  let cursor = index
  while (cursor < source.length && /\s/u.test(source[cursor]!)) cursor += 1
  if (source[cursor] === '[') {
    let depth = 1
    let scan = cursor + 1
    while (scan < source.length && depth > 0) {
      if (source[scan] === '[') depth += 1
      else if (source[scan] === ']') depth -= 1
      scan += 1
    }
    cursor = scan
    while (cursor < source.length && /\s/u.test(source[cursor]!)) cursor += 1
  }
  if (source[cursor] !== '{') return undefined
  let depth = 0
  for (let scan = cursor; scan < source.length; scan += 1) {
    const char = source[scan]!
    if (char === '\\') {
      scan += 1
      continue
    }
    if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) return { content: source.slice(cursor + 1, scan), next: scan + 1 }
    }
  }
  return undefined
}

/** Flatten the markup inside an argument (nested commands, math delimiters). */
function flatten(fragment: string): string {
  let text = fragment
  for (const command of TEXT_COMMANDS) {
    const pattern = new RegExp(`\\\\${command}\\*?(?:\\[[^\\]]*\\])?\\{([^{}]*)\\}`, 'gu')
    text = text.replace(pattern, '$1')
  }
  text = text
    .replace(/\\(?:cite|citep|citet|parencite|textcite|autocite|footcite)\*?(?:\[[^\]]*\])?\{([^{}]*)\}/gu, '[$1]')
    .replace(/\\(?:ref|eqref|autoref|cref|Cref|pageref)\{([^{}]*)\}/gu, '$1')
    .replace(/\\[a-zA-Z@]+\*?(?:\[[^\]]*\])?/gu, ' ')
    .replace(/[{}$]/gu, '')
    .replace(/~/gu, ' ')
    .replace(/---/gu, '—')
    .replace(/--/gu, '–')
  return text.replace(/\s+/gu, ' ').trim()
}

/** Parse a `tabular` body into a grid. */
function parseTabular(body: string): string[][] {
  const rows: string[][] = []
  const cleaned = body
    .replace(/\\(?:hline|toprule|midrule|bottomrule|cline\{[^}]*\})\s*/gu, '')
    .replace(/\\multicolumn\{[^}]*\}\{[^}]*\}/gu, '')
  for (const rawRow of cleaned.split(/\\\\/u)) {
    const row = rawRow
      .split('&')
      .map(cell => flatten(cell))
      .filter(cell => cell !== '')
    if (row.length > 0) rows.push(row)
  }
  return rows
}

/** One structural candidate recorded during the scan. */
interface Candidate {
  readonly kind: 'heading' | 'table'
  readonly level?: number
  readonly text: string
  readonly rows?: string[][]
}

/**
 * Extract a LaTeX document.
 * @param input - the document bytes.
 * @returns the extraction result.
 */
export function extractLatex(input: ExtractInput): ExtractedDoc {
  const source = documentBody(stripComments(input.bytes.toString('utf8')))
  const warnings: string[] = []
  const candidates: Candidate[] = []
  let out = ''
  let cursor = 0

  /** Append text with a guaranteed paragraph boundary. */
  const appendBlock = (text: string): void => {
    out = out.replace(/[ \t]+$/u, '')
    if (!out.endsWith('\n\n')) out += out.endsWith('\n') ? '\n' : '\n\n'
    out += text
    out += '\n\n'
  }

  while (cursor < source.length) {
    const char = source[cursor]!
    if (char !== '\\') {
      out += char
      cursor += 1
      continue
    }
    const command = /^\\([a-zA-Z@]+)(\*?)/u.exec(source.slice(cursor))
    if (command === null) {
      if (source[cursor + 1] === '\\') {
        out += '\n'
        cursor += 2
        continue
      }
      const next = source[cursor + 1]
      out += next === '~' ? ' ' : next ?? ''
      cursor += 2
      continue
    }
    const name = command[1]!
    const start = cursor
    const afterName = cursor + command[0].length

    if (name === 'begin') {
      const env = readBraced(source, afterName)
      if (env !== undefined && env.content.trim() === 'tabular') {
        const spec = readBraced(source, env.next)
        const bodyStart = spec?.next ?? env.next
        const end = source.indexOf('\\end{tabular}', bodyStart)
        if (end !== -1) {
          const rows = parseTabular(source.slice(bodyStart, end))
          if (rows.length > 0) {
            const gridText = rows.map(row => row.join(' | ')).join('\n')
            appendBlock(gridText)
            candidates.push({ kind: 'table', text: gridText, rows })
          }
          cursor = end + '\\end{tabular}'.length
          continue
        }
      }
      // Unknown environment: drop the declaration, keep the body.
      cursor = env?.next ?? afterName
      continue
    }

    if (SECTION_LEVELS[name] !== undefined) {
      const argument = readBraced(source, afterName)
      if (argument !== undefined) {
        const title = flatten(argument.content)
        if (title !== '') {
          appendBlock(title)
          candidates.push({ kind: 'heading', level: SECTION_LEVELS[name]!, text: title })
        }
        cursor = argument.next
        continue
      }
    }

    if (CITE_COMMANDS.has(name)) {
      const argument = readBraced(source, afterName)
      if (argument !== undefined) {
        out += `[${flatten(argument.content)}]`
        cursor = argument.next
        continue
      }
    }

    if (REF_COMMANDS.has(name)) {
      const argument = readBraced(source, afterName)
      if (argument !== undefined) {
        out += flatten(argument.content)
        cursor = argument.next
        continue
      }
    }

    if (TEXT_COMMANDS.has(name)) {
      const argument = readBraced(source, afterName)
      if (argument !== undefined) {
        out += flatten(argument.content)
        cursor = argument.next
        continue
      }
    }

    if (DROP_ARG_COMMANDS.has(name)) {
      const argument = readBraced(source, afterName)
      cursor = argument?.next ?? afterName
      continue
    }

    if (name === 'item') {
      out += '\n- '
      cursor = afterName
      continue
    }
    if (name === 'par' || name === 'newline' || name === 'linebreak') {
      out += name === 'par' ? '\n\n' : '\n'
      cursor = afterName
      continue
    }
    if (name === 'href') {
      const url = readBraced(source, afterName)
      const label = url === undefined ? undefined : readBraced(source, url.next)
      if (url !== undefined && label !== undefined) {
        out += flatten(label.content)
        cursor = label.next
        continue
      }
    }

    // Unknown command: keep the following text, drop the command token.
    out += ' '
    cursor = afterName
    if (start === cursor) cursor += 1
  }

  const text = normalizeWhitespace(out.replace(/[ \t]+\n/gu, '\n'))
  const tables: ExtractedTable[] = []
  const structural: ExtractedBlock[] = []
  let searchFrom = 0
  for (const candidate of candidates) {
    const index = text.indexOf(candidate.text, searchFrom)
    if (index === -1) {
      warnings.push(`a ${candidate.kind} could not be re-located in the flattened text`)
      continue
    }
    const end = index + candidate.text.length
    searchFrom = end
    if (candidate.kind === 'heading') {
      structural.push({
        kind: 'heading',
        ...(candidate.level === undefined ? {} : { level: candidate.level }),
        text: candidate.text,
        start: index,
        end,
      })
    } else {
      const rows = candidate.rows ?? []
      tables.push({
        index: tables.length,
        ...(rows[0] === undefined ? {} : { header: rows[0] }),
        rows: rows.slice(1),
        start: index,
        end,
        source: 'latex-tabular',
      })
      structural.push({ kind: 'table', text: candidate.text, start: index, end })
    }
  }

  const paragraphs = splitParagraphs(text)
    .filter(range => !structural.some(block => range.start < block.end && range.end > block.start))
    .map(range => ({ kind: 'paragraph' as const, text: range.text, start: range.start, end: range.end }))

  const injection = detectInjection(text)
  if (text.trim() === '') warnings.push('document contains no extractable text')
  if (/\\input\{/u.test(source)) warnings.push('\\input is not expanded (only the main file is read)')

  return {
    text,
    pages: [],
    blocks: normalizeBlocks([...structural, ...paragraphs]),
    tables,
    warnings: [...warnings, ...injection.map(finding => `prompt_injection_suspected: ${finding.description} (${finding.id}); treated as data`)],
    injectionSuspected: injection.length > 0,
  }
}
