const fs = require('fs')
const path = require('path')

function walk(dir, visitor) {
  if (!fs.existsSync(dir)) return
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    visitor(full, entry)
    if (entry.isDirectory()) walk(full, visitor)
  }
}

function prunePrebuilds(root) {
  const allowed = new Set(['darwin-arm64', 'darwin-universal'])
  let pruned = 0

  walk(root, (full, entry) => {
    if (!entry.isDirectory() || entry.name !== 'prebuilds') return
    for (const candidate of fs.readdirSync(full, { withFileTypes: true })) {
      if (!candidate.isDirectory()) continue
      if (allowed.has(candidate.name)) continue
      fs.rmSync(path.join(full, candidate.name), { recursive: true, force: true })
      pruned += 1
    }
  })

  return pruned
}

function main() {
  const appResourcesPath = process.argv[2]
  if (!appResourcesPath) {
    console.error('[mac-prune] Usage: node scripts/mac-prune-prebuilds.cjs <resourcesPath>')
    process.exit(1)
  }

  const roots = [
    path.join(appResourcesPath, 'app'),
    path.join(appResourcesPath, 'app.asar.unpacked')
  ]

  let totalPruned = 0
  let foundAtLeastOne = false
  for (const root of roots) {
    if (!fs.existsSync(root)) continue
    foundAtLeastOne = true
    totalPruned += prunePrebuilds(root)
  }

  if (!foundAtLeastOne) {
    console.log('[mac-prune] neither resources/app nor resources/app.asar.unpacked exists')
    return
  }

  console.log(`[mac-prune] Pruned ${totalPruned} prebuild directories`)
}

main()
