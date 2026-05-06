const { execFileSync } = require('child_process')
const path = require('path')

module.exports = async (context) => {
  if (context.electronPlatformName !== 'darwin') return

  const appName = context.packager.appInfo.productFilename
  const appPath = path.join(context.appOutDir, `${appName}.app`)
  const resourcesPath = path.join(appPath, 'Contents', 'Resources')
  const pruneScript = path.join(context.packager.projectDir, 'scripts', 'mac-prune-prebuilds.cjs')

  execFileSync('node', [pruneScript, resourcesPath], { stdio: 'inherit' })
}
