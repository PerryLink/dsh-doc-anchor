/**
 * Tool surface: name, parameter schema, canonical value, renderer, and the
 * failure branch — driven through the real tool definitions.
 * @module test/tools.spec
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolveConfig } from '../src/config.ts'
import { DocAnchorRuntime } from '../src/runtime.ts'
import type { DocAnchorValue } from '../src/tools/doc-anchor.ts'
import { makeDocAnchorTool } from '../src/tools/doc-anchor.ts'
import type { DocLocateValue } from '../src/tools/doc-locate.ts'
import { makeDocLocateTool } from '../src/tools/doc-locate.ts'
import type { DocTablesValue } from '../src/tools/doc-tables.ts'
import { makeDocTablesTool } from '../src/tools/doc-tables.ts'

const MARKDOWN = '# Title\n\nThe trial reports t(28) = 2.50 with p = .018.\n'
const HTML = '<html><body><h1>Results</h1><table><tr><th>Group</th><th>n</th></tr><tr><td>Treatment</td><td>30</td></tr></table></body></html>'

let workspace: string

beforeEach(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), 'doc-anchor-tools-'))
  await writeFile(path.join(workspace, 'paper.md'), MARKDOWN, 'utf8')
  await writeFile(path.join(workspace, 'page.html'), HTML, 'utf8')
})

afterEach(async () => {
  if (workspace.startsWith(tmpdir())) await rm(workspace, { recursive: true, force: true })
})

/** Build a runtime over the temp workspace. */
function runtime(): DocAnchorRuntime {
  return new DocAnchorRuntime({
    config: resolveConfig({ workspaceRoot: workspace, root: path.join(workspace, '.doc-anchor') }),
    now: () => new Date('2026-03-01T09:00:00.000Z'),
  })
}

/** The placeholder execution context: these tools only read arguments. */
const EXEC = {} as never

describe('tool interfaces', () => {
  it('declares names, parameter schemas and canonical output schemas', () => {
    const rt = runtime()
    for (const [tool, name] of [
      [makeDocAnchorTool(rt), 'doc_anchor'],
      [makeDocLocateTool(rt), 'doc_locate'],
      [makeDocTablesTool(rt), 'doc_tables'],
    ] as const) {
      expect(tool.name).toBe(name)
      expect(Object.keys(tool.parameters).length).toBeGreaterThan(0)
      expect(tool.output.schema).toBeDefined()
      expect(typeof tool.output.render).toBe('function')
    }
  })

  it('doc_anchor returns a success value and a human-readable render', async () => {
    const tool = makeDocAnchorTool(runtime())
    const value = (await tool.execute({ path: 'paper.md' }, EXEC)) as DocAnchorValue
    expect(value.ok).toBe(true)
    if (!value.ok) throw new Error('expected success')
    expect(value.anchors.some(anchor => anchor.kind === 'section')).toBe(true)
    const blocks = tool.output.render({}, value as never) as Array<{ type: string; text: string }>
    expect(blocks[0]?.type).toBe('text')
    expect(blocks[0]?.text).toContain('doc_anchor')
  })

  it('doc_anchor failure branch carries a stable code', async () => {
    const tool = makeDocAnchorTool(runtime())
    const value = (await tool.execute({ path: 'missing.md' }, EXEC)) as DocAnchorValue
    expect(value.ok).toBe(false)
    if (value.ok) throw new Error('expected failure')
    expect(value.error.code).toBe('NOT_FOUND')
    const blocks = tool.output.render({}, value as never) as Array<{ text: string }>
    expect(blocks[0]?.text).toContain('NOT_FOUND')
  })

  it('doc_locate finds a quote and renders the hit', async () => {
    const rt = runtime()
    const anchor = (await makeDocAnchorTool(rt).execute({ path: 'paper.md' }, EXEC)) as DocAnchorValue
    if (!anchor.ok) throw new Error('anchor failed')
    const tool = makeDocLocateTool(rt)
    const value = (await tool.execute({ evidenceId: anchor.evidenceId, query: 'p = .018' }, EXEC)) as DocLocateValue
    expect(value.ok).toBe(true)
    if (!value.ok) throw new Error('expected success')
    expect(value.count).toBe(1)
    expect(value.hits[0]?.quote).toBe('p = .018')
    expect((tool.output.render({}, value as never) as Array<{ text: string }>)[0]?.text).toContain('1 hit')
  })

  it('doc_tables reads an HTML table back', async () => {
    const rt = runtime()
    const anchor = (await makeDocAnchorTool(rt).execute({ path: 'page.html' }, EXEC)) as DocAnchorValue
    if (!anchor.ok) throw new Error('anchor failed')
    const value = (await makeDocTablesTool(rt).execute({ evidenceId: anchor.evidenceId }, EXEC)) as DocTablesValue
    expect(value.ok).toBe(true)
    if (!value.ok) throw new Error('expected success')
    expect(value.tables[0]?.rows).toEqual([['Treatment', '30']])
  })
})
