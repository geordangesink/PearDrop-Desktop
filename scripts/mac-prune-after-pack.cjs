const { execFileSync } = require('child_process')
const fs = require('fs')
const path = require('path')

module.exports = async (context) => {
  if (context.electronPlatformName !== 'darwin') return

  const appName = context.packager.appInfo.productFilename
  const appPath = path.join(context.appOutDir, `${appName}.app`)
  const resourcesPath = path.join(appPath, 'Contents', 'Resources')
  const pruneScript = path.join(context.packager.projectDir, 'scripts', 'mac-prune-prebuilds.cjs')

  execFileSync('node', [pruneScript, resourcesPath], { stdio: 'inherit' })

  const unpackedBareRoot = path.join(
    resourcesPath,
    'app.asar.unpacked',
    'node_modules',
    'bare-sidecar',
    'prebuilds'
  )
  const bareExecutables = ['darwin-arm64', 'darwin-x64', 'darwin-universal']
    .map((name) => path.join(unpackedBareRoot, name, 'bare'))
    .filter((file) => fs.existsSync(file))

  if (bareExecutables.length === 0) {
    throw new Error(`[mac-prune] bare-sidecar executable was not unpacked at ${unpackedBareRoot}`)
  }

  for (const file of bareExecutables) {
    fs.chmodSync(file, 0o755)
  }
}
