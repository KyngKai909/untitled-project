# OpenChannel MVP

Local MVP for a single-web-app experience that combines:

- Public viewer pages (watch channels)
- Creator Studio (upload/import media, queue programs, control playout)
- 24/7 channel playout worker that emits rolling HLS output
- Custom in-app branded player (channel label + accent color, not browser default controls)

## What this MVP proves

1. A creator can make channels in one app.
2. A channel can ingest media by file upload and by external URL extraction (`yt-dlp`).
3. The playout worker can continuously loop prerecorded content to create a 24/7 stream.
4. Ad clips can be auto-inserted after every N programs.
5. Viewer pages can play the generated live HLS feed.
6. Creator can configure RTMP destinations for future multistream forwarding.
7. Creator can set channel player branding in Studio (`playerLabel` and accent color).
8. `Go Live` can provision Livepeer stream output and expose public playback URL.
9. Uploaded/imported assets can be pinned to IPFS via Pinata when `PINATA_JWT` is configured.

## Monorepo Layout

- `apps/web`: Vite + React single frontend app (viewer + studio routes)
- `apps/api`: Express API for channels/assets/playlist/control
- `apps/worker`: playout loop + FFmpeg HLS segmenter
- `packages/shared`: shared TypeScript domain types
- `storage`: local uploaded files, HLS output, and `db.json`

## Prerequisites

Install on your machine:

1. Node.js 20+
2. npm 10+
3. `ffmpeg` + `ffprobe`
4. `yt-dlp` (for external URL extraction)

## Local Setup

1. Install dependencies:

```bash
npm install
```

2. Start everything:

```bash
npm run dev
```

3. Open the app:

- [http://localhost:5173](http://localhost:5173)

API runs at:

- [http://localhost:8787](http://localhost:8787)

## Livepeer + IPFS Setup

To test internet-accessible live playback and decentralized storage:

1. Set `LIVEPEER_API_KEY` in `.env`.
2. Set `PINATA_JWT` in `.env` (optional, for IPFS pinning).
3. Restart `npm run dev`.
4. In Studio, click `Provision Stream` under `Livepeer Output`.
5. Click `Go Live` in playout controls.
6. Open the `Public stream URL` from Studio on another device.

## Quick Test Flow

1. Create a channel from home page.
2. In Studio, upload program clips (and at least one ad clip for ad pool).
3. Optionally import external media URL.
4. Add program assets to the queue draft and save queue.
5. Set ad interval (e.g. 2 programs).
6. Click `Go Live`.
7. Open `Watch` page and verify live playback.
8. Test `Skip current` and `Stop`.
9. For cross-device internet playback, use the Livepeer public URL in Studio.

## Optional: Generate Sample Media

```bash
./scripts/create-sample-media.sh
```

This generates files in `storage/uploads/samples`.

## External URL Extraction + Legal

External extraction is implemented via `yt-dlp` as an MVP capability. You should only ingest media you are licensed/authorized to use. Platform terms and copyright law still apply.

If ingest fails with `Failed to run yt-dlp`, install binaries and retry:

```bash
brew install yt-dlp ffmpeg
```

Alternative Python install:

```bash
python3 -m pip install -U yt-dlp
```

## Playout Core (Hard Part)

The worker (`apps/worker`) does this loop per running channel:

1. Resolve next program from playlist.
2. Auto-insert ad clip if ad interval threshold is reached.
3. Spawn FFmpeg for that item and append rolling HLS segments.
4. On completion, advance playout state and continue forever.
5. React to commands from API (`start`, `stop`, `skip`).

This is a practical local MVP playout model, not yet production-grade broadcast playout.

## Current MVP Limits

- JSON file datastore (`storage/db.json`) instead of Postgres.
- No auth, permissions, moderation, or robust social features yet.
- No DRM, no signed URL access, no geo restrictions.
- No true gapless switching guarantees across all assets.
- No real ad decision server yet (ad insertion uses local clip pool + interval rule).
- Multistream destination forwarding worker is not wired yet (destination configs are stored/configurable in Studio).

## IPFS / Pinata Fit

For this MVP, local filesystem storage keeps debugging simple. For next phase, assets can be moved to Pinata/IPFS for origin storage while the playout worker still fetches/transcodes local cache copies for deterministic live output.

Suggested alpha path:

1. Upload asset to Pinata.
2. Persist CID + metadata in DB.
3. Worker pulls/pins asset into cache before playout.
4. Keep HLS edge outputs on fast object/CDN storage (or Livepeer-compatible flow).

## Alpha/Beta Hardening Roadmap

1. Replace JSON DB with Postgres + migrations.
2. Add job queue (BullMQ/Redis) for ingest/transcode/playout tasks.
3. Add structured playout timeline model with deterministic schedule windows.
4. Add destination manager for multistream RTMP outputs.
5. Integrate Livepeer APIs for production ingest/transcode/distribution flow.
6. Add auth + creator org roles + viewer accounts.
7. Add analytics, ad reporting, and failover monitoring.
