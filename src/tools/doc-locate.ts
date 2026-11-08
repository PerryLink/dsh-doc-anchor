/**
 * `doc_locate` — find a verbatim quote inside an extracted text snapshot and
 * return char offsets (plus the page when the evidence carries page anchors).
 * Read-only: it never writes to the store.
 * @module dsh-doc-anchor/tools/doc-locate
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import { DocAnchorError, type LocateHit, type DocAnchorRuntime } from '../runtime.ts'
import { ERROR_SCHEMA } from './shared.ts'

/** The `doc_locate` canonical value. */
export type DocLocateValue =
  | { readonly ok: true; readonly count: number; readonly hits: readonly LocateHit[] }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } }

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', required: true },
    count: { type: 'integer' },
    hits: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          charStart: { type: 'integer', required: true },
          charEnd: { type: 'integer', required: true },
          quote: { type: 'string', required: true },
          page: { type: 'integer' },
        },
      },
    },
    error: ERROR_SCHEMA,
  },
} as const

/**
 * Build the `doc_locate` tool.
 * @param runtime - the anchoring runtime.
 * @returns the tool definition.
 */
export function makeDocLocateTool(runtime: DocAnchorRuntime) {
  return defineTool({
    name: 'doc_locate',
    description: [
      'Locate a verbatim quote inside a text snapshot produced by doc_anchor (dsh-doc-anchor).',
      '',
      'The match is exact (byte-for-byte after the document was extracted); pass ignoreCase for a case-insensitive search. Offsets index into the extracted text snapshot, so a hit can be re-checked later against the stored bytes. Pass evidenceId to also map hits to page numbers (PDF).',
      '',
      'Returns an empty hit list when the quote does not occur — that is a normal answer, not an error.',
    ].join('\n'),
    parameters: {
      query: { type: 'string', required: true, description: 'The exact text to locate.' },
      evidenceId: { type: 'string', description: 'Evidence id whose textual snapshot should be searched (also enables page mapping).' },
      textSnapshotId: { type: 'string', description: 'The text snapshot to search (sha256:…); defaults to the evidence textextract when evidenceId is given.' },
      maxResults: { type: 'integer', description: 'Maximum hits (default 20).' },
      ignoreCase: { type: 'boolean', description: 'Case-insensitive search (default false).' },
    },
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => {
        const result = value as DocLocateValue
        if (!result.ok) return [{ type: 'text', text: `doc_locate failed (${result.error.code}): ${result.error.message}` }]
        if (result.count === 0) return [{ type: 'text', text: 'doc_locate: 0 hits (the quote does not occur verbatim in the snapshot)' }]
        const lines = [`doc_locate: ${result.count} hit(s)`]
        for (const hit of result.hits.slice(0, 20)) {
          lines.push(`  ${hit.page === undefined ? '' : `p.${hit.page} `}c.${hit.charStart}-${hit.charEnd}  ${JSON.stringify(hit.quote.slice(0, 160))}`)
        }
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args: unknown) {
      const request = args as Parameters<DocAnchorRuntime['locate']>[0]
      try {
        const hits = await runtime.locate(request)
        return { ok: true as const, count: hits.length, hits: hits.map(hit => ({ ...hit })) }
      } catch (error) {
        if (error instanceof DocAnchorError) {
          return { ok: false as const, error: { code: error.code, message: error.message } }
        }
        throw error
      }
    },
  })
}
