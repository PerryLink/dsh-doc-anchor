/**
 * External PDF text extraction: `pdftotext` or a caller-supplied command.
 *
 * The plugin still does not bundle OCR or parsing binaries. It writes the
 * already-read bytes to a private temp file, runs one bounded argv command
 * (no shell), splits stdout on form feeds into pages, and deletes the temp
 * file. Any non-zero exit, timeout or over-cap output fails closed.
 *
 * @module dsh-doc-anchor/extract/pdf-command
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { detectInjection } from './injection.ts'
import { DocParseError, type ExtractedBlock, type ExtractedDoc, type ExtractedPage } from './types.ts'

/** The minimal subprocess seam this module needs. */
export interface SubprocessSeam {
  spawn(spec: {
    argv: readonly string[]
    cwd?: string
    stdio: {
      stdout: { maxBytes: number }
      stderr: { maxBytes: number }
    }
    graceMs?: number
    signal?: AbortSignal
  }): {
    done: Promise<{ exitCode: number | null; signal: string | null }>
    collected: {
      stdout?: { readFrom(offset: number): { text: string; lossy: boolean } }
      stderr?: { readFrom(offset: number): { text: string; lossy: boolean } }
    }
  }
}

/** Options for the external backend. */
export interface PdfCommandOptions {
  readonly backend: 'pdftotext' | 'command'
  readonly command?: string
  readonly timeoutMs: number
  readonly maxOutputBytes: number
}

function splitCommandLine(command: string): string[] {
  return command.trim().split(/\s+/u).filter(part => part !== '')
}

function blocksOf(text: string): ExtractedBlock[] {
  const blocks: ExtractedBlock[] = []
  for (const match of text.matchAll(/[^\n]+(?:\n(?!\n)[^\n]+)*/gu)) {
    const value = match[0].trim()
    if (value === '') continue
    const start = match.index ?? 0
    blocks.push({ kind: 'paragraph', text: value, start, end: start + match[0].length })
  }
  return blocks
}

/**
 * Run one external PDF text extractor over bytes that were already read.
 * @param bytes - the PDF bytes (written to a private temp file).
 * @param options - backend, command, timeout and output cap.
 * @param subprocess - the host subprocess seam.
 * @returns the extracted document with page offsets.
 */
export async function extractPdfWithCommand(
  bytes: Buffer,
  options: PdfCommandOptions,
  subprocess: SubprocessSeam,
): Promise<ExtractedDoc> {
  const dir = await mkdtemp(path.join(tmpdir(), 'doc-anchor-pdf-'))
  const file = path.join(dir, 'input.pdf')
  try {
    await writeFile(file, bytes)
    const argv = options.backend === 'pdftotext'
      ? ['pdftotext', '-layout', file, '-']
      : splitCommandLine(options.command ?? '').map(part => part.replaceAll('{input}', file))
    if (argv.length === 0 || argv[0] === '') {
      throw new DocParseError('parse_failed', 'pdf.backend=command has an empty command')
    }
    const abort = AbortSignal.timeout(options.timeoutMs)
    const handle = subprocess.spawn({
      argv,
      cwd: dir,
      stdio: {
        stdout: { maxBytes: options.maxOutputBytes },
        stderr: { maxBytes: Math.min(options.maxOutputBytes, 256 * 1024) },
      },
      graceMs: 1000,
      signal: abort,
    })
    const outcome = await handle.done
    if (outcome.exitCode !== 0 || outcome.signal !== null) {
      const stderr = handle.collected.stderr?.readFrom(0).text.trim().slice(0, 500) ?? ''
      throw new DocParseError(
        'parse_failed',
        `external PDF backend exited abnormally (exit ${String(outcome.exitCode)}, signal ${String(outcome.signal)})${stderr === '' ? '' : `: ${stderr}`}`,
      )
    }
    const stdout = handle.collected.stdout
    if (stdout === undefined) throw new DocParseError('parse_failed', 'external PDF backend produced no stdout')
    const read = stdout.readFrom(0)
    if (read.lossy) throw new DocParseError('parse_failed', 'external PDF backend output exceeded pdf.maxOutputBytes')
    const rawPages = read.text.replace(/\r\n/gu, '\n').split('\f')
    if (rawPages.length > 1 && (rawPages.at(-1) ?? '').trim() === '') rawPages.pop()
    let text = ''
    const pages: ExtractedPage[] = []
    for (const [index, raw] of rawPages.entries()) {
      const content = raw.replace(/\r/gu, '\n').replace(/\n{3,}/gu, '\n\n').trim()
      if (content === '') {
        pages.push({ page: index + 1, start: text.length, end: text.length })
        continue
      }
      if (text !== '') text += '\n\n'
      const start = text.length
      text += content
      pages.push({ page: index + 1, start, end: text.length })
    }
    if (text.trim() === '') throw new DocParseError('empty_document', 'the external backend extracted no text')
    return {
      text,
      pages,
      blocks: blocksOf(text),
      tables: [],
      warnings: [
        `text extracted by ${options.backend === 'pdftotext' ? 'pdftotext' : 'an external command'}; tables and figures are not reconstructed`,
      ],
      injectionSuspected: detectInjection(text).length > 0,
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}
