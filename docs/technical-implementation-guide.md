# OpenChannel Technical Implementation Guide

Last updated: 2026-02-19

## 1. Scope

This guide explains:

1. How upload, extraction, storage, and streaming work in the current local MVP.
2. Why local playback can glitch.
3. What must change for a production public beta.
4. A practical production cost model with formulas and example scenarios.

Selected production direction for this project:

1. Livepeer as the livestream/transcode/distribution backbone.
2. IPFS (via Pinata) as canonical source storage for uploaded/extracted originals.
3. Hot cache/object storage + CDN for low-latency HLS serving to viewers.

## 2. How It Works Today (Local MVP)

### 2.1 Current Runtime Topology

The MVP runs 3 local processes:

1. `apps/web` (Vite React frontend)
2. `apps/api` (Express API)
3. `apps/worker` (playout worker + FFmpeg HLS generation)

Persistent local paths:

1. `storage/db.json` (entire app data model)
2. `storage/uploads/<channelId>/...` (uploaded/extracted source media)
3. `storage/hls/<channelId>/index.m3u8 + seg_*.ts` (live stream output)

Optional external services now wired:

1. Livepeer API (stream provisioning + public playback URL)
2. Pinata API (IPFS pinning of uploaded/extracted originals)

Relevant files:

1. `apps/api/src/server.ts`
2. `apps/api/src/media.ts`
3. `apps/api/src/db.ts`
4. `apps/worker/src/worker.ts`
5. `apps/worker/src/ffmpeg.ts`

### 2.2 Channel and Playlist Data Model

Current data model is file-backed JSON and includes:

1. Channels (`name`, `slug`, `adInterval`, `brandColor`, `playerLabel`)
2. Assets (`program` or `ad`, source type `upload` or `external`, local file path)
3. Playlist items (program queue order)
4. Playout state (`isRunning`, `queueIndex`, current item)
5. Commands (`start`, `stop`, `skip`) consumed by worker
6. Multistream destinations (stored, not forwarded yet)
7. Livepeer config (provisioned stream id/key/playback url + enabled flag)
8. Asset storage metadata (`storageProvider`, `ipfsCid`, `ipfsUrl`)

### 2.3 Upload Flow (Current)

API endpoint: `POST /api/channels/:channelId/assets/upload`

1. Frontend posts multipart form with video file.
2. API stores temp file via `multer`.
3. API moves file to `storage/uploads/<channelId>/<assetId>.<ext>`.
4. API probes duration with `ffprobe`.
5. If `PINATA_JWT` is configured, API uploads the file to Pinata and stores CID/url.
6. API writes asset record to `db.json`.

### 2.4 External Extraction Flow (Current)

API endpoint: `POST /api/channels/:channelId/assets/external`

1. Frontend submits external URL.
2. API runs extractor in this order:
   1. `yt-dlp`
   2. `python3 -m yt_dlp`
   3. `python -m yt_dlp`
3. Download target is `storage/uploads/<channelId>/<assetId>.%(ext)s`.
4. If `PINATA_JWT` is configured, API pins the result to IPFS via Pinata.
5. API stores local path plus optional IPFS metadata in `db.json`.

Notes:

1. If `yt-dlp` binary is present but extraction fails, API returns actual extraction error.
2. If tooling is missing, API returns install guidance.
3. Legal rights validation is not enforced in code yet.

### 2.5 24/7 Live Streaming / Playout (Current)

Control endpoint: `POST /api/channels/:channelId/control` with `start|stop|skip`.

Worker behavior (`apps/worker/src/worker.ts`):

1. Poll commands from `db.json` every `WORKER_POLL_INTERVAL_MS`.
2. For each running channel, choose next asset:
   1. Program from playlist
   2. Ad from ad pool if `programCountSinceAd >= adInterval`
3. Spawn FFmpeg for the chosen file and write rolling HLS into `storage/hls/<channelId>/`.
4. If Livepeer is provisioned+enabled, worker starts an FFmpeg forwarder from local HLS to Livepeer RTMP ingest.
5. Update playout state and continue forever.

Current FFmpeg HLS settings (`apps/worker/src/ffmpeg.ts`):

1. Segment size: 4s
2. Playlist size: 30 segments
3. Flags: `append_list+omit_endlist+independent_segments+program_date_time`

Livepeer provisioning behavior:

1. `Go Live` triggers API control start.
2. If `LIVEPEER_API_KEY` exists, API auto-provisions a Livepeer stream for the channel (or reuses existing config).
3. Studio exposes Livepeer public playback URL for cross-device/public internet testing.

### 2.6 Viewer Playback (Current)

1. Watch page requests channel detail once, then status polls every ~2.5s.
2. Player loads stable HLS source URL (no periodic source cache-busting now).
3. Custom branded player UI is rendered in-app (not default browser controls).
4. Studio exposes Livepeer public playback URL when provisioned, for external device testing.

### 2.7 Livepeer + IPFS Runtime Behavior (Current)

1. `Go Live` calls `POST /api/channels/:channelId/control` with `action=start`.
2. If `LIVEPEER_API_KEY` is set, API provisions (or reuses) a Livepeer stream config for the channel.
3. Worker reads channel Livepeer config and starts an FFmpeg forwarder from local HLS manifest to Livepeer RTMP ingest.
4. Studio shows Livepeer playback URL for external device testing.
5. On upload/extract, if `PINATA_JWT` is set, API pins media to IPFS via Pinata and stores CID/url on asset metadata.

## 3. Why Glitches Still Happen in MVP

Even after the player-side fix, transition glitches can still happen because:

1. FFmpeg process restarts per asset boundary.
2. No timeline-stitching layer to guarantee seamless packet continuity.
3. No redundant playout worker per channel (single worker process).
4. Local disk IO and single-host CPU contention can cause segment write jitter.
5. No origin/CDN separation with origin shield.

Local MVP validates the concept, but not broadcast-grade continuity.

## 4. Production Public Beta Architecture

## 4.1 Control Plane

1. API service (authn/authz, channel CRUD, playlists, destinations)
2. Postgres (normalized metadata, schedules, audit logs)
3. Redis + queue (ingest/transcode/playout commands)
4. Object permissions service (signed URLs)

## 4.2 Ingest Plane

1. Direct-to-storage upload (presigned URL, resumable)
2. External extraction workers (isolated sandbox, strict allow/deny + rate limits)
3. Malware/content scanning + media validation
4. Canonical transcode pipeline (ladder presets)

## 4.3 Playout Plane (Hard Part)

For public beta, move from per-asset process hops to continuous playout graph:

1. Per-channel persistent playout process (or service graph) that reads timeline events.
2. Segment continuity controller (PTS/DTS continuity, drift correction).
3. Redundant hot-standby playout per channel group.
4. Health watchdog with auto-failover.

## 4.4 Delivery Plane

1. Origin for HLS manifests/segments (object storage or stream origin service)
2. CDN in front of origin
3. Per-region caching + tokenized playback URLs
4. Viewer analytics and QoE monitoring (rebuffer ratio, join time, fatal errors)

## 4.5 Data/Storage Plane

Use a two-tier model aligned to your stated direction:

1. Canonical originals: IPFS/Pinata for decentralized, content-addressed storage
2. Hot media/segments: object storage optimized for serving/transcode cache

Recommendation:

1. Keep live HLS segment serving on low-latency object storage + CDN.
2. Store source assets and rights metadata against CID in Pinata/IPFS.
3. Materialize from CID into hot cache before playout/transcode.
4. Keep CID references in Postgres so channel timelines are reproducible.

## 4.6 Multistream Plane

Current MVP stores destination configs only.

For beta you need:

1. Forwarding worker that publishes RTMP from channel output to enabled destinations.
2. Per-destination health state and retry policy.
3. Rate limiting and key rotation support.

## 4.7 Trust, Safety, and Legal Controls

For extraction in production:

1. Terms-aware source policy (platform allowlist/denylist)
2. Rights attestation per import
3. DMCA workflow + rapid takedown path
4. Content fingerprinting and duplicate detection
5. Repeat-infringer policy enforcement

## 5. Production Cost Model

## 5.1 Cost Buckets

Your recurring costs come from:

1. Ingest/extraction compute
2. Transcoding
3. Storage (hot + archive)
4. CDN/video delivery (usually largest)
5. Playout compute
6. Control-plane infra (API, DB, queue, observability)

## 5.2 Core Variables

Use these planning variables:

1. `C_live`: concurrent always-on channels
2. `H_month`: hours per month (~730)
3. `V_avg`: average concurrent viewers platform-wide
4. `VH`: viewer-hours = `V_avg * H_month`
5. `A_hours`: total library hours stored
6. `S_tb`: media storage TB

## 5.3 Cost Formulas (Vendor-Agnostic)

1. `TranscodeCost = LiveChannelHours * TranscodeRatePerHour`
2. `DeliveryCost = ViewerHours * DeliveryRatePerViewerHour`
3. `StorageCost = StoredGB * StorageRatePerGBMonth`
4. `PlayoutComputeCost = ChannelWorkers * WorkerCostPerMonth`
5. `Total = Transcode + Delivery + Storage + Compute + ControlPlane`

## 5.4 Reference Pricing Inputs (Check Before Commit)

Livepeer Studio pricing page (as crawled recently):

1. Growth tier minimum spend: $100/mo
2. Transcoding: `$0.33 / 60 minutes`
3. Storage: `$0.09 / 60 minutes`
4. Delivery: `$0.03 / 60 minutes`

Pinata pricing page (as crawled recently):

1. Free: 1GB
2. Picnic: $20/mo (1TB)
3. Fiesta: $100/mo (5TB)
4. Overage examples shown: storage, bandwidth, requests

Cloudflare R2 pricing docs (as crawled recently):

1. Standard storage: `$0.015 / GB-month`
2. Class A ops: `$4.50 / million`
3. Class B ops: `$0.36 / million`
4. Internet egress: free

AWS CloudFront pricing context (as crawled recently):

1. Flat-rate plans introduced (Free/Pro/Business/Premium)
2. Pay-as-you-go still exists

Amazon S3 pricing page (as crawled recently):

1. Object storage + request + transfer components remain core pricing drivers
2. First 100GB/month internet transfer out (aggregated AWS services) noted as free

## 5.5 Example Beta Scenarios (Planning Only)

These are directional examples, not quotes.

### Scenario A: Early Public Beta

Assumptions:

1. `C_live = 10` always-on channels
2. `V_avg = 250`
3. `A_hours = 5,000`
4. Livepeer reference rates above

Derived:

1. Channel-hours = `10 * 730 = 7,300`
2. Viewer-hours = `250 * 730 = 182,500`

Estimated video infra only:

1. Transcode: `7,300 * 0.33 = $2,409`
2. Delivery: `182,500 * 0.03 = $5,475`
3. Storage: `5,000 * 0.09 = $450`
4. Subtotal: `~$8,334/mo` (+ platform/control-plane costs)

### Scenario B: Growth Beta

Assumptions:

1. `C_live = 25`
2. `V_avg = 1,000`
3. `A_hours = 20,000`
4. Same reference rates

Derived:

1. Channel-hours = `18,250`
2. Viewer-hours = `730,000`

Estimated video infra only:

1. Transcode: `18,250 * 0.33 = $6,022.50`
2. Delivery: `730,000 * 0.03 = $21,900`
3. Storage: `20,000 * 0.09 = $1,800`
4. Subtotal: `~$29,722.50/mo` (+ platform/control-plane costs)

Interpretation:

1. Delivery/viewer-hours usually dominate cost.
2. Reducing egress/CDN cost per viewer-hour has the largest impact.

## 5.6 Where Cost Optimizations Matter Most

1. Increase cache hit ratio for hot segments.
2. Use adaptive bitrate ladders carefully (do not over-generate renditions).
3. Tier storage by temperature (hot/warm/cold).
4. Deduplicate source assets and transcode derivatives.
5. Smart ad insertion and shorter startup latency reduce churn.

## 6. Local MVP vs Production Beta Gap

### 6.1 What You Already Have

1. End-to-end channel creation and asset ingest
2. External extraction
3. Playlist + ad interval logic
4. 24/7 continuous loop concept
5. Custom branded player
6. Destination config model for multistream

### 6.2 What You Need Before Public Beta

1. Auth, org/role model, secure sessions
2. Postgres + migrations + backups
3. Queue-based ingest and playout orchestration
4. Fault-tolerant playout architecture (redundant)
5. CDN tokenized delivery and anti-abuse controls
6. Moderation, takedown, legal workflows
7. Full observability and on-call alerting
8. Billing/usage metering and quotas
9. Destination forwarding workers for multistream
10. Pen test + hardening + rate limiting

## 7. Suggested Public Beta Rollout Plan

### Phase 0: Internal Reliability (1-2 weeks)

1. Replace `db.json` with Postgres.
2. Add Redis queue + worker retries.
3. Add structured logs + metrics + alerts.

### Phase 1: Closed Beta (2-4 weeks)

1. Enable creator auth + channel ownership.
2. Add legal attestation for external imports.
3. Enable multistream forwarding to 1-2 destinations.

### Phase 2: Public Beta (4-8 weeks)

1. Capacity limits + billing guardrails.
2. Harden extraction pipeline abuse controls.
3. Regional CDN tuning + QoE dashboards.

## 8. Practical Recommendation for Your Product Direction

Given your goals (cheap core infrastructure + social app monetization) and selected stack (Livepeer + IPFS):

1. Keep the social/viewer app as your main product surface.
2. Make channel playout costs predictable with strict plan limits.
3. Use decentralized/archive storage where it helps provenance and retention.
4. Keep live segment serving on low-latency hot storage + CDN.
5. Treat ad products and destination forwarding as first-class cost controls.

## 9. Source Links (Pricing / Vendor References)

1. Livepeer Studio pricing: <https://livepeer.studio/pricing>
2. Livepeer Pipelines pricing notes: <https://pipelines.livepeer.org/docs/knowledge-base/reference/pricing>
3. Pinata pricing: <https://pinata.cloud/pricing>
4. Pinata pricing update blog: <https://pinata.cloud/blog/pinatas-new-pricing-no-more-pin-limits-more-storage-for-less/>
5. Cloudflare R2 pricing: <https://developers.cloudflare.com/r2/pricing/>
6. Amazon S3 pricing: <https://aws.amazon.com/s3/pricing/>
7. Amazon CloudFront pricing: <https://aws.amazon.com/cloudfront/pricing/>
8. CloudFront flat-rate plan docs: <https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/flat-rate-pricing-plan.html>
9. AWS flat-rate plans overview: <https://docs.aws.amazon.com/PricingPlanManager/latest/UserGuide/plans.html>
