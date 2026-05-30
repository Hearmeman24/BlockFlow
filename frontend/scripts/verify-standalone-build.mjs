import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptPath = fileURLToPath(import.meta.url)

async function exists(target) {
  try {
    await fs.access(target)
    return true
  } catch {
    return false
  }
}

async function walk(dir, visit) {
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return
  }

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      await walk(fullPath, visit)
    } else {
      await visit(fullPath)
    }
  }
}

export async function findStandaloneServer(frontendDir = process.cwd()) {
  const standaloneDir = path.join(frontendDir, '.next', 'standalone')
  const direct = path.join(standaloneDir, 'server.js')
  if (await exists(direct)) return direct

  let found = null
  await walk(standaloneDir, async (candidate) => {
    if (found === null && path.basename(candidate) === 'server.js') {
      found = candidate
    }
  })
  return found
}

export async function verifyStandaloneBuild(frontendDir = process.cwd()) {
  const root = path.resolve(frontendDir)
  const standaloneDir = path.join(root, '.next', 'standalone')
  const staticDir = path.join(root, '.next', 'static')
  const publicDir = path.join(root, 'public')
  const serverPath = await findStandaloneServer(root)

  const missing = []
  if (!(await exists(standaloneDir))) missing.push('.next/standalone')
  if (!serverPath) missing.push('.next/standalone/**/server.js')
  if (!(await exists(staticDir))) missing.push('.next/static')
  if (!(await exists(publicDir))) missing.push('public')

  if (missing.length > 0) {
    throw new Error(`Missing standalone build artifact(s): ${missing.join(', ')}`)
  }

  return { standaloneDir, serverPath, staticDir, publicDir }
}

if (process.argv[1] === scriptPath) {
  const frontendDir = process.argv[2] ? path.resolve(process.argv[2]) : process.cwd()
  verifyStandaloneBuild(frontendDir)
    .then((result) => {
      console.log(`[verify-standalone-build] server: ${path.relative(frontendDir, result.serverPath)}`)
      console.log(`[verify-standalone-build] static: ${path.relative(frontendDir, result.staticDir)}`)
      console.log(`[verify-standalone-build] public: ${path.relative(frontendDir, result.publicDir)}`)
    })
    .catch((err) => {
      console.error(`[verify-standalone-build] ${err.message}`)
      process.exit(1)
    })
}
