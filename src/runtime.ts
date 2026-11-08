/**
 * The anchoring runtime: path safety → bytes → extraction → REP snapshots →
 * anchors → evidence → per-document record.
 *
 * It uses `ctx.researchEvidence` when that service is mounted and otherwise
 * creates its own core `EvidenceStore`, so the plugin works alone. Every
 * failure is a typed `DocAnchorError` with a stable code; nothing is silently
 * truncated.
 *
 * @module dsh-doc-anchor/runtime
 */

import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  EvidenceStore,
  RepStoreError,
  stableId,
  validateRep,
  type AddEvidenceInput,
  type Anchor,
  type CaptureInput,
  type Evidence,
  type HashRef,
  type ResearchRecord,
  type Snapshot,
} from '@perrylink/dsh-research-core'
import type { ResolvedConfig } from './config.ts'
import { detectMediaType, extractDocument, DocParseError } from './extract/index.ts'
import type { ExtractedDoc, ExtractedTable } from './extract/types.ts'
import { VERSION } from './version.ts'

/** Stable error codes returned by the tools. */
export type DocAnchorErrorCode =
  | 'INVALID_INPUT'
  | 'NOT_FOUND'
  | 'NOT_A_FILE'
  | 'PATH_ESCAPE'
  | 'TOO_LARGE'
  | 'PAGE_LIMIT'
  | 'UNSUPPORTED_TYPE'
  | 'PARSE_FAILED'
  | 'EMPTY_DOCUMENT'
  | 'STORE_ERROR'
  | 'EVIDENCE_UNKNOWN'

/** A typed failure with a stable code (never thrown for a normal tool miss). */
export class DocAnchorError extends Error {
  /** The stable code. */
  readonly code: DocAnchorErrorCode
  /** Extra machine-readable context (counts, sizes, path). */
  readonly detail: Record<string, unknown>

  constructor(code: DocAnchorErrorCode, message: string, detail: Record<string, unknown> = {}) {
    super(message)
    this.name = 'DocAnchorError'
    this.code = code
    this.detail = detail
  }
}

/** The subset of the REP evidence service this plugin needs. */
export interface EvidencePort {
  capture(input: CaptureInput): Promise<{ snapshot: Snapshot }>
  addEvidence(input: AddEvidenceInput): Promise<{ evidence: Evidence }>
  getSnapshot(snapshotId: HashRef): Promise<{ snapshot: Snapshot; bytes: Uint8Array } | undefined>
  getEvidence(evidenceId: string): Promise<Evidence | undefined>
  buildRecord(options?: { evidenceIds?: readonly string[] }): Promise<Omit<ResearchRecord, 'manifest'>>
}

/** One anchor summary returned to the model (char offsets into the text snapshot). */
export interface AnchorSummary {
  readonly kind: Anchor['kind']
  readonly value: string
  readonly page?: number
  readonly charStart?: number
  readonly charEnd?: number
  readonly label?: string
}

/** The `doc_anchor` canonical value. */
export interface DocAnchorResult {
  readonly ok: true
  readonly evidenceId: string
  /** Content address of the original bytes. */
  readonly snapshotId: HashRef
  /** Content address of the extracted text (anchors index into this). */
  readonly textSnapshotId: HashRef
  readonly mediaType: string
  readonly title: string
  readonly pages: number
  readonly chars: number
  readonly anchorCount: number
  readonly truncated: boolean
  readonly anchors: readonly AnchorSummary[]
  readonly tableCount: number
  readonly warnings: readonly string[]
  readonly injectionSuspected: boolean
  readonly recordPath?: string
}

/** A normalised failure value. */
export interface DocAnchorFailure {
  readonly ok: false
  readonly error: { readonly code: DocAnchorErrorCode; readonly message: string }
}

/** Input for {@link DocAnchorRuntime.anchor}. */
export interface AnchorRequest {
  readonly path?: string
  readonly content?: string
  readonly name?: string
  readonly mediaType?: string
  readonly title?: string
  readonly persist?: boolean
  readonly maxAnchors?: number
}

/** Input for {@link DocAnchorRuntime.locate}. */
export interface LocateRequest {
  readonly query: string
  readonly textSnapshotId?: string
  readonly evidenceId?: string
  readonly maxResults?: number
  readonly ignoreCase?: boolean
}

/** One quote location. */
export interface LocateHit {
  readonly charStart: number
  readonly charEnd: number
  readonly quote: string
  readonly page?: number
}

/** Input for {@link DocAnchorRuntime.tables}. */
export interface TablesRequest {
  readonly path?: string
  readonly evidenceId?: string
  readonly maxRows?: number
}

/** One table rendered for a tool result. */
export interface TableSummary {
  readonly index: number
  readonly source: ExtractedTable['source']
  readonly header?: readonly string[]
  readonly rows: readonly (readonly string[])[]
  readonly rowsTruncated: boolean
  readonly charStart: number
  readonly charEnd: number
}

/** Options for {@link DocAnchorRuntime}. */
export interface DocAnchorRuntimeOptions {
  readonly config: ResolvedConfig
  /** The mounted REP service, when `ctx.researchEvidence` exists. */
  readonly service?: EvidencePort
  /** Clock override for tests. */
  readonly now?: () => Date
}

/** True when `candidate` is inside `root` (or equal to it). */
function isInside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root.endsWith(path.sep) ? root : `${root}${path.sep}`)
}

/** Error codes raised by parsing, mapped to the tool vocabulary. */
function fromParseError(error: DocParseError): DocAnchorError {
  const code: DocAnchorErrorCode =
    error.code === 'encrypted_pdf'
      ? 'PARSE_FAILED'
      : error.code === 'unsupported_media_type'
        ? 'UNSUPPORTED_TYPE'
        : error.code === 'empty_document'
          ? 'EMPTY_DOCUMENT'
          : 'PARSE_FAILED'
  return new DocAnchorError(code, error.message)
}

/** Normalise one line of text for an anchor value/label. */
function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/gu, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/**
 * Build locator anchors over the extracted text.
 *
 * Priority when the cap is hit: pages → sections → tables → paragraphs, so the
 * cheapest-to-review locators survive.
 */
export function buildAnchors(doc: ExtractedDoc, snapshotId: HashRef, maxAnchors: number): {
  anchors: Anchor[]
  truncated: boolean
} {
  const anchors: Anchor[] = []
  for (const page of doc.pages) {
    if (page.end <= page.start) continue
    anchors.push({
      snapshotId,
      kind: 'page',
      value: `p.${page.page}`,
      page: page.page,
      charRange: { start: page.start, end: page.end },
    })
  }
  for (const block of doc.blocks) {
    if (block.kind !== 'heading') continue
    anchors.push({
      snapshotId,
      kind: 'section',
      value: oneLine(block.text, 200),
      section: oneLine(block.text, 200),
      charRange: { start: block.start, end: block.end },
      quote: block.text,
      ...(block.level === undefined ? {} : { label: `h${block.level}` }),
    })
  }
  for (const table of doc.tables) {
    anchors.push({
      snapshotId,
      kind: 'table',
      value: `t.${table.index + 1}`,
      ordinal: table.index + 1,
      charRange: { start: table.start, end: table.end },
      ...(table.label === undefined ? {} : { label: oneLine(table.label, 200) }),
    })
  }
  let paragraph = 0
  for (const block of doc.blocks) {
    if (block.kind !== 'paragraph' && block.kind !== 'list-item' && block.kind !== 'code') continue
    if (anchors.length >= maxAnchors) break
    paragraph += 1
    anchors.push({
      snapshotId,
      kind: 'paragraph',
      value: `para.${paragraph}`,
      paragraph,
      charRange: { start: block.start, end: block.end },
      label: oneLine(block.text, 80),
    })
  }
  const truncated = anchors.length > maxAnchors
  return { anchors: truncated ? anchors.slice(0, maxAnchors) : anchors, truncated }
}

/** The anchoring runtime. */
export class DocAnchorRuntime {
  readonly config: ResolvedConfig

  readonly #service: EvidencePort | undefined
  readonly #now: () => Date
  #store: EvidenceStore | undefined

  constructor(options: DocAnchorRuntimeOptions) {
    this.config = options.config
    this.#service = options.service
    this.#now = options.now ?? (() => new Date())
  }

  /** The evidence port (mounted service, else a local core store). */
  port(): EvidencePort {
    if (this.#service !== undefined) return this.#service
    this.#store ??= new EvidenceStore(path.join(this.config.root, 'store'))
    return this.#store
  }

  /** Current ISO timestamp. */
  iso(): string {
    return this.#now().toISOString()
  }

  /**
   * Resolve a document path safely.
   * @param input - a workspace-relative or absolute path.
   * @returns the absolute path (symlinks resolved) and its workspace-relative id.
   */
  async resolvePath(input: string): Promise<{ absolute: string; id: string }> {
    if (typeof input !== 'string' || input.trim() === '') {
      throw new DocAnchorError('INVALID_INPUT', 'path must be a non-empty string')
    }
    const root = this.config.workspaceRoot
    let realRoot: string
    try {
      realRoot = await realpath(root)
    } catch {
      throw new DocAnchorError('NOT_FOUND', `workspace root does not exist: ${root}`, { root })
    }
    const candidate = path.resolve(realRoot, input)
    if (!isInside(realRoot, candidate)) {
      throw new DocAnchorError('PATH_ESCAPE', 'path resolves outside the workspace root', { path: input, workspaceRoot: realRoot })
    }
    let real: string
    try {
      real = await realpath(candidate)
    } catch {
      throw new DocAnchorError('NOT_FOUND', `document not found: ${input}`, { path: candidate })
    }
    if (!isInside(realRoot, real)) {
      throw new DocAnchorError('PATH_ESCAPE', 'path escapes the workspace root through a symlink', { path: input, resolved: real })
    }
    const info = await stat(real)
    if (!info.isFile()) throw new DocAnchorError('NOT_A_FILE', `not a regular file: ${input}`, { path: real })
    const id = path.relative(realRoot, real).split(path.sep).join('/')
    return { absolute: real, id }
  }

  /** Detect a media type, mapping parse errors into the tool vocabulary. */
  #detect(bytes: Buffer, name: string, declared?: string): string {
    try {
      return detectMediaType(bytes, name, declared)
    } catch (error) {
      if (error instanceof DocParseError) throw fromParseError(error)
      throw error
    }
  }

  /** Read one document with the byte cap enforced. */
  async readDocument(request: AnchorRequest, id: string): Promise<{ bytes: Buffer; name?: string; mediaType: string; title: string }> {
    if (request.content !== undefined) {
      if (request.path !== undefined) {
        throw new DocAnchorError('INVALID_INPUT', 'pass either path or content, not both')
      }
      const bytes = Buffer.from(request.content, 'utf8')
      if (bytes.byteLength > this.config.maxBytes) {
        throw new DocAnchorError('TOO_LARGE', `content is ${bytes.byteLength} bytes, the cap is ${this.config.maxBytes}`, {
          bytes: bytes.byteLength,
          maxBytes: this.config.maxBytes,
        })
      }
      const name = request.name ?? 'inline.md'
      return {
        bytes,
        name,
        mediaType: this.#detect(bytes, name, request.mediaType),
        title: request.title ?? name,
      }
    }
    const info = await stat(id)
    if (info.size > this.config.maxBytes) {
      throw new DocAnchorError('TOO_LARGE', `document is ${info.size} bytes, the cap is ${this.config.maxBytes}`, {
        bytes: info.size,
        maxBytes: this.config.maxBytes,
      })
    }
    const bytes = await readFile(id)
    const name = path.basename(id)
    return {
      bytes,
      name,
      mediaType: this.#detect(bytes, name, request.mediaType),
      title: request.title ?? name,
    }
  }

  /**
   * Anchor one document: capture both snapshots, register evidence and return
   * the locators.
   * @param request - path or inline content plus options.
   * @returns the canonical success value.
   * @throws DocAnchorError on any failure.
   */
  async anchor(request: AnchorRequest): Promise<DocAnchorResult> {
    if ((request.path === undefined) === (request.content === undefined)) {
      throw new DocAnchorError('INVALID_INPUT', 'pass exactly one of path or content')
    }
    let absolutePath: string | undefined
    let documentId: string
    if (request.path !== undefined) {
      const resolved = await this.resolvePath(request.path)
      absolutePath = resolved.absolute
      documentId = resolved.id
    } else {
      documentId = `inline:${request.name ?? 'document'}`
    }

    const document = await this.readDocument(request, absolutePath ?? documentId)
    let doc: ExtractedDoc
    try {
      doc = extractDocument({ bytes: document.bytes, mediaType: document.mediaType, ...(document.name === undefined ? {} : { name: document.name }) }, {
        maxPages: this.config.maxPages,
        maxChars: this.config.maxChars,
      })
    } catch (error) {
      if (error instanceof DocParseError) throw fromParseError(error)
      throw error
    }

    const retrievedAt = this.iso()
    const persist = request.persist ?? this.config.persist
    if (!persist) {
      const anchors = buildAnchors(doc, `sha256:${'0'.repeat(64)}`, request.maxAnchors ?? this.config.maxAnchors)
      return {
        ok: true,
        evidenceId: stableId('ev', ['doc-anchor', documentId, doc.text.length]),
        snapshotId: `sha256:${'0'.repeat(64)}`,
        textSnapshotId: `sha256:${'0'.repeat(64)}`,
        mediaType: document.mediaType,
        title: document.title,
        pages: doc.pages.length,
        chars: doc.text.length,
        anchorCount: anchors.anchors.length,
        truncated: anchors.truncated,
        anchors: anchors.anchors.map(summariseAnchor),
        tableCount: doc.tables.length,
        warnings: [...doc.warnings, 'persist=false: no snapshot was stored, so these anchors cannot be verified later'],
        injectionSuspected: doc.injectionSuspected,
      }
    }

    const port = this.port()
    const sourceRef = {
      kind: 'file' as const,
      id: documentId,
      retrievedAt,
      metadata: { title: document.title, ...(document.name === undefined ? {} : { type: document.name.split('.').pop() ?? 'unknown' }) },
    }
    let original: { snapshot: Snapshot }
    let extracted: { snapshot: Snapshot }
    try {
      original = await port.capture({
        bytes: document.bytes,
        mediaType: document.mediaType as Snapshot['mediaType'],
        sourceRef,
        capturedAt: retrievedAt,
      })
      extracted = await port.capture({
        bytes: doc.text,
        mediaType: 'text/plain',
        sourceRef: { ...sourceRef, id: `${documentId}#extracted-text` },
        capturedAt: retrievedAt,
      })
    } catch (error) {
      if (error instanceof RepStoreError) throw new DocAnchorError('STORE_ERROR', error.message, { storeCode: error.code })
      throw error
    }

    const { anchors, truncated } = buildAnchors(doc, extracted.snapshot.snapshotId, request.maxAnchors ?? this.config.maxAnchors)
    // Plain text and Markdown often extract to their own bytes; binding the same
    // content address twice would be a duplicate-id record, so dedupe honestly.
    const snapshotIds: HashRef[] =
      original.snapshot.snapshotId === extracted.snapshot.snapshotId
        ? [original.snapshot.snapshotId]
        : [original.snapshot.snapshotId, extracted.snapshot.snapshotId]
    const evidenceInput: AddEvidenceInput = {
      evidenceId: stableId('ev', ['doc-anchor', documentId, extracted.snapshot.snapshotId]),
      title: document.title,
      sourceRef,
      snapshotIds,
      anchors,
      provenance: {
        plugin: 'dsh-doc-anchor',
        version: VERSION,
        method: `extract:${document.mediaType}`,
        retrievedAt,
      },
      notes: `original bytes ${document.bytes.byteLength}B; extracted ${doc.text.length} chars; ${doc.pages.length} page(s); ${doc.tables.length} table(s)`,
    }
    let evidence: Evidence
    try {
      evidence = (await port.addEvidence(evidenceInput)).evidence
    } catch (error) {
      if (error instanceof RepStoreError) throw new DocAnchorError('STORE_ERROR', error.message, { storeCode: error.code })
      throw error
    }

    let recordPath: string | undefined
    try {
      const record = await port.buildRecord({ evidenceIds: [evidence.evidenceId] })
      const validation = validateRep(record)
      if (!validation.ok) {
        throw new DocAnchorError('STORE_ERROR', `refusing to write an invalid REP record: ${validation.issues[0]?.code ?? 'unknown'}`)
      }
      const directory = path.join(this.config.root, this.config.recordDir)
      await mkdir(directory, { recursive: true })
      const file = path.join(directory, `${extracted.snapshot.snapshotId.slice('sha256:'.length)}.rep.json`)
      await writeFile(file, `${JSON.stringify(record, null, 2)}\n`, 'utf8')
      recordPath = file
    } catch (error) {
      if (error instanceof DocAnchorError) throw error
      throw new DocAnchorError('STORE_ERROR', `could not write the REP record: ${(error as Error).message}`)
    }

    return {
      ok: true,
      evidenceId: evidence.evidenceId,
      snapshotId: original.snapshot.snapshotId,
      textSnapshotId: extracted.snapshot.snapshotId,
      mediaType: document.mediaType,
      title: document.title,
      pages: doc.pages.length,
      chars: doc.text.length,
      anchorCount: anchors.length,
      truncated,
      anchors: anchors.slice(0, 200).map(summariseAnchor),
      tableCount: doc.tables.length,
      warnings: [...doc.warnings],
      injectionSuspected: doc.injectionSuspected,
      ...(recordPath === undefined ? {} : { recordPath }),
    }
  }

  /**
   * Locate a query inside an extracted text snapshot.
   * @param request - the query and the snapshot/evidence to search.
   * @returns the hits (empty array when the text does not occur).
   */
  async locate(request: LocateRequest): Promise<LocateHit[]> {
    if (typeof request.query !== 'string' || request.query === '') {
      throw new DocAnchorError('INVALID_INPUT', 'query must be a non-empty string')
    }
    const port = this.port()
    let textSnapshotId = request.textSnapshotId as HashRef | undefined
    let evidence: Evidence | undefined
    if (request.evidenceId !== undefined) {
      evidence = await port.getEvidence(request.evidenceId)
      if (evidence === undefined) throw new DocAnchorError('EVIDENCE_UNKNOWN', `unknown evidence ${request.evidenceId}`)
      if (textSnapshotId === undefined) {
        // Prefer the textual snapshot (anchors index into it), not the original
        // binary/markup bytes.
        for (const candidate of evidence.snapshotIds) {
          const view = await port.getSnapshot(candidate)
          if (view !== undefined && view.snapshot.mediaType.startsWith('text/')) {
            textSnapshotId = candidate
            break
          }
        }
        textSnapshotId ??= evidence.snapshotIds[0]
      }
    }
    if (textSnapshotId === undefined) {
      throw new DocAnchorError('INVALID_INPUT', 'pass textSnapshotId or evidenceId')
    }
    const view = await port.getSnapshot(textSnapshotId)
    if (view === undefined) throw new DocAnchorError('EVIDENCE_UNKNOWN', `unknown snapshot ${textSnapshotId}`)
    const text = Buffer.from(view.bytes).toString('utf8')
    const haystack = request.ignoreCase === true ? text.toLowerCase() : text
    const needle = request.ignoreCase === true ? request.query.toLowerCase() : request.query
    const maxResults = Math.min(Math.max(request.maxResults ?? 20, 1), 200)
    const pageRanges =
      evidence === undefined
        ? []
        : evidence.anchors
            .filter(anchor => anchor.kind === 'page' && anchor.charRange !== undefined)
            .map(anchor => ({ page: anchor.page ?? 0, start: anchor.charRange!.start, end: anchor.charRange!.end }))
    const hits: LocateHit[] = []
    let from = 0
    while (hits.length < maxResults) {
      const index = haystack.indexOf(needle, from)
      if (index === -1) break
      const page = pageRanges.find(range => index >= range.start && index < range.end)?.page
      hits.push({
        charStart: index,
        charEnd: index + needle.length,
        quote: text.slice(index, index + needle.length),
        ...(page === undefined ? {} : { page }),
      })
      from = index + Math.max(needle.length, 1)
    }
    return hits
  }

  /**
   * Re-extract tables for a stored document.
   * @param request - `path` or `evidenceId`.
   * @returns the table grids, capped per table.
   */
  async tables(request: TablesRequest): Promise<{ tables: TableSummary[]; warnings: string[] }> {
    const maxRows = Math.min(Math.max(request.maxRows ?? 200, 1), 2000)
    let bytes: Buffer
    let mediaType: string | undefined
    let name: string | undefined
    if (request.path !== undefined && request.evidenceId === undefined) {
      const resolved = await this.resolvePath(request.path)
      const info = await stat(resolved.absolute)
      if (info.size > this.config.maxBytes) throw new DocAnchorError('TOO_LARGE', `document is ${info.size} bytes, the cap is ${this.config.maxBytes}`)
      bytes = await readFile(resolved.absolute)
      name = path.basename(resolved.absolute)
    } else if (request.evidenceId !== undefined && request.path === undefined) {
      const port = this.port()
      const evidence = await port.getEvidence(request.evidenceId)
      if (evidence === undefined) throw new DocAnchorError('EVIDENCE_UNKNOWN', `unknown evidence ${request.evidenceId}`)
      const original = evidence.snapshotIds[0]
      if (original === undefined) throw new DocAnchorError('EVIDENCE_UNKNOWN', 'the evidence binds no snapshot')
      const view = await port.getSnapshot(original)
      if (view === undefined) throw new DocAnchorError('EVIDENCE_UNKNOWN', `unknown snapshot ${original}`)
      bytes = Buffer.from(view.bytes)
      mediaType = view.snapshot.mediaType
      name = path.basename(evidence.sourceRef.id)
    } else {
      throw new DocAnchorError('INVALID_INPUT', 'pass exactly one of path or evidenceId')
    }
    const resolvedMediaType = mediaType ?? detectMediaType(bytes, name)
    let doc: ExtractedDoc
    try {
      doc = extractDocument({ bytes, mediaType: resolvedMediaType, ...(name === undefined ? {} : { name }) }, {
        maxPages: this.config.maxPages,
        maxChars: this.config.maxChars,
      })
    } catch (error) {
      if (error instanceof DocParseError) throw fromParseError(error)
      throw error
    }
    const tables = doc.tables.map(table => ({
      index: table.index,
      source: table.source,
      ...(table.header === undefined ? {} : { header: table.header }),
      rows: table.rows.slice(0, maxRows),
      rowsTruncated: table.rows.length > maxRows,
      charStart: table.start,
      charEnd: table.end,
    }))
    return { tables, warnings: [...doc.warnings] }
  }
}

/** Project one REP anchor into the compact tool summary. */
export function summariseAnchor(anchor: Anchor): AnchorSummary {
  return {
    kind: anchor.kind,
    value: anchor.value,
    ...(anchor.page === undefined ? {} : { page: anchor.page }),
    ...(anchor.charRange === undefined ? {} : { charStart: anchor.charRange.start, charEnd: anchor.charRange.end }),
    ...(anchor.label === undefined ? {} : { label: anchor.label }),
  }
}
