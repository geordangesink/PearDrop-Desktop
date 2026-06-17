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

function prunePrebuilds(root, allowed) {
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
  const platform = String(process.argv[3] || process.platform).trim()
  const arch = normalizeArch(process.argv[4] || process.arch)
  if (!appResourcesPath) {
    console.error(
      '[mac-prune] Usage: node scripts/mac-prune-prebuilds.cjs <resourcesPath> [platform] [arch]'
    )
    process.exit(1)
  }

  const allowed = allowedPrebuilds(platform, arch)
  const roots = [
    path.join(appResourcesPath, 'app'),
    path.join(appResourcesPath, 'app.asar.unpacked')
  ]

  let totalPruned = 0
  let foundAtLeastOne = false
  for (const root of roots) {
    if (!fs.existsSync(root)) continue
    foundAtLeastOne = true
    totalPruned += prunePrebuilds(root, allowed)
  }

  if (!foundAtLeastOne) {
    console.log('[mac-prune] neither resources/app nor resources/app.asar.unpacked exists')
    return
  }

  console.log(
    `[mac-prune] Pruned ${totalPruned} prebuild directories; kept ${Array.from(allowed).join(', ')}`
  )
}

main()

function allowedPrebuilds(platform, arch) {
  const allowed = new Set([`${platform}-${arch}`])
  if (platform === 'darwin') allowed.add('darwin-universal')
  return allowed
}

function normalizeArch(value) {
  const raw = String(value || '').trim()
  if (raw === '1') return 'x64'
  if (raw === '3') return 'arm64'
  if (raw === '4') return 'universal'
  if (raw === '0') return 'ia32'
  if (raw === '2') return 'armv7l'
  if (raw.includes('arm64')) return 'arm64'
  if (raw.includes('x64')) return 'x64'
  if (raw.includes('ia32')) return 'ia32'
  if (raw.includes('armv7l')) return 'armv7l'
  if (raw.includes('universal')) return 'universal'
  return raw || process.arch
}
