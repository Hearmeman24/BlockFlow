#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const logLines = []

function log(message) {
  console.error(`[smoke-npm-package] ${message}`)
}

function remember(chunk) {
  const text = chunk.toString()
  process.stderr.write(text)
  for (const line of text.split(/\r?\n/)) {
    if (line) logLines.push(line)
  }
  if (logLines.length > 400) logLines.splice(0, logLines.length - 400)
}

function run(command, args, options = {}) {
  const { quietStdout = false, ...spawnOptions } = options
  log(`${command} ${args.join(' ')}`)
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    ...spawnOptions,
  })
  if (result.stdout && !quietStdout) process.stdout.write(result.stdout)
  if (result.stderr) process.stderr.write(result.stderr)
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} exited with code ${result.status}`)
  }
  return result.stdout
}

async function waitForJson(url, { timeoutMs = 180_000, expect } = {}) {
  const deadline = Date.now() + timeoutMs
  let lastError = null
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url)
      const body = await response.text()
      if (!response.ok) throw new Error(`${response.status} ${body.slice(0, 200)}`)
      const parsed = JSON.parse(body)
      if (!expect || expect(parsed)) return parsed
      lastError = new Error(`unexpected response from ${url}: ${body.slice(0, 500)}`)
    } catch (err) {
      lastError = err
    }
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  throw lastError ?? new Error(`timed out waiting for ${url}`)
}

async function waitForOk(url, { timeoutMs = 180_000 } = {}) {
  const deadline = Date.now() + timeoutMs
  let lastError = null
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url)
      if (response.ok) return
      lastError = new Error(`${response.status} ${await response.text()}`)
    } catch (err) {
      lastError = err
    }
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  throw lastError ?? new Error(`timed out waiting for ${url}`)
}

async function terminate(child) {
  if (child.exitCode !== null || child.signalCode !== null) return
  if (process.platform === 'win32') {
    spawnSync('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' })
  } else {
    try {
      process.kill(-child.pid, 'SIGTERM')
    } catch {
      child.kill('SIGTERM')
    }
  }
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        try {
          if (process.platform === 'win32') {
            spawnSync('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' })
          } else {
            process.kill(-child.pid, 'SIGKILL')
          }
        } catch {
          child.kill('SIGKILL')
        }
      }
      resolve()
    }, 5000)
    child.once('exit', () => {
      clearTimeout(timer)
      resolve()
    })
  })
}

async function main() {
  log('npm pack --json')
  const packOutput = run('npm', ['pack', '--json'], { quietStdout: true })
  const packed = JSON.parse(packOutput)
  const tarball = path.resolve(root, packed[0].filename)
  log(`packed ${packed[0].filename} with ${packed[0].entryCount} entries`)
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'blockflow-npx-smoke-'))
  const home = path.join(tmp, 'blockflow-home')
  const backendPort = process.env.BLOCKFLOW_SMOKE_BACKEND_PORT || '48180'
  const frontendPort = process.env.BLOCKFLOW_SMOKE_FRONTEND_PORT || '48181'
  const env = {
    ...process.env,
    BLOCKFLOW_HOME: home,
    BLOCKFLOW_NO_OPEN: '1',
    BACKEND_PORT: backendPort,
    FRONTEND_PORT: frontendPort,
    HOME: path.join(tmp, 'home'),
    USERPROFILE: path.join(tmp, 'userprofile'),
    LOCALAPPDATA: path.join(tmp, 'localappdata'),
    XDG_DATA_HOME: path.join(tmp, 'xdg-data'),
    npm_config_cache: path.join(tmp, 'npm-cache'),
  }

  await fs.mkdir(env.HOME, { recursive: true })
  await fs.mkdir(env.USERPROFILE, { recursive: true })
  await fs.mkdir(env.LOCALAPPDATA, { recursive: true })
  await fs.mkdir(env.XDG_DATA_HOME, { recursive: true })

  const args = ['exec', '--yes', '--package', tarball, '--', 'blockflow']
  log(`npm exec --yes --package ${tarball} -- blockflow`)
  const child = spawn('npm', args, {
    cwd: tmp,
    env,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', remember)
  child.stderr.on('data', remember)

  let failed = false
  try {
    const backend = `http://127.0.0.1:${backendPort}`
    const frontend = `http://127.0.0.1:${frontendPort}`
    await waitForJson(`${backend}/api/runs?limit=1`, { expect: (body) => Array.isArray(body.runs) })
    await waitForOk(frontend)
    const health = await waitForJson(`${backend}/api/blocks/comfy_gen/health`, {
      expect: (body) => body.ok === true,
    })
    if (health.mode !== 'sidecar') {
      throw new Error(`expected comfy-gen sidecar mode, got ${JSON.stringify(health)}`)
    }
    if (!String(health.path).includes(path.join('runtime', 'venv'))) {
      throw new Error(`expected comfy-gen inside managed runtime venv, got ${health.path}`)
    }
    await fs.access(path.join(home, 'run_history.db'))
    log(`backend: ${backend}`)
    log(`frontend: ${frontend}`)
    log(`comfy-gen: ${health.path}`)
  } catch (err) {
    failed = true
    console.error('\n[smoke-npm-package] last process output:')
    console.error(logLines.join('\n'))
    throw err
  } finally {
    await terminate(child)
    await fs.rm(tarball, { force: true })
    if (!failed && process.env.BLOCKFLOW_KEEP_SMOKE_TMP !== '1') {
      await fs.rm(tmp, { recursive: true, force: true })
    } else {
      log(`kept temp dir: ${tmp}`)
    }
  }
}

main().catch((err) => {
  console.error(`[smoke-npm-package] ${err instanceof Error ? err.stack || err.message : String(err)}`)
  process.exit(1)
})
