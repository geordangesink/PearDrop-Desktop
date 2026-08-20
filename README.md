# PearDrop Desktop

Electron desktop client for running and joining native PearDrop host sessions.

## Dev Architecture

- Electron main process manages app lifecycle and worker IPC.
- Renderer UI communicates with the worker through RPC.
- Worker uses `native-shared` transfer backend (`hyperswarm`, `hyperdrive`, `corestore`).

## Local Run

```bash
npm install
npm start
```

Optional local flags:

```bash
npm start -- --storage /custom/path --relay ws://localhost:49443
```

## Tests

```bash
npm test
```

## Release

stage to pear://gcczmxycaa1bo56943bn8zg1f4ci8ngpaye3mz4u4wocb6br56by
-> multisig

## Notes for Contributors

- Keep renderer and worker responsibilities separated.
- Prefer shared backend changes in `../native-shared` when behavior is cross-platform.
- Use non-interactive scripts/commands in CI and local debugging flows.
