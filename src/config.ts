/**
 * Config schema and resolution for `dsh-doc-anchor`.
 *
 * Bounds are validated eagerly so a misconfigured profile fails loud at mount,
 * and every cap is expressed in bytes/chars/pages rather than "reasonable".
 * @module dsh-doc-anchor/config
 */

import path from 'node:path'
import z from '@deepseek-ai/schemastery'

/** Raw plugin config — every field optional. */
export interface Config {
  /** Master switch. `false` mounts no service and no tools. */
  enabled?: boolean
  /** Store/record root, resolved against the harness working directory. */
  root?: string
  /** Workspace root that document paths must stay inside. */
  workspaceRoot?: string
  /** Hard cap on one input document's byte size (100 MiB). */
  maxBytes?: number
  /** Hard page cap for PDFs. */
  maxPages?: number
  /** Hard cap on extracted characters. */
  maxChars?: number
  /** Hard cap on anchors per document (REP evidence caps at 500). */
  maxAnchors?: number
  /** Directory (under `root`) receiving the per-document REP records. */
  recordDir?: string
  /** Persist snapshots + a REP record (default true). */
  persist?: boolean
}

/** Fully resolved config. */
export interface ResolvedConfig {
  readonly enabled: boolean
  readonly root: string
  readonly workspaceRoot: string
  readonly maxBytes: number
  readonly maxPages: number
  readonly maxChars: number
  readonly maxAnchors: number
  readonly recordDir: string
  readonly persist: boolean
}

/** Schemastery schema: the loader validates and fills defaults before `apply`. */
export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true),
  root: z.string().default('.doc-anchor'),
  workspaceRoot: z.string(),
  maxBytes: z.number().default(100 * 1024 * 1024),
  maxPages: z.number().default(500),
  maxChars: z.number().default(5_000_000),
  maxAnchors: z.number().default(500),
  recordDir: z.string().default('anchors'),
  persist: z.boolean().default(true),
})

/** Throw unless the value is a positive safe integer. */
function assertPositiveInt(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive safe integer, got ${String(value)}`)
  }
}

/**
 * Validate raw values and fill explicit defaults.
 * @param config - raw (possibly partial) plugin config.
 * @returns the fully resolved config.
 */
export function resolveConfig(config: Config = {}): ResolvedConfig {
  const root = config.root ?? '.doc-anchor'
  if (typeof root !== 'string' || root.trim() === '') throw new TypeError('root must be a non-empty path')
  const recordDir = config.recordDir ?? 'anchors'
  if (typeof recordDir !== 'string' || recordDir.trim() === '' || recordDir.includes('..')) {
    throw new TypeError('recordDir must be a non-empty relative path without ".."')
  }
  const maxBytes = config.maxBytes ?? 100 * 1024 * 1024
  const maxPages = config.maxPages ?? 500
  const maxChars = config.maxChars ?? 5_000_000
  const maxAnchors = config.maxAnchors ?? 500
  for (const [name, value] of Object.entries({ maxBytes, maxPages, maxChars, maxAnchors })) {
    assertPositiveInt(name, value)
  }
  if (maxAnchors > 500) {
    // The REP v1 Evidence schema caps anchors at 500; a larger config would only
    // produce records that cannot validate.
    throw new TypeError('maxAnchors must be <= 500 (REP v1 Evidence.anchors cap)')
  }
  return {
    enabled: config.enabled ?? true,
    root: path.resolve(root),
    workspaceRoot: path.resolve(config.workspaceRoot ?? process.cwd()),
    maxBytes,
    maxPages,
    maxChars,
    maxAnchors,
    recordDir,
    persist: config.persist ?? true,
  }
}
