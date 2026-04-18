# PearDrop Desktop (MVP)

Electron + Pear runtime desktop app for native-first PearDrop.

## What it does

- starts a `pear-runtime` worker from Electron main process
- worker hosts P2P backend with `hyperswarm + hyperdrive + corestore`
- renderer talks to worker over RPC bridge
- upload files, generate `peardrops://invite` link, and download from invite
- stores transfer history locally in app storage

## Run

```bash
npm install
npm start
```

Optional flags:

```bash
npm start -- --storage /custom/path --relay ws://localhost:49443
```

## Test

```bash
npm test
```

Build distributable:

```bash
npm run make:darwin
```

Forge-based local maker (unsigned/debug packaging path):

```bash
npm run make:darwin:forge
```

Build Mac App Store package (`.pkg`) locally:

```bash
npm run make:mas
```

CI workflow for App Store Connect:

- Workflow: `.github/workflows/build-store.yml`
- Triggers:
  - Manual: `workflow_dispatch` (`submit` defaults to `true`)
  - Automatic upload on release tags: `desktop-v*` (always submits to App Store Connect)
- Required secrets for build:
  - `MAC_CODESIGN_CERT_P12_BASE64`
  - `MAC_CODESIGN_CERT_PASSWORD`
  - Optional dedicated installer cert: `MAC_INSTALLER_CERT_P12_BASE64`, `MAC_INSTALLER_CERT_PASSWORD`
  - `MAC_APP_STORE_PROVISIONING_PROFILE_BASE64`
- Additional secrets for upload (`submit: true`), either option works:
  - Option A (App Store Connect API): `ASC_API_KEY_ID`, `ASC_API_ISSUER_ID`, `ASC_API_KEY_P8_BASE64`
  - Option B (Apple account): `APPLE_ID`, `APPLE_PASSWORD` (optional: `APPLE_TEAM_ID`)
