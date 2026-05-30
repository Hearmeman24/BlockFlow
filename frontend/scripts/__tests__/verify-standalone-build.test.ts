import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  findStandaloneServer,
  verifyStandaloneBuild,
} from '../verify-standalone-build.mjs'
import { prepareStandaloneBuild } from '../prepare-standalone-build.mjs'

let tmp: string

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'standalone-build-test-'))
})

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true })
})

async function mkdirp(rel: string) {
  await fs.mkdir(path.join(tmp, rel), { recursive: true })
}

async function write(rel: string, contents = '') {
  const target = path.join(tmp, rel)
  await fs.mkdir(path.dirname(target), { recursive: true })
  await fs.writeFile(target, contents)
}

describe('verifyStandaloneBuild', () => {
  test('accepts a Next standalone bundle with static and public assets', async () => {
    await write('.next/standalone/server.js')
    await write('.next/static/chunks/app.js')
    await write('.next/standalone/.next/static/chunks/app.js')
    await write('public/logo.png')
    await write('.next/standalone/public/logo.png')

    const result = await verifyStandaloneBuild(tmp)

    expect(result.serverPath).toBe(path.join(tmp, '.next/standalone/server.js'))
    expect(result.staticDir).toBe(path.join(tmp, '.next/static'))
    expect(result.standaloneStaticDir).toBe(path.join(tmp, '.next/standalone/.next/static'))
    expect(result.publicDir).toBe(path.join(tmp, 'public'))
    expect(result.standalonePublicDir).toBe(path.join(tmp, '.next/standalone/public'))
  })

  test('prepareStandaloneBuild copies assets into standalone runtime dir', async () => {
    await write('.next/standalone/server.js')
    await write('.next/static/chunks/app.js', 'static')
    await write('public/logo.png', 'public')

    const result = await prepareStandaloneBuild(tmp)

    expect(result.copiedStatic).toBe(true)
    expect(result.copiedPublic).toBe(true)
    await expect(fs.readFile(path.join(tmp, '.next/standalone/.next/static/chunks/app.js'), 'utf8')).resolves.toBe('static')
    await expect(fs.readFile(path.join(tmp, '.next/standalone/public/logo.png'), 'utf8')).resolves.toBe('public')
    await expect(verifyStandaloneBuild(tmp)).resolves.toMatchObject({
      serverPath: path.join(tmp, '.next/standalone/server.js'),
    })
  })

  test('fails clearly when standalone runtime assets were not prepared', async () => {
    await write('.next/standalone/server.js')
    await write('.next/static/chunks/app.js')
    await write('public/logo.png')

    await expect(verifyStandaloneBuild(tmp)).rejects.toThrow(/\.next\/standalone\/\*\*\/\.next\/static/)
  })

  test('finds server.js when Next nests standalone output below the app dir', async () => {
    await write('.next/standalone/frontend/server.js')

    await expect(findStandaloneServer(tmp)).resolves.toBe(
      path.join(tmp, '.next/standalone/frontend/server.js'),
    )
  })

  test('fails clearly when the standalone server is missing', async () => {
    await mkdirp('.next/standalone')
    await write('.next/static/chunks/app.js')
    await write('public/logo.png')

    await expect(verifyStandaloneBuild(tmp)).rejects.toThrow(/server\.js/)
  })
})
