const { execFileSync } = require('child_process')
const fs = require('fs')
const path = require('path')

module.exports = async (context) => {
  const platform = String(context.electronPlatformName || process.platform)
  const arch = normalizeArch(context.arch)
  const resourcesPath = resolveResourcesPath(context, platform)
  const pruneScript = path.join(context.packager.projectDir, 'scripts', 'mac-prune-prebuilds.cjs')

  execFileSync('node', [pruneScript, resourcesPath, platform, arch], { stdio: 'inherit' })

  const unpackedBareRoot = path.join(
    resourcesPath,
    'app.asar.unpacked',
    'node_modules',
    'bare-sidecar',
    'prebuilds'
  )
  const bareName = platform === 'win32' ? 'bare.exe' : 'bare'
  const bareExecutables = [`${platform}-${arch}`, `${platform}-universal`]
    .map((name) => path.join(unpackedBareRoot, name, bareName))
    .filter((file) => fs.existsSync(file))

  if (bareExecutables.length === 0) {
    throw new Error(`[mac-prune] bare-sidecar executable was not unpacked at ${unpackedBareRoot}`)
  }

  for (const file of bareExecutables) {
    fs.chmodSync(file, 0o755)
  }
}

function resolveResourcesPath(context, platform) {
  const appName = context.packager.appInfo.productFilename
  const candidates =
    platform === 'darwin'
      ? [
          path.join(context.appOutDir, `${appName}.app`, 'Contents', 'Resources'),
          path.join(context.appOutDir, 'Contents', 'Resources')
        ]
      : [path.join(context.appOutDir, 'resources')]

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate
  }

  throw new Error(`[mac-prune] App resources directory not found: ${candidates.join(', ')}`)
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
