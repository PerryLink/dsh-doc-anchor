/**
 * `doc_tables` — read table grids back out of a document that was anchored
 * before. HTML `<table>` and LaTeX `tabular` are parsed structurally; a PDF
 * reports that table reconstruction is out of scope instead of guessing.
 * @module dsh-doc-anchor/tools/doc-tables
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import { DocAnchorError, type DocAnchorRuntime, type TableSummary } from '../runtime.ts'
import { ERROR_SCHEMA } from './shared.ts'

/** The `doc_tables` canonical value. */
export type DocTablesValue =
  | { readonly ok: true; readonly count: number; readonly tables: readonly TableSummary[]; readonly warnings: readonly string[] }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } }

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', required: true },
    count: { type: 'integer' },
    tables: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          index: { type: 'integer', required: true },
          source: { type: 'string', required: true },
          header: { type: 'array', items: { type: 'string' } },
          rows: { type: 'array', items: { type: 'array', items: { type: 'string' } }, required: true },
          rowsTruncated: { type: 'boolean' },
          charStart: { type: 'integer' },
          charEnd: { type: 'integer' },
        },
      },
    },
    warnings: { type: 'array', items: { type: 'string' } },
    error: ERROR_SCHEMA,
  },
} as const

/**
 * Build the `doc_tables` tool.
 * @param runtime - the anchoring runtime.
 * @returns the tool definition.
 */
export function makeDocTablesTool(runtime: DocAnchorRuntime) {
  return defineTool({
    name: 'doc_tables',
    description: [
      'Read the table grids of a document (dsh-doc-anchor).',
      '',
      'Accepts a stored evidenceId (the original bytes are re-read and re-extracted) or a workspace path. HTML tables and LaTeX tabular environments are parsed structurally; plain-text/markdown grids use pipe/tab heuristics; PDF tables are NOT reconstructed in v0.1 (the result is empty with a warning, never a guess).',
      '',
      'Rows are capped per table; rowsTruncated tells you when a grid was cut.',
    ].join('\n'),
    parameters: {
      evidenceId: { type: 'string', description: 'Evidence id returned by doc_anchor (mutually exclusive with path).' },
      path: { type: 'string', description: 'Workspace-relative or absolute document path (mutually exclusive with evidenceId).' },
      maxRows: { type: 'integer', description: 'Maximum data rows per table (default 200).' },
    },
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => {
        const result = value as DocTablesValue
        if (!result.ok) return [{ type: 'text', text: `doc_tables failed (${result.error.code}): ${result.error.message}` }]
        if (result.count === 0) {
          return [{ type: 'text', text: `doc_tables: no tables found${result.warnings.length > 0 ? ` (${result.warnings[0]})` : ''}` }]
        }
        const lines = [`doc_tables: ${result.count} table(s)`]
        for (const table of result.tables.slice(0, 10)) {
          lines.push(`  t.${table.index + 1} [${table.source}] ${table.rows.length} row(s)${table.rowsTruncated ? ' (truncated)' : ''}`)
          if (table.header !== undefined) lines.push(`    header: ${table.header.join(' | ')}`)
        }
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args: unknown) {
      const request = args as Parameters<DocAnchorRuntime['tables']>[0]
      try {
        const result = await runtime.tables(request)
        const warnings = [...result.warnings]
        if (result.tables.length === 0) warnings.push('no tables were reconstructed (PDF tables are out of scope in v0.1)')
        const tables = result.tables.map(table => ({
          index: table.index,
          source: table.source,
          ...(table.header === undefined ? {} : { header: [...table.header] }),
          rows: table.rows.map(row => [...row]),
          rowsTruncated: table.rowsTruncated,
          charStart: table.charStart,
          charEnd: table.charEnd,
        }))
        return { ok: true as const, count: tables.length, tables, warnings }
      } catch (error) {
        if (error instanceof DocAnchorError) {
          return { ok: false as const, error: { code: error.code, message: error.message } }
        }
        throw error
      }
    },
  })
}
