#!/usr/bin/env node
const { spawnSync } = require('child_process')

function normalizeIdentity(value) {
  if (!value) return ''
  return String(value).trim().replace(/^Developer ID Application:\s*/, '')
}

const rawIdentity = String(process.env.MAC_CODESIGN_IDENTITY || '').trim()
if (/^3rd Party Mac Developer Application:/i.test(rawIdentity) || rawIdentity === '3rd Party Mac Developer Application') {
  console.error(
    '[make:darwin] MAC_CODESIGN_IDENTITY points to a MAS certificate (3rd Party Mac Developer Application). Use a Developer ID Application identity for notarized DMG builds.'
  )
  process.exit(1)
}

const identity = normalizeIdentity(rawIdentity)
const cscName = String(process.env.CSC_NAME || '').trim()
if (/^3rd Party Mac Developer Application/i.test(cscName)) {
  console.error(
    '[make:darwin] CSC_NAME points to a MAS certificate (3rd Party Mac Developer Application). Set CSC_NAME to Developer ID Application or remove it for DMG builds.'
  )
  process.exit(1)
}

const env = {
  ...process.env,
  SKIP_MANUAL_MAC_SIGN: '0',
  CSC_NAME: cscName || 'Developer ID Application'
}

if (identity) {
  env.MAC_CODESIGN_IDENTITY = identity
}

const result = spawnSync(
  'npx',
  ['electron-builder', '--mac', 'dmg', '--arm64', '--publish', 'never'],
  {
    stdio: 'inherit',
    env,
    shell: process.platform === 'win32'
  }
)

if (typeof result.status === 'number') {
  process.exit(result.status)
}

process.exit(1)
