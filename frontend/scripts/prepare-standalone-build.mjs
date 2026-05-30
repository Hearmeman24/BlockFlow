import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { findStandaloneServer } from './verify-standalone-build.mjs'

const scriptPath = fileURLToPath(import.meta.url)

async function exists(target) {
  try {
    await fs.access(target)
    return true
  } catch {
    return false
  }
}

async function copyDirIfPresent(source, target) {
  if (!(await exists(source))) return false
  await fs.rm(target, { recursive: true, force: true })
  await fs.mkdir(path.dirname(target), { recursive: true })
  await fs.cp(source, target, { recursive: true })
  return true
}

export async function prepareStandaloneBuild(frontendDir = process.cwd()) {
  const root = path.resolve(frontendDir)
  const serverPath = await findStandaloneServer(root)
  if (!serverPath) {
    throw new Error('Missing standalone server.js')
  }

  const standaloneDir = path.dirname(serverPath)
  const copiedStatic = await copyDirIfPresent(
    path.join(root, '.next', 'static'),
    path.join(standaloneDir, '.next', 'static'),
  )
  const copiedPublic = await copyDirIfPresent(
    path.join(root, 'public'),
    path.join(standaloneDir, 'public'),
  )

  return { standaloneDir, copiedStatic, copiedPublic }
}

if (process.argv[1] === scriptPath) {
  const frontendDir = process.argv[2] ? path.resolve(process.argv[2]) : process.cwd()
  prepareStandaloneBuild(frontendDir)
    .then((result) => {
      console.log(`[prepare-standalone-build] standalone: ${path.relative(frontendDir, result.standaloneDir)}`)
      console.log(`[prepare-standalone-build] static: ${result.copiedStatic ? 'copied' : 'missing'}`)
      console.log(`[prepare-standalone-build] public: ${result.copiedPublic ? 'copied' : 'missing'}`)
    })
    .catch((err) => {
      console.error(`[prepare-standalone-build] ${err.message}`)
      process.exit(1)
    })
}
