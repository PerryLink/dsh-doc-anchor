/**
 * `dsh-doc-anchor` — turn documents into locatable evidence surfaces.
 *
 * Three tools, one job: PDF / HTML / LaTeX / Markdown / text → immutable
 * snapshots (original bytes + extracted text) + page/section/table/paragraph
 * anchors + a REP v1 evidence record. It never renders, reads, summarises or
 * executes the document; scripts and LaTeX stay data.
 *
 * The REP service (`ctx.researchEvidence`) is consumed when mounted; otherwise
 * the runtime creates its own core store, so the plugin works on its own. The
 * core package is a required peer (it is the shared protocol, not a sibling
 * feature plugin).
 *
 * Function plugin — no default export.
 *
 * @module dsh-doc-anchor
 */

import type { Context } from '@deepseek-ai/cordis'
import { Config, resolveConfig, type Config as ConfigShape } from './config.ts'
import { DocAnchorRuntime, type EvidencePort } from './runtime.ts'
import { makeDocAnchorTool } from './tools/doc-anchor.ts'
import { makeDocLocateTool } from './tools/doc-locate.ts'
import { makeDocTablesTool } from './tools/doc-tables.ts'

/** Cordis plugin name. */
export const name = 'doc-anchor'

/** The tool registry is a hard requirement; the REP service is optional. */
export const inject = ['tools']

export { Config, resolveConfig }
export type { ConfigShape }
export type { ResolvedConfig } from './config.ts'
export { VERSION } from './version.ts'
export {
  DocAnchorError,
  DocAnchorRuntime,
  buildAnchors,
  summariseAnchor,
} from './runtime.ts'
export type {
  AnchorRequest,
  AnchorSummary,
  DocAnchorErrorCode,
  DocAnchorFailure,
  DocAnchorResult,
  DocAnchorRuntimeOptions,
  EvidencePort,
  LocateHit,
  LocateRequest,
  TableSummary,
  TablesRequest,
} from './runtime.ts'
export { detectMediaType, extractDocument, mediaTypeFromName, SUPPORTED_MEDIA_TYPES, DocParseError } from './extract/index.ts'
export { decodeEntities, extractHtml } from './extract/html.ts'
export { extractLatex } from './extract/latex.ts'
export { extractPdf, looksLikePdf } from './extract/pdf.ts'
export { extractText } from './extract/text.ts'
export { detectInjection } from './extract/injection.ts'
export type { ExtractedBlock, ExtractedDoc, ExtractedPage, ExtractedTable } from './extract/types.ts'
export { makeDocAnchorTool } from './tools/doc-anchor.ts'
export { makeDocLocateTool } from './tools/doc-locate.ts'
export { makeDocTablesTool } from './tools/doc-tables.ts'

/**
 * Mount the tools.
 * @param ctx - the plugin context (host).
 * @param config - raw plugin config.
 */
export function apply(ctx: Context, config: ConfigShape): void {
  const resolved = resolveConfig(config)
  const logger = ctx.logger('doc-anchor')
  if (!resolved.enabled) {
    logger.info('disabled: enabled is false — no tools are mounted')
    return
  }
  const service = ctx.get('researchEvidence') as EvidencePort | undefined
  const runtime = new DocAnchorRuntime({ config: resolved, ...(service === undefined ? {} : { service }) })
  if (service === undefined) {
    logger.info(`ctx.researchEvidence is not mounted; using a local core store under ${resolved.root}`)
  }
  ctx.effect(() => ctx.tools.register(makeDocAnchorTool(runtime)), 'doc-anchor: doc_anchor tool')
  ctx.effect(() => ctx.tools.register(makeDocLocateTool(runtime)), 'doc-anchor: doc_locate tool')
  ctx.effect(() => ctx.tools.register(makeDocTablesTool(runtime)), 'doc-anchor: doc_tables tool')
}
