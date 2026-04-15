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
- `storage`: local files + HLS output + `db.json`

### Media pipeline

- Upload lands in `storage/uploads/<channelId>/...`
- API runs FFmpeg compression to stream-ready formats:
  - video: H.264 + AAC (MP4)
  - audio: AAC (M4A)
- Compressed artifact becomes the active playout source (`asset.localPath`)
- Worker decodes that source and repackages to rolling HLS segments for playback

This gives a practical compress/decompress flow using free open-source FFmpeg.

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

Web app:
- [http://localhost:5173](http://localhost:5173)

API:
- [http://localhost:8787](http://localhost:8787)

## Env

Use `.env.example` as baseline. Important keys:

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
