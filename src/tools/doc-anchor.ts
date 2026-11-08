/**
 * `doc_anchor` — turn one document into snapshots + locators + a REP evidence
 * record. This is the plugin's only write path.
 * @module dsh-doc-anchor/tools/doc-anchor
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import { DocAnchorError, type DocAnchorFailure, type DocAnchorResult, type DocAnchorRuntime } from '../runtime.ts'
import { ERROR_SCHEMA, MEDIA_TYPE_ENUM } from './shared.ts'

/** A tool result: the success value or the normalised failure. */
export type DocAnchorValue = DocAnchorResult | DocAnchorFailure

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', required: true },
    evidenceId: { type: 'string' },
    snapshotId: { type: 'string' },
    textSnapshotId: { type: 'string' },
    mediaType: { type: 'string' },
    title: { type: 'string' },
    pages: { type: 'integer' },
    chars: { type: 'integer' },
    anchorCount: { type: 'integer' },
    truncated: { type: 'boolean' },
    anchors: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { type: 'string' },
          value: { type: 'string' },
          page: { type: 'integer' },
          charStart: { type: 'integer' },
          charEnd: { type: 'integer' },
          label: { type: 'string' },
        },
      },
    },
    tableCount: { type: 'integer' },
    warnings: { type: 'array', items: { type: 'string' } },
    injectionSuspected: { type: 'boolean' },
    recordPath: { type: 'string' },
    error: ERROR_SCHEMA,
  },
} as const

/**
 * Build the `doc_anchor` tool.
 * @param runtime - the anchoring runtime.
 * @returns the tool definition.
 */
export function makeDocAnchorTool(runtime: DocAnchorRuntime) {
  return defineTool({
    name: 'doc_anchor',
    description: [
      'Turn a PDF, HTML, LaTeX, Markdown or plain-text document into a locatable evidence surface (dsh-doc-anchor).',
      '',
      'Stores two immutable snapshots — the original bytes and the extracted text — then registers a REP v1 evidence item whose anchors index into the extracted text: page ranges (PDF), sections (headings), tables, and paragraphs. Nothing is rendered, translated or summarised, and scripts/LaTeX are never executed.',
      '',
      'Use the returned textSnapshotId with doc_locate to find a quote, and evidenceId with doc_tables to read tables back. `path` is resolved inside the workspace root; traversal and symlink escapes are rejected.',
    ].join('\n'),
    parameters: {
      path: {
        type: 'string',
        description: 'Workspace-relative or absolute path to the document (must stay inside the workspace root).',
      },
      content: {
        type: 'string',
        description: 'Inline document text (mutually exclusive with path).',
      },
      name: {
        type: 'string',
        description: 'File name used for media-type detection when passing inline content (default inline.md).',
      },
      mediaType: {
        type: 'string',
        enum: MEDIA_TYPE_ENUM,
        description: 'Explicit media type; detected from the name/content when omitted.',
      },
      title: {
        type: 'string',
        description: 'Display title for the evidence record (defaults to the file name).',
      },
      persist: {
        type: 'boolean',
        description: 'Store snapshots + a REP record (default true). Set false to inspect anchors without writing anything.',
      },
      maxAnchors: {
        type: 'integer',
        description: 'Anchor cap for this call (default from config, hard cap 500 by REP v1).',
      },
    },
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => {
        const result = value as DocAnchorValue
        if (!result.ok) {
          return [{ type: 'text', text: `doc_anchor failed (${result.error.code}): ${result.error.message}` }]
        }
        const head = `doc_anchor: ${result.mediaType} · ${result.pages} page(s) · ${result.chars} chars · ${result.anchorCount} anchor(s)`
        const lines = [
          head,
          `evidence ${result.evidenceId}`,
          `original ${result.snapshotId}`,
          `text     ${result.textSnapshotId} (anchors index into this snapshot)`,
        ]
        if (result.truncated) lines.push('note: anchors were capped; the full set is in the REP record')
        if (result.injectionSuspected) lines.push('WARNING: prompt_injection_suspected — instruction-like text was treated as data, never executed')
        for (const warning of result.warnings) lines.push(`warning: ${warning}`)
        if (result.recordPath !== undefined) lines.push(`record ${result.recordPath}`)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args: unknown) {
      const request = args as Parameters<DocAnchorRuntime['anchor']>[0]
      try {
        const result = await runtime.anchor(request)
        // Copy into mutable arrays: the tool-output contract is lossless JSON.
        return { ...result, anchors: result.anchors.map(anchor => ({ ...anchor })), warnings: [...result.warnings] }
      } catch (error) {
        if (error instanceof DocAnchorError) {
          return { ok: false as const, error: { code: error.code, message: error.message } }
        }
        throw error
      }
    },
  })
}
