/**
 * Shared tool schema fragments.
 * @module dsh-doc-anchor/tools/shared
 */

/** The failure branch shared by every tool. */
export const ERROR_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    code: { type: 'string', required: true },
    message: { type: 'string', required: true },
  },
} as const

/** Media types accepted by `doc_anchor`. */
export const MEDIA_TYPE_ENUM = [
  'application/pdf',
  'text/html',
  'text/x-latex',
  'text/markdown',
  'text/plain',
] as const
