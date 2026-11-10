/**
 * Real external-backend check (skipped when `pdftotext` is not installed).
 *
 * This is the test that fake subprocesses cannot replace: a real PDF goes
 * through the real binary, and the runtime must produce page anchors from the
 * form-feed-separated stdout.
 *
 * @module test/pdf-command-real.spec
 */

import { spawn, spawnSync } from 'node:child_process'
import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolveConfig } from '../src/config.ts'
import { extractPdfWithCommand, type SubprocessSeam } from '../src/extract/pdf-command.ts'
import { DocParseError } from '../src/extract/types.ts'
import { DocAnchorRuntime } from '../src/runtime.ts'

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'two-pages.pdf')
const HAS_PDFTOTEXT = spawnSync('pdftotext', ['-v'], { stdio: 'ignore' }).status === 0

/** A real subprocess seam over `child_process.spawn` (no caps: the fixture is tiny). */
function realSeam(): SubprocessSeam {
  return {
    spawn(spec) {
      const child = spawn(spec.argv[0]!, spec.argv.slice(1), {
        ...(spec.cwd === undefined ? {} : { cwd: spec.cwd }),
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', chunk => { stdout += String(chunk) })
      child.stderr.on('data', chunk => { stderr += String(chunk) })
      return {
        done: new Promise(resolve => child.on('close', (exitCode, signal) => resolve({ exitCode, signal }))),
        collected: {
          stdout: { readFrom: () => ({ text: stdout, lossy: false }) },
          stderr: { readFrom: () => ({ text: stderr, lossy: false }) },
        },
      }
    },
  }
}

let workspace: string

beforeEach(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), 'doc-anchor-real-pdf-'))
})

afterEach(async () => {
  if (workspace.startsWith(tmpdir())) await rm(workspace, { recursive: true, force: true })
})

describe.skipIf(!HAS_PDFTOTEXT)('real pdftotext backend', () => {
  it('extracts two pages from a real PDF without a fake subprocess', async () => {
    const bytes = await readFile(FIXTURE)
    const doc = await extractPdfWithCommand(bytes, {
      backend: 'pdftotext',
      timeoutMs: 20_000,
      maxOutputBytes: 1024 * 1024,
    }, realSeam())
    expect(doc.pages).toHaveLength(2)
    expect(doc.text).toContain('Alpha page one')
    expect(doc.text).toContain('Beta page two')
    expect(doc.warnings.join(' ')).toContain('tables and figures are not reconstructed')
  })

  it('runs a real custom command with the {input} placeholder', async () => {
    const bytes = await readFile(FIXTURE)
    const doc = await extractPdfWithCommand(bytes, {
      backend: 'command',
      command: 'pdftotext -layout {input} -',
      timeoutMs: 20_000,
      maxOutputBytes: 1024 * 1024,
    }, realSeam())
    expect(doc.pages).toHaveLength(2)
    expect(doc.warnings[0]).toContain('an external command')
  })

  it('fails closed when the real binary rejects a malformed PDF', async () => {
    await expect(extractPdfWithCommand(Buffer.from('%PDF-1.4\nthis is not a real pdf'), {
      backend: 'pdftotext',
      timeoutMs: 20_000,
      maxOutputBytes: 1024 * 1024,
    }, realSeam())).rejects.toBeInstanceOf(DocParseError)
  })

  it('fails closed on a PDF with no text layer (the scanned-PDF case)', async () => {
    const bytes = await readFile(path.join(path.dirname(FIXTURE), 'no-text.pdf'))
    await expect(extractPdfWithCommand(bytes, {
      backend: 'pdftotext',
      timeoutMs: 20_000,
      maxOutputBytes: 1024 * 1024,
    }, realSeam())).rejects.toMatchObject({ code: 'empty_document' })
  })

  it('anchors pages through the runtime with a real subprocess', async () => {
    const pdf = path.join(workspace, 'paper.pdf')
    await copyFile(FIXTURE, pdf)
    const runtime = new DocAnchorRuntime({
      config: resolveConfig({
        workspaceRoot: workspace,
        root: path.join(workspace, '.doc-anchor'),
        pdf: { backend: 'pdftotext' },
      }),
      subprocess: realSeam(),
    })
    const result = await runtime.anchor({ path: 'paper.pdf', persist: false })
    expect(result.mediaType).toBe('application/pdf')
    expect(result.pages).toBe(2)
    expect(result.anchors.some(anchor => anchor.kind === 'page' && anchor.value === 'p.1')).toBe(true)
    expect(result.anchors.some(anchor => anchor.kind === 'page' && anchor.value === 'p.2')).toBe(true)
  })
})
