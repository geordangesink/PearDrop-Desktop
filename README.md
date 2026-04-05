# Pear Drops Desktop (MVP)

Electron + Pear runtime desktop app for native-first Pear Drops.

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
