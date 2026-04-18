const fs = require('fs')
const path = require('path')
const pkg = require('./package.json')
const appName = pkg.productName ?? pkg.name
const windowsSlug = String(appName).replace(/\s+/g, '')
const { isWindows } = require('which-runtime')
const buildMsix = process.env.BUILD_MSIX === '1'
const desktopBuildNumber = resolveDesktopBuildNumber()
const dmgBackgroundPath = path.join(__dirname, 'build', 'dmg-background.png')
const hasDmgBackground = fs.existsSync(dmgBackgroundPath)
const windowsAuthors =
  typeof pkg.author === 'string' && pkg.author.trim().length > 0 ? pkg.author.trim() : appName

function getWindowsKitVersion() {
  const programFiles = process.env['PROGRAMFILES(X86)'] || process.env.PROGRAMFILES
  if (!programFiles) return undefined
  const kitsDir = path.join(programFiles, 'Windows Kits')
  try {
    for (const kit of fs.readdirSync(kitsDir).sort().reverse()) {
      const binDir = path.join(kitsDir, kit, 'bin')
      if (!fs.existsSync(binDir)) continue
      const version = fs
        .readdirSync(binDir)
        .filter((d) => /^\d+\.\d+\.\d+\.\d+$/.test(d))
        .sort()
        .pop()
      if (version) return version
    }
  } catch {
    return undefined
  }
}

let packagerConfig = {
  icon: 'build/icon',
  protocols: [{ name: appName, schemes: [pkg.name] }],
  derefSymlinks: true,
  win32metadata: {
    CompanyName: appName,
    FileDescription: appName,
    InternalName: appName,
    OriginalFilename: `${appName}.exe`,
    ProductName: appName
  }
}

if (desktopBuildNumber > 0) {
  packagerConfig = {
    ...packagerConfig,
    buildVersion: String(desktopBuildNumber)
  }
}

if (process.env.MAC_CODESIGN_IDENTITY) {
  packagerConfig = {
    ...packagerConfig,
    osxSign: {
      identity: process.env.MAC_CODESIGN_IDENTITY,
      optionsForFile: () => ({
        entitlements: path.join(__dirname, 'build', 'entitlements.mac.plist')
      })
    }
  }

  if (
    process.env.MAC_NOTARIZE_ON_PACKAGE === '1' &&
    process.env.APPLE_ID &&
    process.env.APPLE_PASSWORD &&
    process.env.APPLE_TEAM_ID
  ) {
    packagerConfig = {
      ...packagerConfig,
      osxNotarize: {
        appleId: process.env.APPLE_ID,
        appleIdPassword: process.env.APPLE_PASSWORD,
        teamId: process.env.APPLE_TEAM_ID
      }
    }
  }
}

const makers = [
  {
    name: '@electron-forge/maker-dmg',
    platforms: ['darwin'],
    config: {
      name: appName,
      title: `${appName} Installer`,
      icon: path.join(__dirname, 'build', 'installer-drive.icns'),
      overwrite: true,
      format: 'ULFO',
      additionalDMGOptions: {
        'icon-size': 112,
        window: {
          size: {
            width: 658,
            height: 498
          }
        }
      },
      ...(hasDmgBackground
        ? {
            background: dmgBackgroundPath
          }
        : {})
    }
  },
  {
    name: '@electron-forge/maker-squirrel',
    platforms: ['win32'],
    config: {
      name: windowsSlug,
      authors: windowsAuthors,
      setupExe: `${windowsSlug}-Setup-${pkg.version}.exe`,
      setupIcon: path.join(__dirname, 'build', 'icon.ico'),
      iconUrl:
        'https://raw.githubusercontent.com/geordangesink/PearDrop-Desktop/main/build/icon.ico',
      noMsi: true,
      ...(process.env.WINDOWS_CERTIFICATE_FILE
        ? {
            certificateFile: process.env.WINDOWS_CERTIFICATE_FILE,
            certificatePassword: process.env.WINDOWS_CERTIFICATE_PASSWORD,
            signingHashAlgorithms: ['sha256']
          }
        : {})
    }
  }
]

if (buildMsix) {
  makers.push({
    name: '@electron-forge/maker-msix',
    platforms: ['win32'],
    config: {
      appManifest: path.join(__dirname, 'build', 'AppxManifest.xml'),
      windowsKitVersion: getWindowsKitVersion(),
      ...(process.env.WINDOWS_CERTIFICATE_FILE
        ? {
            windowsSignOptions: {
              certificateFile: process.env.WINDOWS_CERTIFICATE_FILE,
              certificatePassword: process.env.WINDOWS_CERTIFICATE_PASSWORD
            }
          }
        : {})
    }
  })
}

module.exports = {
  packagerConfig,

  makers,

  hooks: {
    preMake: async () => {
      fs.rmSync(path.join(__dirname, 'out', 'make'), { recursive: true, force: true })

      if (!buildMsix) return

      const manifest = path.join(__dirname, 'build', 'AppxManifest.xml')
      const msixVersion = resolveMsixVersion(pkg.version, desktopBuildNumber)
      const xml = fs.readFileSync(manifest, 'utf-8')
      fs.writeFileSync(manifest, xml.replace(/Version="[^"]*"/, `Version="${msixVersion}"`))
    },
    postMake: async (forgeConfig, results) => {
      if (!buildMsix) {
        return
      }

      for (const result of results) {
        if (result.platform !== 'win32') continue
        for (const artifact of result.artifacts) {
          if (!artifact.endsWith('.msix')) continue
          const standardDir = path.join(__dirname, 'out', `${appName}-win32-${result.arch}`)
          fs.mkdirSync(standardDir, { recursive: true })
          const dest = path.join(standardDir, path.basename(artifact))
          fs.renameSync(artifact, dest)
          result.artifacts[result.artifacts.indexOf(artifact)] = dest
        }
      }
      if (isWindows) {
        fs.rmSync(path.join(__dirname, 'out', 'make'), { recursive: true, force: true })
      }
    }
  },

  plugins: [
    {
      name: 'electron-forge-plugin-universal-prebuilds',
      config: {}
    },
    {
      name: 'electron-forge-plugin-prune-prebuilds',
      config: {}
    }
  ]
}

function resolveDesktopBuildNumber() {
  const raw = String(process.env.DESKTOP_BUILD_NUMBER || '').trim()
  if (!raw) return 0
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) return 0
  return parsed
}

function resolveMsixVersion(version, buildNumber) {
  const match = String(version || '').match(/^(\d+)\.(\d+)\.(\d+)/)
  const major = match ? Number.parseInt(match[1], 10) : 0
  const minor = match ? Number.parseInt(match[2], 10) : 0
  const patch = match ? Number.parseInt(match[3], 10) : 0
  const revision = normalizeMsixRevision(buildNumber)
  return `${major}.${minor}.${patch}.${revision}`
}

function normalizeMsixRevision(buildNumber) {
  if (!Number.isFinite(buildNumber) || buildNumber <= 0) return 0
  return buildNumber % 65535
}
