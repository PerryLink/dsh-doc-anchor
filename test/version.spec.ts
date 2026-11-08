/**
 * Package contract: version single-sourcing, the DSH manifest, peer ranges, and
 * the shipped patch/config surface.
 * @module test/version.spec
 */

import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { resolveConfig } from '../src/config.ts'
import { VERSION } from '../src/version.ts'

const here = path.dirname(fileURLToPath(import.meta.url))

/** Read and parse one JSON file. */
async function readJson(file: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>
}

describe('package contract', () => {
  it('VERSION matches package.json', async () => {
    const pkg = await readJson(path.join(here, '..', 'package.json'))
    expect(pkg['version']).toBe(VERSION)
  })

  it('declares the bundle patch, files and the current DSH peer line', async () => {
    const pkg = await readJson(path.join(here, '..', 'package.json'))
    expect(pkg['type']).toBe('module')
    expect(pkg['dsh']).toEqual({ manifestVersion: 1, bundle: { patch: './cordis.patch.yml' } })
    expect(pkg['files']).toContain('lib')
    expect(pkg['files']).toContain('cordis.patch.yml')
    const engines = pkg['engines'] as Record<string, string>
    expect(engines['dsh']).toContain('>=0.2.1-0 <0.3.0')
    expect(engines['node']).toBe('^22.19.0 || >=24.9.0')
    // The shared protocol is a required peer, not a sibling feature plugin.
    expect((pkg['peerDependencies'] as Record<string, string>)['@perrylink/dsh-research-core']).toBe('^0.1.0')
    expect(pkg['dependencies']).toEqual({})
  })

  it('ships a patch whose config keys all resolve', async () => {
    const patch = await readFile(path.join(here, '..', 'cordis.patch.yml'), 'utf8')
    for (const key of ['enabled', 'root', 'maxBytes', 'maxPages', 'maxChars', 'maxAnchors', 'recordDir', 'persist']) {
      expect(patch).toContain(key)
    }
    expect(() => resolveConfig({ maxAnchors: 501 })).toThrow(/500/u)
    expect(() => resolveConfig({ maxBytes: 0 })).toThrow(/positive safe integer/u)
    expect(() => resolveConfig({ recordDir: '../escape' })).toThrow(/"\.\."/u)
  })
})
