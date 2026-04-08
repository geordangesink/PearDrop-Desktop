# Pear Drop Downloads Server

Minimal upload + static download service for hosting installers without redirects.

## Environment Variables

- `PORT` (optional): defaults to `3000`
- `UPLOAD_TOKEN` (required): bearer token for upload endpoint
- `DOWNLOAD_ROOT` (optional): defaults to `/data/downloads`

## Endpoints

- `GET /health` -> health check
- `PUT /upload?path=<relative/path>` -> upload a file (requires `x-upload-token`)
- `GET /downloads/<relative/path>` -> serve uploaded file

## Railway Setup

1. Create a Railway service from this repo.
2. Set the service root directory to `downloads-server`.
3. Attach a volume mounted to `/data`.
4. Set env vars:
   - `UPLOAD_TOKEN=<strong-random-token>`
   - `DOWNLOAD_ROOT=/data/downloads`

## Upload Example

```bash
curl -X PUT \
  "https://<your-service>.up.railway.app/upload?path=win32/v0.1.0/PearDrop-Setup-0.1.0.exe" \
  -H "x-upload-token: <UPLOAD_TOKEN>" \
  --data-binary @PearDrop-Setup-0.1.0.exe
```

## Download Example

```bash
curl -I "https://<your-service>.up.railway.app/downloads/win32/v0.1.0/PearDrop-Setup-0.1.0.exe"
```
