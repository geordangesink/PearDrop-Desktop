const { execFileSync } = require('child_process')
const fs = require('fs')
const path = require('path')

function listFiles(dir, out = []) {
  if (!fs.existsSync(dir)) return out
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      listFiles(full, out)
      continue
    }
    if (entry.isFile()) out.push(full)
  }
  return out
}

function isMachO(filePath) {
  try {
    const result = execFileSync('file', [filePath], { encoding: 'utf8' })
    return result.includes('Mach-O')
  } catch {
    return false
  }
}

function codesign(target, identity, entitlements) {
  const args = ['--force', '--sign', identity, '--timestamp', '--options', 'runtime']
  if (entitlements) {
    args.push('--entitlements', entitlements)
  }
  args.push(target)
  execFileSync('codesign', args, { stdio: 'inherit' })
}

module.exports = async (context) => {
  if (process.env.SKIP_MANUAL_MAC_SIGN === '1') {
    console.log('[mac-sign] SKIP_MANUAL_MAC_SIGN=1, skipping manual sign pass')
    return
  }

  const identity = process.env.MAC_CODESIGN_IDENTITY
  if (!identity) {
    console.log('[mac-sign] MAC_CODESIGN_IDENTITY is not set, skipping manual sign pass')
    return
  }

  const appOutDir = context.appOutDir
  const appName = context.packager.appInfo.productFilename
  const appPath = path.join(appOutDir, `${appName}.app`)
  const entitlements = path.join(context.packager.projectDir, 'build', 'entitlements.mac.plist')

  if (!fs.existsSync(appPath)) {
    throw new Error(`[mac-sign] App bundle not found: ${appPath}`)
  }

  const resourcesPath = path.join(appPath, 'Contents', 'Resources')
  execFileSync(
    'node',
    [path.join(context.packager.projectDir, 'scripts', 'mac-prune-prebuilds.cjs'), resourcesPath],
    {
      stdio: 'inherit'
    }
  )

  const files = listFiles(appPath)
  const machOs = files.filter(isMachO)
  console.log(`[mac-sign] Found ${machOs.length} Mach-O files to sign`)

  for (const file of machOs) {
    const rel = path.relative(appPath, file)
    const useEntitlements = rel.startsWith(path.join('Contents', 'MacOS'))
    codesign(file, identity, useEntitlements ? entitlements : undefined)
  }

  const nestedApps = files
    .filter((file) => file.endsWith('.app/Contents/Info.plist'))
    .map((file) => file.replace(/\/Contents\/Info\.plist$/, '.app'))
    .sort((a, b) => b.length - a.length)

  for (const nestedApp of nestedApps) {
    codesign(nestedApp, identity, entitlements)
  }

  codesign(appPath, identity, entitlements)
  execFileSync('codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath], {
    stdio: 'inherit'
  })
  execFileSync('spctl', ['-a', '-t', 'exec', '-vv', appPath], { stdio: 'inherit' })
}
