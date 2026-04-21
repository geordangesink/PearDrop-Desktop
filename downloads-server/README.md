# PearDrop Downloads Server

Simple Node/Express service for uploading and serving static artifacts in development.

## Local Run

```bash
npm install
npm start
```

## Config

- `PORT` (optional, default: `3000`)
- `UPLOAD_TOKEN` (required for write endpoints)
- `DOWNLOAD_ROOT` (optional storage root)

## API

- `GET /health` and `GET /healthz` health checks
- `PUT /upload?path=<relative/path>` upload file bytes
- `POST /promote-latest` create/update an alias target
- `GET /downloads/<relative/path>` serve stored file

## Local Examples

Upload:

```bash
curl -X PUT \
  "http://127.0.0.1:3000/upload?path=example/test.bin" \
  -H "x-upload-token: dev-token" \
  --data-binary @./test.bin
```

Download headers:

```bash
curl -I "http://127.0.0.1:3000/downloads/example/test.bin"
```
