#!/usr/bin/env node
//
// Block-registry codegen.
//
// Discovers blocks from two dirs:
//   - `custom_blocks/` (always, public blocks)
//   - `private_blocks/` (optional overlay; gitignored; for blocks that ship
//      privately and never enter the public OSS build)
//
// Both dirs follow the same layout: `<slug>/frontend.block.tsx` (+ optional
// `backend.block.py`). Slug collisions across the two dirs are an error.

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const frontendDir = path.resolve(scriptDir, '..')
const repoRoot = path.resolve(frontendDir, '..')
const customBlocksDir = path.join(repoRoot, 'custom_blocks')
const privateBlocksDir = path.join(repoRoot, 'private_blocks')
const outFile = path.join(frontendDir, 'src', 'components', 'pipeline', 'custom_blocks', '_register.ts')
const generatedDir = path.join(frontendDir, 'src', 'components', 'pipeline', 'custom_blocks', 'generated')

const VALID_BINDING_MODES = new Set(['upstream_only', 'upstream_or_local', 'local_only'])
const VALID_FORWARD_WHEN = new Set(['if_present', 'always'])

export function slugToVarName(slug) {
  const parts = slug
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .split('_')
    .filter(Boolean)
  const base = parts
    .map((part, idx) => {
      const lower = part.toLowerCase()
      if (idx === 0) return lower
      return lower.charAt(0).toUpperCase() + lower.slice(1)
    })
    .join('')
  const safeBase = /^[a-zA-Z_]/.test(base) ? base : `block${base}`
  return `${safeBase}BlockDef`
}

/**
 * Discover blocks across one or more source dirs.
 *
 * @param {Array<{path: string, source: string}>} dirs
 *   Each entry has a filesystem path and a human-facing `source` label
 *   (e.g. 'custom_blocks', 'private_blocks'). Dirs that don't exist are
 *   treated as empty.
 * @returns {Promise<Array<{slug: string, source: string, sourcePath: string}>>}
 *   Sorted alphabetically by slug.
 * @throws if a slug appears in more than one dir.
 */
export async function discoverBlocks(dirs) {
  const bySlug = new Map() // slug -> { slug, source, sourcePath }
  const collisions = new Map() // slug -> [source, source]

  for (const { path: dirPath, source } of dirs) {
    let entries
    try {
      entries = await fs.readdir(dirPath, { withFileTypes: true })
    } catch {
      continue // dir doesn't exist → treat as empty
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const slug = entry.name
      const sourcePath = path.join(dirPath, slug, 'frontend.block.tsx')
      try {
        await fs.access(sourcePath)
      } catch {
        continue // no frontend entry → skip
      }
      if (bySlug.has(slug)) {
        const prior = bySlug.get(slug)
        collisions.set(slug, [prior.source, source])
      } else {
        bySlug.set(slug, { slug, source, sourcePath })
      }
    }
  }

  if (collisions.size > 0) {
    const lines = []
    for (const [slug, [a, b]] of collisions) {
      lines.push(`  - "${slug}" exists in both ${a}/ and ${b}/`)
    }
    throw new Error(
      `Block slug collision between source dirs. Rename one of the colliding dirs to disambiguate.\n${lines.join('\n')}`,
    )
  }

  return [...bySlug.values()].sort((a, b) => a.slug.localeCompare(b.slug))
}

function findArraySlice(source, propName) {
  const propPattern = new RegExp(`\\b${propName}\\s*:`)
  const propMatch = propPattern.exec(source)
  if (!propMatch) return null

  const start = source.indexOf('[', propMatch.index)
  if (start < 0) return null

  let depth = 0
  let quote = null
  let escaped = false
  for (let i = start; i < source.length; i++) {
    const ch = source[i]
    if (quote) {
      if (escaped) {
        escaped = false
      } else if (ch === '\\') {
        escaped = true
      } else if (ch === quote) {
        quote = null
      }
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch
      continue
    }
    if (ch === '[') {
      depth++
      continue
    }
    if (ch === ']') {
      depth--
      if (depth === 0) return source.slice(start, i + 1)
    }
  }
  return null
}

function parseObjectLiterals(arraySlice) {
  if (!arraySlice) return []
  const objects = []
  let quote = null
  let escaped = false
  let depth = 0
  let objStart = -1

  for (let i = 0; i < arraySlice.length; i++) {
    const ch = arraySlice[i]
    if (quote) {
      if (escaped) {
        escaped = false
      } else if (ch === '\\') {
        escaped = true
      } else if (ch === quote) {
        quote = null
      }
      continue
    }

    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch
      continue
    }

    if (ch === '{') {
      if (depth === 0) objStart = i
      depth++
      continue
    }

    if (ch === '}') {
      depth--
      if (depth === 0 && objStart >= 0) {
        objects.push(arraySlice.slice(objStart, i + 1))
        objStart = -1
      }
    }
  }

  return objects
}

function parseStringProp(objectLiteral, propName) {
  const match = objectLiteral.match(new RegExp(`\\b${propName}\\s*:\\s*(['"\`])([\\s\\S]*?)\\1`))
  return match ? match[2] : null
}

function parseBooleanProp(objectLiteral, propName) {
  const match = objectLiteral.match(new RegExp(`\\b${propName}\\s*:\\s*(true|false)`))
  if (!match) return null
  return match[1] === 'true'
}

function parseNamedPorts(arraySlice) {
  if (!arraySlice) return []
  const objects = parseObjectLiterals(arraySlice)
  const names = []
  for (const objectLiteral of objects) {
    const name = parseStringProp(objectLiteral, 'name')
    if (name) names.push(name)
  }
  return names
}

export function validateBlockContract(slug, sourcePath, source) {
  const errors = []

  const inputsSlice = findArraySlice(source, 'inputs')
  const outputsSlice = findArraySlice(source, 'outputs')
  const bindingsSlice = findArraySlice(source, 'bindings')
  const forwardsSlice = findArraySlice(source, 'forwards')

  const inputNames = new Set(parseNamedPorts(inputsSlice))
  const outputNames = new Set(parseNamedPorts(outputsSlice))

  if (source.includes("kind: 'prompt'") || source.includes('kind: "prompt"')) {
    errors.push('Use canonical kind "text" (or PORT_TEXT) instead of literal "prompt"')
  }

  if (bindingsSlice) {
    const seenFields = new Set()
    for (const objectLiteral of parseObjectLiterals(bindingsSlice)) {
      const field = parseStringProp(objectLiteral, 'field')
      const input = parseStringProp(objectLiteral, 'input')
      const mode = parseStringProp(objectLiteral, 'mode')
      const requiredUpstream = parseBooleanProp(objectLiteral, 'requiredUpstream')
      const allowOverride = parseBooleanProp(objectLiteral, 'allowOverride')

      if (!field) {
        errors.push('bindings[] entry is missing string field "field"')
      } else if (seenFields.has(field)) {
        errors.push(`bindings[] has duplicate field "${field}"`)
      } else {
        seenFields.add(field)
      }

      if (!input) {
        errors.push(`bindings[]${field ? ` for "${field}"` : ''} is missing string field "input"`)
      } else if (!inputNames.has(input)) {
        errors.push(`bindings[]${field ? ` for "${field}"` : ''} references unknown input "${input}"`)
      }

      if (!mode) {
        errors.push(`bindings[]${field ? ` for "${field}"` : ''} is missing string field "mode"`)
      } else if (!VALID_BINDING_MODES.has(mode)) {
        errors.push(`bindings[]${field ? ` for "${field}"` : ''} has invalid mode "${mode}"`)
      }

      if (mode === 'local_only' && requiredUpstream === true) {
        errors.push(`bindings[]${field ? ` for "${field}"` : ''} cannot use requiredUpstream with local_only mode`)
      }
      if (mode === 'upstream_only' && allowOverride === true) {
        errors.push(`bindings[]${field ? ` for "${field}"` : ''} cannot use allowOverride with upstream_only mode`)
      }
    }
  }

  if (forwardsSlice) {
    for (const objectLiteral of parseObjectLiterals(forwardsSlice)) {
      const fromInput = parseStringProp(objectLiteral, 'fromInput')
      const toOutput = parseStringProp(objectLiteral, 'toOutput')
      const when = parseStringProp(objectLiteral, 'when')

      if (!fromInput) {
        errors.push('forwards[] entry is missing string field "fromInput"')
      } else if (!inputNames.has(fromInput)) {
        errors.push(`forwards[] references unknown input "${fromInput}"`)
      }

      if (!toOutput) {
        errors.push('forwards[] entry is missing string field "toOutput"')
      } else if (!outputNames.has(toOutput)) {
        errors.push(`forwards[] references unknown output "${toOutput}"`)
      }

      if (when && !VALID_FORWARD_WHEN.has(when)) {
        errors.push(`forwards[] has invalid when "${when}"`)
      }
    }
  }

  if (errors.length > 0) {
    const details = errors.map((error) => `  - ${error}`).join('\n')
    throw new Error(`Invalid block contract at ${sourcePath} (${slug}):\n${details}`)
  }
}

/**
 * Build the `_register.ts` source content.
 *
 * @param {Array<{slug: string, source: string, sourcePath: string}>} blocks
 *   Output of `discoverBlocks`. The `source` field is intentionally NOT
 *   emitted: consumers don't need to know whether a block came from
 *   custom_blocks/ or private_blocks/.
 */
export function generateRegistrySource(blocks) {
  const lines = []
  lines.push('// AUTO-GENERATED. DO NOT EDIT.')
  lines.push('// Run `npm run gen:custom-blocks` to regenerate.')
  lines.push("import { registerBlockDef } from '@/lib/pipeline/registry'")

  for (const { slug } of blocks) {
    const varName = slugToVarName(slug)
    lines.push(`import { blockDef as ${varName} } from './generated/${slug}'`)
  }

  lines.push('')
  if (blocks.length === 0) {
    lines.push('// No custom blocks discovered.')
  } else {
    for (const { slug } of blocks) {
      lines.push(`registerBlockDef(${slugToVarName(slug)})`)
    }
  }
  lines.push('')
  return lines.join('\n')
}

async function writeIfChanged(filePath, nextContent) {
  let prevContent = null
  try {
    prevContent = await fs.readFile(filePath, 'utf8')
  } catch {
    // File may not exist yet.
  }
  if (prevContent === nextContent) return false
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, nextContent, 'utf8')
  return true
}

async function syncGeneratedBlockModules(blocks) {
  await fs.mkdir(generatedDir, { recursive: true })
  const expected = new Set(blocks.map(({ slug }) => `${slug}.tsx`))
  const existing = await fs.readdir(generatedDir, { withFileTypes: true })

  for (const entry of existing) {
    if (!entry.isFile()) continue
    if (!entry.name.endsWith('.tsx')) continue
    if (!expected.has(entry.name)) {
      await fs.unlink(path.join(generatedDir, entry.name))
    }
  }

  for (const { slug, source, sourcePath } of blocks) {
    const sourceBody = await fs.readFile(sourcePath, 'utf8')
    validateBlockContract(slug, sourcePath, sourceBody)
    const generatedBody = [
      '// AUTO-GENERATED. DO NOT EDIT.',
      `// Source: ${source}/${slug}/frontend.block.tsx`,
      sourceBody,
      '',
    ].join('\n')
    await writeIfChanged(path.join(generatedDir, `${slug}.tsx`), generatedBody)
  }
}

async function main() {
  const blocks = await discoverBlocks([
    { path: customBlocksDir, source: 'custom_blocks' },
    { path: privateBlocksDir, source: 'private_blocks' },
  ])
  await syncGeneratedBlockModules(blocks)
  const source = generateRegistrySource(blocks)
  const changed = await writeIfChanged(outFile, source)
  if (changed) {
    console.log(`[gen-custom-block-registry] Updated ${path.relative(frontendDir, outFile)}`)
  } else {
    console.log('[gen-custom-block-registry] No changes')
  }
}

// Only run main() when this file is the entry point — allows tests to import
// the exported functions without triggering the CLI side-effects.
const isEntryPoint = (() => {
  try {
    return fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? '')
  } catch {
    return false
  }
})()

if (isEntryPoint) {
  main().catch((error) => {
    console.error(`[gen-custom-block-registry] ${error instanceof Error ? error.stack : String(error)}`)
    process.exit(1)
  })
}
