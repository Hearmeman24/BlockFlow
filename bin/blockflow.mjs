#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function defaultHome() {
  if (process.env.BLOCKFLOW_HOME) return path.resolve(process.env.BLOCKFLOW_HOME)
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'BlockFlow')
  }
  if (process.platform === 'win32') {
    return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'BlockFlow')
  }
  return path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'blockflow')
}

function exe(name) {
  return process.platform === 'win32' ? `${name}.exe` : name
}

function commandExists(command) {
  const probe = process.platform === 'win32'
    ? spawnSync('where', [command], { stdio: 'ignore' })
    : spawnSync(`command -v ${command}`, { shell: true, stdio: 'ignore' })
  return probe.status === 0
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} exited with code ${result.status}`)
  }
}

function installUv(installDir) {
  fs.mkdirSync(installDir, { recursive: true })
  console.error(`[blockflow] uv not found; installing uv into ${installDir}`)

  if (process.platform === 'win32') {
    run('powershell.exe', [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      `$env:UV_INSTALL_DIR=${JSON.stringify(installDir)}; irm https://astral.sh/uv/install.ps1 | iex`,
    ])
  } else {
    run('sh', [
      '-c',
      `curl -LsSf https://astral.sh/uv/install.sh | UV_INSTALL_DIR=${JSON.stringify(installDir)} sh`,
    ])
  }
}

function resolveUv(home) {
  if (commandExists('uv')) return 'uv'

  const installDir = path.join(home, 'runtime', 'uv-bin')
  const installed = path.join(installDir, exe('uv'))
  if (!fs.existsSync(installed)) installUv(installDir)
  if (!fs.existsSync(installed)) {
    throw new Error(`uv installer finished but ${installed} does not exist`)
  }
  return installed
}

function main() {
  const home = defaultHome()
  fs.mkdirSync(home, { recursive: true })
  const uv = resolveUv(home)
  const venv = path.join(home, 'runtime', 'venv')
  fs.mkdirSync(path.dirname(venv), { recursive: true })

  const env = {
    ...process.env,
    BLOCKFLOW_HOME: home,
    BLOCKFLOW_PACKAGED: '1',
    BLOCKFLOW_COMFY_GEN_VENV: venv,
    UV_PROJECT_ENVIRONMENT: venv,
  }

  const args = [
    'run',
    '--project',
    packageRoot,
    '--no-dev',
    'python',
    path.join(packageRoot, 'app.py'),
    '--packaged',
    ...process.argv.slice(2),
  ]

  console.error(`[blockflow] starting from ${packageRoot}`)
  const child = spawn(uv, args, {
    cwd: packageRoot,
    env,
    stdio: 'inherit',
  })

  const forward = (signal) => {
    if (!child.killed) child.kill(signal)
  }
  process.on('SIGINT', () => forward('SIGINT'))
  process.on('SIGTERM', () => forward('SIGTERM'))

  child.on('exit', (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal)
      return
    }
    process.exit(code ?? 0)
  })
}

try {
  main()
} catch (err) {
  console.error(`[blockflow] ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
}
