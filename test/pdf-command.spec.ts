/**
 * External PDF backend: config validation, two-page extraction, fail-closed.
 * @module test/pdf-command.spec
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolveConfig } from '../src/config.ts'
import { DocParseError } from '../src/extract/types.ts'
import { extractPdfWithCommand, type SubprocessSeam } from '../src/extract/pdf-command.ts'
import { DocAnchorRuntime } from '../src/runtime.ts'

let workspace: string

beforeEach(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), 'doc-anchor-pdf-command-'))
})

afterEach(async () => {
  if (workspace.startsWith(tmpdir())) await rm(workspace, { recursive: true, force: true })
})

function fakeSubprocess(options: { text: string; exitCode?: number; lossy?: boolean }): {
  subprocess: SubprocessSeam
  calls: Array<{ argv: readonly string[] }>
} {
  const calls: Array<{ argv: readonly string[] }> = []
  const subprocess: SubprocessSeam = {
    spawn(spec) {
      calls.push({ argv: spec.argv })
      return {
        done: Promise.resolve({ exitCode: options.exitCode ?? 0, signal: null }),
        collected: {
          stdout: { readFrom: () => ({ text: options.text, lossy: options.lossy ?? false }) },
          stderr: { readFrom: () => ({ text: options.exitCode === undefined || options.exitCode === 0 ? '' : 'boom', lossy: false }) },
        },
      }
    },
  }
  return { subprocess, calls }
}

describe('pdf backend config', () => {
  it('defaults to builtin and validates the command placeholder', () => {
    expect(resolveConfig({}).pdf.backend).toBe('builtin')
    expect(resolveConfig({ pdf: { backend: 'pdftotext' } }).pdf.backend).toBe('pdftotext')
    expect(() => resolveConfig({ pdf: { backend: 'command' } })).toThrow(/pdf.command/u)
    expect(() => resolveConfig({ pdf: { backend: 'command', command: 'ocr' } })).toThrow(/\{input\}/u)
    expect(resolveConfig({ pdf: { backend: 'command', command: 'ocr {input}' } }).pdf.command).toBe('ocr {input}')
  })
})

describe('extractPdfWithCommand', () => {
  it('splits stdout on form feeds into pages', async () => {
    const { subprocess, calls } = fakeSubprocess({ text: 'page one\n\nsecond line\fpage two' })
    const doc = await extractPdfWithCommand(Buffer.from('%PDF-1.4'), {
      backend: 'pdftotext',
      timeoutMs: 5000,
      maxOutputBytes: 1024 * 1024,
    }, subprocess)
    expect(calls[0]?.argv[0]).toBe('pdftotext')
    expect(doc.pages).toHaveLength(2)
    expect(doc.pages[0]).toMatchObject({ page: 1, start: 0 })
    expect(doc.text).toContain('page one')
    expect(doc.text).toContain('page two')
    expect(doc.warnings[0]).toContain('tables and figures are not reconstructed')
  })

  it('substitutes {input} in a custom command', async () => {
    const { subprocess, calls } = fakeSubprocess({ text: 'one page' })
    await extractPdfWithCommand(Buffer.from('%PDF-1.4'), {
      backend: 'command',
      command: 'my-ocr --file {input}',
      timeoutMs: 5000,
      maxOutputBytes: 1024,
    }, subprocess)
    expect(calls[0]?.argv[0]).toBe('my-ocr')
    expect(calls[0]?.argv[2]).toMatch(/input\.pdf$/u)
  })

  it('fails closed on a non-zero exit or lossy output', async () => {
    const failing = fakeSubprocess({ text: '', exitCode: 2 })
    await expect(extractPdfWithCommand(Buffer.from('%PDF-1.4'), { backend: 'pdftotext', timeoutMs: 5000, maxOutputBytes: 1024 }, failing.subprocess))
      .rejects.toBeInstanceOf(DocParseError)
    const lossy = fakeSubprocess({ text: 'x', lossy: true })
    await expect(extractPdfWithCommand(Buffer.from('%PDF-1.4'), { backend: 'pdftotext', timeoutMs: 5000, maxOutputBytes: 1024 }, lossy.subprocess))
      .rejects.toThrow(/maxOutputBytes/u)
  })
})

describe('runtime integration', () => {
  it('anchors pages produced by the external backend', async () => {
    await writeFile(path.join(workspace, 'paper.pdf'), '%PDF-1.4\nfake body', 'utf8')
    const { subprocess } = fakeSubprocess({ text: 'first page text\fsecond page text' })
    const runtime = new DocAnchorRuntime({
      config: resolveConfig({
        workspaceRoot: workspace,
        root: path.join(workspace, '.doc-anchor'),
        pdf: { backend: 'pdftotext' },
      }),
      subprocess,
    })
    const result = await runtime.anchor({ path: 'paper.pdf', persist: false })
    expect(result.mediaType).toBe('application/pdf')
    expect(result.pages).toBe(2)
    expect(result.anchors.some(anchor => anchor.kind === 'page' && anchor.value === 'p.2')).toBe(true)
  })

  it('fails when an external backend is configured without ctx.subprocess', async () => {
    await writeFile(path.join(workspace, 'paper.pdf'), '%PDF-1.4\nfake body', 'utf8')
    const runtime = new DocAnchorRuntime({
      config: resolveConfig({ workspaceRoot: workspace, pdf: { backend: 'pdftotext' } }),
    })
    await expect(runtime.anchor({ path: 'paper.pdf', persist: false })).rejects.toMatchObject({ code: 'PARSE_FAILED' })
  })
})
