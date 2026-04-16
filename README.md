# OpenCast Core MVP

This repo now focuses on the creator core path only:

1. Connect wallet (creator account)
2. Create station/channel profile
3. Upload content library
4. Schedule content windows
5. Go live via Livepeer

## Scope (what is in / out)

In scope:
- Creator dashboard with station list
- Station manager with profile, content library, playlist queue, schedules, and go-live controls
- FFmpeg-based compression pipeline on upload
- FFmpeg-based decode/repackage pipeline for live HLS playout
- Livepeer provisioning + playback URL usage
- Optional IPFS pinning through Pinata

Out of scope for this core pass:
- Discover page
- TV guide page
- External link video extraction (`yt-dlp` UI path)
- Multistream destination management

## Architecture

- `apps/web`: Vite + React creator application
- `apps/api`: Express API for channel/content/schedule/live control
- `apps/worker`: continuous playout worker (queue + HLS output + Livepeer forwarder)
- `packages/shared`: shared TS domain models
- `storage`: local files + HLS output (state persists in PostgreSQL when `DATABASE_URL` is set)

### Media pipeline

- Upload lands in `storage/uploads/<channelId>/...`
- API runs FFmpeg compression to stream-ready formats:
  - video: H.264 + AAC (MP4)
  - audio: AAC (M4A)
- Compressed artifact becomes the active playout source (`asset.localPath`)
- Worker decodes that source and repackages to rolling HLS segments for playback

This gives a practical compress/decompress flow using free open-source FFmpeg.

### State persistence

- If `DATABASE_URL` is configured, API + worker persist shared state in PostgreSQL (`opencast_state` table).
- If `DATABASE_URL` is not configured, local JSON fallback is used at `storage/db.json` (dev convenience only).

## On-chain + decentralized focus

- Live streaming output: **Livepeer** (when `LIVEPEER_API_KEY` is configured)
- Content storage metadata: **IPFS/Pinata** (when `PINATA_JWT` is configured)
- Operational infra (DB/cache/jobs): intended for off-chain deployment on Railway in next phase

## Wallet account step

The creator flow is wallet-gated in the dashboard.

Current local implementation uses injected EIP-1193 wallets (MetaMask-compatible) for fast iteration. It is structured so the account step can be replaced by Reown AppKit integration without changing station/content/schedule APIs.

## Local setup

### Prereqs

1. Node.js 20+
2. npm 10+
3. `ffmpeg` and `ffprobe`

### Run

```bash
npm install
npm run dev
```

Stable no-watch runtime (useful for local parity with Railway):

```bash
npm run dev:runtime
```

Web app:
- [http://localhost:5173](http://localhost:5173)

API:
- [http://localhost:8787](http://localhost:8787)

## Env

Use `.env.example` as baseline. Important keys:

- `DATABASE_URL` (recommended; enables PostgreSQL-backed shared state)
- `LIVEPEER_API_KEY` (for provisioning and using Livepeer playback)
- `PINATA_JWT` (for IPFS pinning)
- `STORAGE_ROOT` (optional, defaults to `./storage`)

## Core test flow

1. Open dashboard and connect wallet.
2. Create a station.
3. Open station manager.
4. Upload one or more program assets.
5. Add uploaded program assets to playlist queue and save queue.
6. Optionally create a schedule window.
7. Provision Livepeer (if API key is configured), then enable Livepeer output.
8. Click **Go Live**.
9. Open station preview and verify HLS playback.

## Railway deployment modes

### Split services (recommended)

Use three app services:
- `@openchannel/web`: creator frontend
- `@openchannel/api`: API + upload/compression + Livepeer control
- `@openchannel/worker`: playout scheduler/loop worker

This keeps deploys and scaling independent and is the correct base for future consumer app, external APIs, and SDK work.

#### One-time service configuration (Railway CLI)

```bash
# API service
railway variables --service @openchannel/api --environment production \
  --set 'NIXPACKS_BUILD_CMD=npm run build:service:api' \
  --set 'NIXPACKS_START_CMD=npm run start:service:api' \
  --set 'NIXPACKS_NODE_VERSION=22.12.0' \
  --set 'SERVE_WEB_APP=false'

# Worker service
railway variables --service @openchannel/worker --environment production \
  --set 'NIXPACKS_BUILD_CMD=npm run build:service:worker' \
  --set 'NIXPACKS_START_CMD=npm run start:service:worker' \
  --set 'NIXPACKS_NODE_VERSION=22.12.0'

# Web service
railway variables --service @openchannel/web --environment production \
  --set 'NIXPACKS_BUILD_CMD=npm run build:service:web' \
  --set 'NIXPACKS_START_CMD=npm run start:service:web' \
  --set 'NIXPACKS_NODE_VERSION=22.12.0'
```

#### Required runtime variables

- `@openchannel/api`: `DATABASE_URL`, `STORAGE_ROOT=/data/storage`, `WEB_ORIGIN=<web-service-url>`, `LIVEPEER_API_KEY` (optional), `PINATA_JWT` (optional)
- `@openchannel/worker`: `DATABASE_URL`, `STORAGE_ROOT=/data/storage`, `MEDIA_BASE_URL=<api-service-url>`, `WORKER_POLL_INTERVAL_MS` (optional)
- `@openchannel/web`: `API_PROXY_BASE_URL=<api-service-url>` (recommended), `VITE_API_BASE=<api-service-url>` (optional build-time override)

#### Domains

Generate one Railway domain for each internet-facing service:

```bash
railway domain --service @openchannel/api
railway domain --service @openchannel/web
```

Then set:
- `WEB_ORIGIN` on API to your web domain
- `API_PROXY_BASE_URL` on Web to your API domain

#### Deploy

```bash
railway up --service @openchannel/api --environment production --detach
railway up --service @openchannel/worker --environment production --detach
railway up --service @openchannel/web --environment production --detach
```

#### Notes

- Attach persistent volume(s) to API/worker if you depend on local media files (`STORAGE_ROOT=/data/storage`).
- Keep worker replica count at `1` unless you add explicit leader election/queue partitioning.

### Single service (legacy)

`opencast-core` runs API + worker + web in one service. Keep this only for quick demos.
