import { promises as fs } from "node:fs";
import fsSync from "node:fs";
import path from "node:path";
import cors from "cors";
import express, { type Request, type Response } from "express";
import multer from "multer";
import { v4 as uuidv4 } from "uuid";
import type {
  Asset,
  AssetInsertionCategory,
  AssetFolder,
  AssetType,
  Channel,
  DatabaseSchema,
  ExternalIngestItem,
  ExternalIngestItemStatus,
  ExternalIngestJob,
  ExternalIngestJobStatus,
  LivepeerConfig,
  MultistreamDestination,
  PlaylistItem,
  PlayoutCommand,
  StreamMode,
  StreamSchedule
} from "@openchannel/shared";
import {
  API_PORT,
  DELETE_LOCAL_AFTER_IPFS,
  HLS_ROOT,
  KEEP_ORIGINAL_UPLOADS,
  LIVEPEER_DEFAULT_ENABLED,
  MAX_COMPRESSION_INPUT_BYTES,
  UPLOAD_STORAGE_MODE,
  UPLOAD_ROOT,
  WEB_DIST_DIR,
  WEB_ORIGIN
} from "./config.js";
import { getChannel, getChannelAssets, getOrCreatePlayoutState, readDb, transaction } from "./db.js";
import { hasPinataJwt, uploadFileToIpfs } from "./ipfs.js";
import { createLivepeerStream, hasLivepeerApiKey } from "./livepeer.js";
import {
  compressForStreaming,
  expandExternalUrls,
  ingestFromExternalUrl,
  isNoSpaceCompressionError,
  probeDurationSec,
  probeMediaKind
} from "./media.js";
import { nowIso, slugify } from "./utils.js";

const app = express();
const upload = multer({ dest: path.join(UPLOAD_ROOT, "tmp") });

function addCorsOriginWithAliases(input: string, allowed: Set<string>) {
  const trimmed = input.trim();
  if (!trimmed) {
    return;
  }
  try {
    const base = new URL(trimmed);
    allowed.add(base.origin);
    if (base.hostname === "localhost") {
      const alias = new URL(trimmed);
      alias.hostname = "127.0.0.1";
      allowed.add(alias.origin);
    } else if (base.hostname === "127.0.0.1") {
      const alias = new URL(trimmed);
      alias.hostname = "localhost";
      allowed.add(alias.origin);
    }
  } catch {
    allowed.add(trimmed);
  }
}

function allowedCorsOrigins(): { allowAnyOrigin: boolean; allowedOrigins: Set<string> } {
  const allowed = new Set<string>();
  const configured = WEB_ORIGIN.trim();
  if (!configured || configured === "*") {
    return { allowAnyOrigin: true, allowedOrigins: allowed };
  }

  let allowAnyOrigin = false;
  for (const origin of configured.split(",")) {
    const trimmed = origin.trim();
    if (!trimmed) {
      continue;
    }
    if (trimmed === "*") {
      allowAnyOrigin = true;
      continue;
    }
    addCorsOriginWithAliases(trimmed, allowed);
  }

  return { allowAnyOrigin, allowedOrigins: allowed };
}

const corsConfig = allowedCorsOrigins();

app.use(
  cors({
    origin(origin, callback) {
      if (!origin || corsConfig.allowAnyOrigin || corsConfig.allowedOrigins.has(origin)) {
        callback(null, true);
        return;
      }

      callback(new Error(`Origin ${origin} is not allowed by CORS.`));
    }
  })
);
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

app.use(
  "/hls",
  express.static(HLS_ROOT, {
    setHeaders: (res) => {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Cache-Control", "no-store");
    }
  })
);
app.use("/uploads", express.static(UPLOAD_ROOT));
app.get("/api/health", (_req, res) => {
  res.json({ ok: true, timestamp: nowIso() });
});

function sendError(res: Response, status: number, error: string) {
  res.status(status).json({ error });
}

function hasError(value: unknown): value is { error: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "error" in value &&
    typeof (value as { error?: unknown }).error === "string"
  );
}

function statusForPayloadError(error: string): number {
  return /not found/i.test(error) ? 404 : 400;
}

function getLivepeerConfigForChannel(db: { livepeerConfigs: LivepeerConfig[] }, channelId: string) {
  return db.livepeerConfigs.find((entry) => entry.channelId === channelId);
}

function publicLivepeer(config: LivepeerConfig | undefined) {
  if (!config) {
    return undefined;
  }

  const { streamKey: _streamKey, ...publicConfig } = config;
  return publicConfig;
}

function pickStreamUrl(channelId: string, livepeerConfig?: LivepeerConfig): string {
  if (livepeerConfig?.enabled && livepeerConfig.playbackUrl) {
    return livepeerConfig.playbackUrl;
  }

  return `/hls/${channelId}/index.m3u8`;
}

function hasUsableDestination(destination: MultistreamDestination): boolean {
  return Boolean(destination.enabled && destination.rtmpUrl.trim() && destination.streamKey.trim());
}

function hasEnabledCustomOutput(db: Pick<DatabaseSchema, "destinations">, channelId: string): boolean {
  return db.destinations.some((destination) => destination.channelId === channelId && hasUsableDestination(destination));
}

function normalizeAssetType(value: unknown): AssetType {
  return value === "ad" ? "ad" : "program";
}

function normalizeInsertionCategory(value: unknown, type: AssetType): AssetInsertionCategory {
  if (type === "program") {
    return "program";
  }
  if (value === "sponsor" || value === "bumper" || value === "ad") {
    return value;
  }
  return "ad";
}

function toLibraryScopeId(ownerWallet: string): string {
  return `library:${ownerWallet}`;
}

function toStorageScopeId(scopeId: string): string {
  const normalized = scopeId.trim().toLowerCase();
  return normalized.replace(/[^a-z0-9_-]/g, "_");
}

function getCreatorLibraryAssets(db: Pick<DatabaseSchema, "assets">, ownerWallet: string): Asset[] {
  const scopeId = toLibraryScopeId(ownerWallet);
  return db.assets.filter((asset) => asset.channelId === scopeId);
}

function normalizeStreamMode(value: unknown): StreamMode {
  return value === "radio" ? "radio" : "video";
}

function normalizeBrandColor(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const candidate = value.trim();
  return /^#[0-9a-fA-F]{6}$/.test(candidate) ? candidate.toLowerCase() : undefined;
}

function normalizePlayerLabel(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, 48) : undefined;
}

function normalizeWalletAddress(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) {
    return undefined;
  }
  return /^0x[a-f0-9]{40}$/.test(trimmed) ? trimmed : undefined;
}

function formatMiB(valueBytes: number): string {
  return `${Math.round(valueBytes / (1024 * 1024))}MB`;
}

function isHttpUrl(value: string | undefined): boolean {
  if (!value) {
    return false;
  }
  return /^https?:\/\//i.test(value);
}

async function removeLocalFiles(paths: Array<string | undefined>): Promise<void> {
  const unique = new Set<string>();
  for (const candidate of paths) {
    if (!candidate || isHttpUrl(candidate)) {
      continue;
    }
    unique.add(candidate);
  }

  for (const filePath of unique) {
    await fs.unlink(filePath).catch(() => undefined);
  }
}

function normalizeBackgroundUploadPath(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }

  return trimmed.startsWith("/uploads/") ? trimmed : undefined;
}

function normalizeChannelImageUrl(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }

  if (trimmed.startsWith("/uploads/")) {
    return trimmed;
  }

  return /^https?:\/\/\S+$/i.test(trimmed) ? trimmed : undefined;
}

function isSupportedImageFile(file: Express.Multer.File | undefined): boolean {
  if (!file) {
    return false;
  }

  const mime = (file.mimetype ?? "").toLowerCase();
  if (mime.startsWith("image/")) {
    return true;
  }

  const ext = path.extname(file.originalname || "").toLowerCase();
  return [".jpg", ".jpeg", ".png", ".webp", ".gif"].includes(ext);
}

function uniqueSlug(baseSlug: string, channels: Channel[]): string {
  if (!channels.some((channel) => channel.slug === baseSlug)) {
    return baseSlug;
  }

  let i = 2;
  while (channels.some((channel) => channel.slug === `${baseSlug}-${i}`)) {
    i += 1;
  }

  return `${baseSlug}-${i}`;
}

function hydratePlaylist(channelId: string, items: PlaylistItem[], assets: Asset[]) {
  const assetsById = new Map(assets.map((asset) => [asset.id, asset]));
  return items
    .filter((item) => item.channelId === channelId)
    .sort((a, b) => a.position - b.position)
    .map((item) => ({
      ...item,
      asset: assetsById.get(item.assetId)
    }))
    .filter((item) => item.asset);
}

function getChannelFolders(db: Pick<DatabaseSchema, "assetFolders">, channelId: string): AssetFolder[] {
  return db.assetFolders
    .filter((folder) => folder.channelId === channelId)
    .sort((a, b) => a.name.localeCompare(b.name) || a.createdAt.localeCompare(b.createdAt));
}

function normalizeOptionalFolderId(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function createsFolderCycle(folders: AssetFolder[], folderId: string, nextParentFolderId: string): boolean {
  let cursor: string | undefined = nextParentFolderId;
  const visited = new Set<string>();
  while (cursor) {
    if (cursor === folderId) {
      return true;
    }
    if (visited.has(cursor)) {
      return true;
    }
    visited.add(cursor);
    cursor = folders.find((folder) => folder.id === cursor)?.parentFolderId;
  }
  return false;
}

function getChannelSchedules(db: Pick<DatabaseSchema, "streamSchedules">, channelId: string): StreamSchedule[] {
  return db.streamSchedules
    .filter((schedule) => schedule.channelId === channelId)
    .sort((a, b) => a.startAt.localeCompare(b.startAt) || a.createdAt.localeCompare(b.createdAt));
}

function normalizeIsoDateTime(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) {
    return undefined;
  }
  return parsed.toISOString();
}

async function ensureLivepeerChannelConfig(channelId: string): Promise<LivepeerConfig> {
  const db = await readDb();
  const channel = getChannel(db, channelId);
  if (!channel) {
    throw new Error("Channel not found.");
  }

  const existing = getLivepeerConfigForChannel(db, channel.id);
  if (existing?.streamId && existing.streamKey && existing.playbackId && existing.ingestUrl) {
    const canonicalPlaybackUrl = `https://playback.livepeer.studio/hls/${existing.playbackId}/index.m3u8`;
    if (existing.playbackUrl !== canonicalPlaybackUrl) {
      return transaction((editable) => {
        const config = getLivepeerConfigForChannel(editable, channel.id);
        if (!config) {
          throw new Error("Livepeer config not found.");
        }
        config.playbackUrl = canonicalPlaybackUrl;
        config.updatedAt = nowIso();
        return config;
      });
    }
    return existing;
  }

  const provisioned = await createLivepeerStream(`${channel.slug || channel.name}-${Date.now()}`);
  return transaction((editable) => {
    let config = getLivepeerConfigForChannel(editable, channel.id);
    if (!config) {
      config = {
        channelId: channel.id,
        enabled: LIVEPEER_DEFAULT_ENABLED,
        updatedAt: nowIso()
      };
      editable.livepeerConfigs.push(config);
    }

    config.streamId = provisioned.streamId;
    config.streamKey = provisioned.streamKey;
    config.playbackId = provisioned.playbackId;
    config.playbackUrl = provisioned.playbackUrl;
    config.ingestUrl = provisioned.ingestUrl;
    config.lastError = undefined;
    config.updatedAt = nowIso();
    return config;
  });
}

const EXTERNAL_INGEST_JOB_HISTORY_LIMIT = 40;
const activeExternalIngestChannels = new Set<string>();
const externalIngestAbortControllers = new Map<string, AbortController>();

function isExternalIngestItemTerminal(status: ExternalIngestItemStatus): boolean {
  return status === "completed" || status === "failed" || status === "canceled";
}

function isExternalIngestJobTerminal(status: ExternalIngestJobStatus): boolean {
  return status === "completed" || status === "partial" || status === "failed" || status === "canceled";
}

function isCancellationError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return /cancel(ed|ation)/i.test(error.message);
}

function dedupeStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function parseExternalUrlInput(raw: unknown): string[] {
  const tokens: string[] = [];

  if (typeof raw === "string") {
    tokens.push(raw);
  } else if (Array.isArray(raw)) {
    for (const value of raw) {
      if (typeof value === "string") {
        tokens.push(value);
      }
    }
  }

  const split = tokens.flatMap((value) => value.split(/\r?\n|,/));
  const urls = split
    .map((value) => value.trim())
    .filter((value) => /^https?:\/\//i.test(value));

  return dedupeStrings(urls);
}

function createExternalIngestItem(sourceUrl: string, title: string | undefined): ExternalIngestItem {
  const at = nowIso();
  return {
    id: uuidv4(),
    sourceUrl,
    title,
    status: "queued",
    progressPct: 0,
    createdAt: at,
    updatedAt: at
  };
}

function getChannelExternalJobs(db: Pick<DatabaseSchema, "externalIngestJobs">, channelId: string): ExternalIngestJob[] {
  return db.externalIngestJobs
    .filter((job) => job.channelId === channelId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function pruneExternalIngestJobs(db: DatabaseSchema, channelId: string) {
  const channelJobs = getChannelExternalJobs(db, channelId);
  const staleIds = new Set(channelJobs.slice(EXTERNAL_INGEST_JOB_HISTORY_LIMIT).map((job) => job.id));
  if (!staleIds.size) {
    return;
  }

  db.externalIngestJobs = db.externalIngestJobs.filter((job) => !staleIds.has(job.id));
}

function updateExternalIngestItem(
  job: ExternalIngestJob,
  itemId: string,
  status: ExternalIngestItemStatus,
  progressPct: number,
  patch: Partial<ExternalIngestItem> = {}
) {
  const item = job.items.find((entry) => entry.id === itemId);
  if (!item) {
    return;
  }

  item.status = status;
  item.progressPct = Math.max(0, Math.min(100, Math.round(progressPct)));
  item.updatedAt = nowIso();
  Object.assign(item, patch);
}

function updateExternalIngestProgress(job: ExternalIngestJob) {
  const total = job.items.length;
  if (job.status === "canceled") {
    if (total === 0) {
      job.progressPct = 100;
      job.finishedAt ??= nowIso();
      return;
    }
    const terminal = job.items.filter((item) => isExternalIngestItemTerminal(item.status)).length;
    job.progressPct = Math.max(job.progressPct, Math.round((terminal / total) * 100));
    if (terminal >= total) {
      job.progressPct = 100;
      job.finishedAt ??= nowIso();
    }
    return;
  }

  if (total === 0) {
    job.progressPct = job.status === "expanding" ? 5 : 0;
    return;
  }

  const averageItemProgress = Math.round(job.items.reduce((sum, item) => sum + item.progressPct, 0) / total);
  job.progressPct = Math.max(job.progressPct, averageItemProgress);

  const terminal = job.items.filter((item) => isExternalIngestItemTerminal(item.status)).length;
  job.progressPct = Math.max(job.progressPct, Math.round((terminal / total) * 100));

  if (terminal < total) {
    if (job.status !== "expanding") {
      job.status = "running";
    }
    return;
  }

  const completed = job.items.filter((item) => item.status === "completed").length;
  const failed = job.items.filter((item) => item.status === "failed").length;
  if (completed === 0) {
    job.status = "failed";
  } else if (failed > 0) {
    job.status = "partial";
  } else {
    job.status = "completed";
  }
  job.progressPct = 100;
  job.finishedAt = nowIso();
}

function cancelExternalIngestJobState(job: ExternalIngestJob, reason = "Canceled by user."): void {
  const at = nowIso();
  for (const item of job.items) {
    if (isExternalIngestItemTerminal(item.status)) {
      continue;
    }
    item.status = "canceled";
    item.progressPct = 100;
    item.startedAt ??= at;
    item.finishedAt = at;
    item.error = reason;
    item.updatedAt = at;
  }
  job.status = "canceled";
  job.error = reason;
  job.finishedAt = at;
  job.updatedAt = at;
  updateExternalIngestProgress(job);
}

async function runExternalIngestJob(jobId: string): Promise<void> {
  const abortController = new AbortController();
  externalIngestAbortControllers.set(jobId, abortController);
  try {
    const seed = await transaction((db) => {
      const job = db.externalIngestJobs.find((entry) => entry.id === jobId);
      if (!job) {
        return { error: "Job not found." as const };
      }

      if (job.status === "canceled") {
        return { error: "Job canceled." as const };
      }

      const channel = getChannel(db, job.channelId);
      if (!channel) {
        job.status = "failed";
        job.error = "Channel not found.";
        job.progressPct = 100;
        job.finishedAt = nowIso();
        job.updatedAt = nowIso();
        return { error: "Channel not found." as const };
      }

      job.status = "expanding";
      job.startedAt ??= nowIso();
      job.progressPct = Math.max(job.progressPct, 3);
      job.updatedAt = nowIso();
      return {
        channelId: channel.id,
        requestedUrls: [...job.requestedUrls],
        expandPlaylists: job.expandPlaylists,
        titlePrefix: job.titlePrefix
      };
    });

    if (hasError(seed) || !("channelId" in seed)) {
      return;
    }

    const expanded: string[] = [];
    for (const inputUrl of seed.requestedUrls) {
      if (abortController.signal.aborted) {
        throw new Error("External ingest canceled.");
      }
      const urls = seed.expandPlaylists
        ? await expandExternalUrls(inputUrl, { signal: abortController.signal })
        : [inputUrl];
      expanded.push(...urls);
    }
    if (abortController.signal.aborted) {
      throw new Error("External ingest canceled.");
    }
    const dedupedExpanded = dedupeStrings(expanded);

    const expansionResult = await transaction((db) => {
      const job = db.externalIngestJobs.find((entry) => entry.id === jobId);
      if (!job) {
        return { error: "Job not found." as const };
      }

      if (job.status === "canceled") {
        cancelExternalIngestJobState(job, job.error || "Canceled by user.");
        return { canceled: true as const };
      }

      if (!dedupedExpanded.length) {
        job.status = "failed";
        job.error = "No valid media links were found.";
        job.progressPct = 100;
        job.finishedAt = nowIso();
        job.updatedAt = nowIso();
        return { error: "No links found." as const };
      }

      job.expandedUrls = dedupedExpanded;
      job.items = dedupedExpanded.map((sourceUrl, index) => {
        const titlePrefix = seed.titlePrefix?.trim();
        const title = titlePrefix
          ? dedupedExpanded.length === 1
            ? titlePrefix
            : `${titlePrefix} #${index + 1}`
          : undefined;
        return createExternalIngestItem(sourceUrl, title);
      });
      job.status = "running";
      job.error = undefined;
      job.progressPct = 8;
      job.updatedAt = nowIso();
      return { channelId: job.channelId };
    });

    const channelId = hasError(expansionResult) ? undefined : expansionResult.channelId;
    if (!channelId) {
      return;
    }

    const channelDir = path.join(UPLOAD_ROOT, channelId);

    while (true) {
      const nextItem = await transaction((db) => {
        const job = db.externalIngestJobs.find((entry) => entry.id === jobId);
        if (!job) {
          return { kind: "done" as const };
        }

        if (job.status === "canceled") {
          cancelExternalIngestJobState(job, job.error || "Canceled by user.");
          return { kind: "canceled" as const };
        }

        const item = job.items.find((entry) => entry.status === "queued");
        if (!item) {
          updateExternalIngestProgress(job);
          job.updatedAt = nowIso();
          return { kind: "done" as const };
        }

        updateExternalIngestItem(job, item.id, "downloading", 14, {
          startedAt: nowIso(),
          error: undefined
        });
        updateExternalIngestProgress(job);
        job.status = "running";
        job.updatedAt = nowIso();
        return {
          kind: "item" as const,
          id: item.id,
          sourceUrl: item.sourceUrl,
          title: item.title
        };
      });

      if (nextItem.kind !== "item") {
        break;
      }

      const assetId = uuidv4();
      try {
        const localPath = await ingestFromExternalUrl(nextItem.sourceUrl, channelDir, assetId, {
          signal: abortController.signal
        });
        if (abortController.signal.aborted) {
          throw new Error("External ingest canceled.");
        }
        await transaction((db) => {
          const job = db.externalIngestJobs.find((entry) => entry.id === jobId);
          if (!job) {
            return;
          }
          updateExternalIngestItem(job, nextItem.id, "processing", 70);
          updateExternalIngestProgress(job);
          job.updatedAt = nowIso();
        });

        const [durationSec, mediaKind] = await Promise.all([probeDurationSec(localPath), probeMediaKind(localPath)]);
        let ipfsCid: string | undefined;
        let ipfsUrl: string | undefined;
        let storageProvider: "local" | "ipfs" = "local";
        let ipfsWarning: string | undefined;

        if (hasPinataJwt()) {
          await transaction((db) => {
            const job = db.externalIngestJobs.find((entry) => entry.id === jobId);
            if (!job) {
              return;
            }
            updateExternalIngestItem(job, nextItem.id, "uploading_ipfs", 84);
            updateExternalIngestProgress(job);
            job.updatedAt = nowIso();
          });

          try {
            const pin = await uploadFileToIpfs(localPath, nextItem.title ?? `Imported ${assetId.slice(0, 8)}`);
            ipfsCid = pin.cid;
            ipfsUrl = pin.url;
            storageProvider = "ipfs";
          } catch (error) {
            ipfsWarning = error instanceof Error ? error.message : "IPFS upload failed.";
          }
        }

        await transaction((db) => {
          const job = db.externalIngestJobs.find((entry) => entry.id === jobId);
          if (!job) {
            return;
          }

          const title = nextItem.title?.trim() || `Imported ${assetId.slice(0, 8)}`;
          const insertionCategory = normalizeInsertionCategory(undefined, job.type);
          const asset: Asset = {
            id: assetId,
            channelId: job.channelId,
            title,
            sourceType: "external",
            sourceUrl: nextItem.sourceUrl,
            localPath,
            storageProvider,
            ipfsCid,
            ipfsUrl,
            durationSec,
            type: job.type,
            insertionCategory,
            mediaKind,
            createdAt: nowIso()
          };

          db.assets.push(asset);
          updateExternalIngestItem(job, nextItem.id, "completed", 100, {
            assetId,
            finishedAt: nowIso(),
            error: ipfsWarning
          });
          updateExternalIngestProgress(job);
          job.updatedAt = nowIso();
        });
      } catch (error) {
        if (isCancellationError(error) || abortController.signal.aborted) {
          await transaction((db) => {
            const job = db.externalIngestJobs.find((entry) => entry.id === jobId);
            if (!job) {
              return;
            }
            cancelExternalIngestJobState(job, job.error || "Canceled by user.");
          });
          break;
        }

        await transaction((db) => {
          const job = db.externalIngestJobs.find((entry) => entry.id === jobId);
          if (!job) {
            return;
          }
          updateExternalIngestItem(job, nextItem.id, "failed", 100, {
            finishedAt: nowIso(),
            error: error instanceof Error ? error.message : "External ingest failed."
          });
          updateExternalIngestProgress(job);
          job.updatedAt = nowIso();
        });
      }
    }

    await transaction((db) => {
      const job = db.externalIngestJobs.find((entry) => entry.id === jobId);
      if (!job) {
        return;
      }
      updateExternalIngestProgress(job);
      job.updatedAt = nowIso();
    });
  } catch (error) {
    if (isCancellationError(error) || abortController.signal.aborted) {
      await transaction((db) => {
        const job = db.externalIngestJobs.find((entry) => entry.id === jobId);
        if (!job) {
          return;
        }
        cancelExternalIngestJobState(job, job.error || "Canceled by user.");
      });
      return;
    }

    await transaction((db) => {
      const job = db.externalIngestJobs.find((entry) => entry.id === jobId);
      if (!job) {
        return;
      }
      if (!isExternalIngestJobTerminal(job.status)) {
        job.status = "failed";
        job.progressPct = 100;
      }
      job.error = error instanceof Error ? error.message : "External ingest failed.";
      job.finishedAt = nowIso();
      job.updatedAt = nowIso();
    });
  } finally {
    externalIngestAbortControllers.delete(jobId);
  }
}

async function drainExternalIngestQueue(channelId: string) {
  if (activeExternalIngestChannels.has(channelId)) {
    return;
  }

  activeExternalIngestChannels.add(channelId);
  try {
    while (true) {
      const nextJob = await transaction((db) => {
        const candidate = db.externalIngestJobs
          .filter((job) => job.channelId === channelId && job.status === "queued")
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];

        if (!candidate) {
          return undefined;
        }

        candidate.updatedAt = nowIso();
        return { jobId: candidate.id };
      });

      if (!nextJob) {
        break;
      }

      await runExternalIngestJob(nextJob.jobId);
    }
  } finally {
    activeExternalIngestChannels.delete(channelId);
  }
}

async function recoverExternalIngestJobs() {
  const channelIds = await transaction((db) => {
    const queuedChannels = new Set<string>();
    for (const job of db.externalIngestJobs) {
      if (job.status === "running" || job.status === "expanding") {
        for (const item of job.items) {
          if (!isExternalIngestItemTerminal(item.status)) {
            item.status = "queued";
            item.progressPct = 0;
            item.updatedAt = nowIso();
          }
        }
        job.status = "queued";
        job.error = "Recovered after server restart.";
        job.finishedAt = undefined;
        job.updatedAt = nowIso();
      }

      if (job.status === "queued") {
        queuedChannels.add(job.channelId);
      }
    }

    return [...queuedChannels];
  });

  for (const channelId of channelIds) {
    void drainExternalIngestQueue(channelId);
  }
}

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "openchannel-api", at: nowIso() });
});

app.get("/api/channels", async (req, res) => {
  const ownerWalletRaw = req.query.ownerWallet;
  const ownerWalletInput = Array.isArray(ownerWalletRaw) ? ownerWalletRaw[0] : ownerWalletRaw;
  const ownerWallet = normalizeWalletAddress(ownerWalletInput);
  if (ownerWalletInput !== undefined && ownerWalletInput !== "" && !ownerWallet) {
    return sendError(res, 400, "ownerWallet must be a valid wallet address.");
  }

  const db = await readDb();
  const channels = db.channels
    .filter((channel) => (ownerWallet ? channel.ownerWallet === ownerWallet : true))
    .map((channel) => {
      const assetCount = db.assets.filter((asset) => asset.channelId === channel.id).length;
      const playlistCount = db.playlistItems.filter((item) => item.channelId === channel.id).length;
      return { channel, assetCount, playlistCount };
    })
    .sort((a, b) => a.channel.name.localeCompare(b.channel.name));

  res.json({ channels });
});

app.get("/api/library/assets", async (req, res) => {
  const ownerWalletRaw = req.query.ownerWallet;
  const ownerWalletInput = Array.isArray(ownerWalletRaw) ? ownerWalletRaw[0] : ownerWalletRaw;
  const ownerWallet = normalizeWalletAddress(ownerWalletInput);
  if (!ownerWallet) {
    return sendError(res, 400, "ownerWallet query param is required and must be a valid wallet address.");
  }

  const typeQuery = Array.isArray(req.query.type) ? req.query.type[0] : req.query.type;
  const typeFilter = typeQuery === "program" || typeQuery === "ad" ? typeQuery : undefined;

  const db = await readDb();
  const assets = getCreatorLibraryAssets(db, ownerWallet)
    .filter((asset) => (typeFilter ? asset.type === typeFilter : true))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  res.json({ assets });
});

app.post("/api/channels", async (req, res) => {
  const name = String(req.body?.name ?? "").trim();
  if (!name) {
    return sendError(res, 400, "Channel name is required.");
  }

  const description = String(req.body?.description ?? "").trim();
  const requestedSlug = slugify(String(req.body?.slug ?? ""));
  const adIntervalRaw = Number(req.body?.adInterval ?? 2);
  const adInterval = Number.isInteger(adIntervalRaw) && adIntervalRaw >= 0 ? adIntervalRaw : 2;
  const adTriggerMode = req.body?.adTriggerMode === "disabled" || req.body?.adTriggerMode === "time_interval"
    ? req.body.adTriggerMode
    : "every_n_programs";
  const adTimeIntervalSecRaw = Number(req.body?.adTimeIntervalSec ?? 10 * 60);
  const adTimeIntervalSec = Number.isFinite(adTimeIntervalSecRaw)
    ? Math.max(30, Math.floor(adTimeIntervalSecRaw))
    : 10 * 60;
  const streamMode = normalizeStreamMode(req.body?.streamMode);
  const brandColor = normalizeBrandColor(req.body?.brandColor) ?? "#00a96b";
  const playerLabel = normalizePlayerLabel(req.body?.playerLabel) ?? name;
  const profileImageRaw = req.body?.profileImageUrl;
  const profileImageUrl = normalizeChannelImageUrl(profileImageRaw);
  if (
    profileImageRaw !== undefined &&
    profileImageRaw !== null &&
    String(profileImageRaw).trim() !== "" &&
    !profileImageUrl
  ) {
    return sendError(res, 400, "profileImageUrl must be an http(s) URL or /uploads path.");
  }
  const bannerImageRaw = req.body?.bannerImageUrl;
  const bannerImageUrl = normalizeChannelImageUrl(bannerImageRaw);
  if (
    bannerImageRaw !== undefined &&
    bannerImageRaw !== null &&
    String(bannerImageRaw).trim() !== "" &&
    !bannerImageUrl
  ) {
    return sendError(res, 400, "bannerImageUrl must be an http(s) URL or /uploads path.");
  }
  const ownerWalletInput = req.body?.ownerWallet;
  const ownerWallet = normalizeWalletAddress(ownerWalletInput);
  if (ownerWalletInput !== undefined && ownerWalletInput !== "" && !ownerWallet) {
    return sendError(res, 400, "ownerWallet must be a valid wallet address.");
  }

  const { channel } = await transaction((db) => {
    const slugBase = requestedSlug || slugify(name) || `channel-${db.channels.length + 1}`;
    const slug = uniqueSlug(slugBase, db.channels);
    const channel: Channel = {
      id: uuidv4(),
      ownerWallet,
      name,
      slug,
      description,
      profileImageUrl,
      bannerImageUrl,
      adInterval,
      adTriggerMode,
      adTimeIntervalSec,
      brandColor,
      playerLabel,
      streamMode,
      radioBackgroundUrl: undefined,
      createdAt: nowIso(),
      updatedAt: nowIso()
    };

    db.channels.push(channel);
    getOrCreatePlayoutState(db, channel.id);
    return { channel };
  });

  let livepeer: ReturnType<typeof publicLivepeer>;
  let livepeerWarning: string | undefined;

  if (LIVEPEER_DEFAULT_ENABLED) {
    if (!hasLivepeerApiKey()) {
      livepeerWarning = "Livepeer auto-provision skipped because LIVEPEER_API_KEY is not configured.";
    } else {
      try {
        const provisioned = await ensureLivepeerChannelConfig(channel.id);
        livepeer = publicLivepeer(provisioned);
      } catch (error) {
        livepeerWarning = error instanceof Error ? error.message : "Livepeer auto-provision failed.";
      }
    }
  }

  res.status(201).json({ channel, livepeer, livepeerWarning });
});

app.get("/api/channels/:channelId", async (req, res) => {
  const db = await readDb();
  const channel = getChannel(db, req.params.channelId);
  if (!channel) {
    return sendError(res, 404, "Channel not found.");
  }

  const assets = getChannelAssets(db, channel.id);
  const folders = getChannelFolders(db, channel.id);
  const schedules = getChannelSchedules(db, channel.id);
  const playlist = hydratePlaylist(channel.id, db.playlistItems, assets);
  const state = getOrCreatePlayoutState(db, channel.id);
  const destinations = db.destinations.filter((destination) => destination.channelId === channel.id);
  const livepeerConfig = getLivepeerConfigForChannel(db, channel.id);

  res.json({
    channel,
    assets,
    folders,
    schedules,
    playlist,
    state,
    destinations,
    livepeer: publicLivepeer(livepeerConfig),
    streamUrl: pickStreamUrl(channel.id, livepeerConfig)
  });
});

app.patch("/api/channels/:channelId", async (req, res) => {
  const name = typeof req.body?.name === "string" ? req.body.name.trim() : undefined;
  const description = typeof req.body?.description === "string" ? req.body.description.trim() : undefined;
  const adIntervalBody = req.body?.adInterval;
  const adTriggerModeBody = req.body?.adTriggerMode;
  const adTimeIntervalSecBody = req.body?.adTimeIntervalSec;
  const slugBody = typeof req.body?.slug === "string" ? slugify(req.body.slug) : undefined;
  const brandColor = normalizeBrandColor(req.body?.brandColor);
  const playerLabel = normalizePlayerLabel(req.body?.playerLabel);
  const ownerWalletProvided = req.body && Object.prototype.hasOwnProperty.call(req.body, "ownerWallet");
  const ownerWalletInput = ownerWalletProvided ? req.body?.ownerWallet : undefined;
  const ownerWallet = ownerWalletProvided ? normalizeWalletAddress(ownerWalletInput) : undefined;
  if (ownerWalletProvided && ownerWalletInput !== null && ownerWalletInput !== "" && !ownerWallet) {
    return sendError(res, 400, "ownerWallet must be a valid wallet address.");
  }
  const streamModeProvided = req.body && Object.prototype.hasOwnProperty.call(req.body, "streamMode");
  const streamMode =
    streamModeProvided && (req.body?.streamMode === "video" || req.body?.streamMode === "radio")
      ? normalizeStreamMode(req.body?.streamMode)
      : undefined;
  const profileImageProvided = req.body && Object.prototype.hasOwnProperty.call(req.body, "profileImageUrl");
  const profileImageInput = profileImageProvided ? req.body?.profileImageUrl : undefined;
  const profileImageUrl = profileImageProvided ? normalizeChannelImageUrl(profileImageInput) : undefined;
  if (
    profileImageProvided &&
    profileImageInput !== null &&
    String(profileImageInput ?? "").trim() !== "" &&
    !profileImageUrl
  ) {
    return sendError(res, 400, "profileImageUrl must be an http(s) URL or /uploads path.");
  }
  const bannerImageProvided = req.body && Object.prototype.hasOwnProperty.call(req.body, "bannerImageUrl");
  const bannerImageInput = bannerImageProvided ? req.body?.bannerImageUrl : undefined;
  const bannerImageUrl = bannerImageProvided ? normalizeChannelImageUrl(bannerImageInput) : undefined;
  if (
    bannerImageProvided &&
    bannerImageInput !== null &&
    String(bannerImageInput ?? "").trim() !== "" &&
    !bannerImageUrl
  ) {
    return sendError(res, 400, "bannerImageUrl must be an http(s) URL or /uploads path.");
  }
  const backgroundProvided = req.body && Object.prototype.hasOwnProperty.call(req.body, "radioBackgroundUrl");
  const radioBackgroundUrl = backgroundProvided ? normalizeBackgroundUploadPath(req.body?.radioBackgroundUrl) : undefined;

  const payload = await transaction((db) => {
    const channel = getChannel(db, req.params.channelId);
    if (!channel) {
      return { error: "Channel not found." };
    }

    if (name) channel.name = name;
    if (description !== undefined) channel.description = description;
    if (Number.isInteger(Number(adIntervalBody)) && Number(adIntervalBody) >= 0) {
      channel.adInterval = Number(adIntervalBody);
    }
    if (
      adTriggerModeBody === "disabled" ||
      adTriggerModeBody === "every_n_programs" ||
      adTriggerModeBody === "time_interval"
    ) {
      channel.adTriggerMode = adTriggerModeBody;
    }
    if (Number.isFinite(Number(adTimeIntervalSecBody))) {
      channel.adTimeIntervalSec = Math.max(30, Math.floor(Number(adTimeIntervalSecBody)));
    }
    if (slugBody) {
      channel.slug = uniqueSlug(
        slugBody,
        db.channels.filter((entry) => entry.id !== channel.id)
      );
    }
    if (brandColor) {
      channel.brandColor = brandColor;
    }
    if (playerLabel) {
      channel.playerLabel = playerLabel;
    }
    if (ownerWalletProvided) {
      channel.ownerWallet = ownerWallet;
    }
    if (streamMode) {
      channel.streamMode = streamMode;
    }
    if (profileImageProvided) {
      channel.profileImageUrl = profileImageUrl;
    }
    if (bannerImageProvided) {
      channel.bannerImageUrl = bannerImageUrl;
    }
    if (backgroundProvided) {
      channel.radioBackgroundUrl = radioBackgroundUrl;
    }

    channel.updatedAt = nowIso();
    return { channel };
  });

  if (hasError(payload)) {
    return sendError(res, statusForPayloadError(payload.error), payload.error);
  }

  res.json(payload);
});

app.get("/api/channels/:channelId/assets", async (req, res) => {
  const db = await readDb();
  const channel = getChannel(db, req.params.channelId);
  if (!channel) {
    return sendError(res, 404, "Channel not found.");
  }

  const assets = getChannelAssets(db, channel.id).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  res.json({ assets });
});

app.get("/api/channels/:channelId/folders", async (req, res) => {
  const db = await readDb();
  const channel = getChannel(db, req.params.channelId);
  if (!channel) {
    return sendError(res, 404, "Channel not found.");
  }

  const folders = getChannelFolders(db, channel.id);
  res.json({ folders });
});

app.post("/api/channels/:channelId/folders", async (req, res) => {
  const name = String(req.body?.name ?? "").trim();
  if (!name) {
    return sendError(res, 400, "Folder name is required.");
  }

  const parentFolderId = normalizeOptionalFolderId(req.body?.parentFolderId);

  const payload = await transaction((db) => {
    const channel = getChannel(db, req.params.channelId);
    if (!channel) {
      return { error: "Channel not found." };
    }

    if (parentFolderId) {
      const parent = db.assetFolders.find((folder) => folder.id === parentFolderId && folder.channelId === channel.id);
      if (!parent) {
        return { error: "Parent folder not found." };
      }
    }

    const folder: AssetFolder = {
      id: uuidv4(),
      channelId: channel.id,
      name: name.slice(0, 80),
      parentFolderId,
      createdAt: nowIso(),
      updatedAt: nowIso()
    };

    db.assetFolders.push(folder);
    return { folder };
  });

  if (hasError(payload)) {
    return sendError(res, statusForPayloadError(payload.error), payload.error);
  }

  res.status(201).json(payload);
});

app.patch("/api/folders/:folderId", async (req, res) => {
  const name = typeof req.body?.name === "string" ? req.body.name.trim() : undefined;
  const parentFolderInput =
    req.body && Object.prototype.hasOwnProperty.call(req.body, "parentFolderId")
      ? normalizeOptionalFolderId(req.body.parentFolderId)
      : undefined;
  const parentProvided = req.body && Object.prototype.hasOwnProperty.call(req.body, "parentFolderId");

  const payload = await transaction((db) => {
    const folder = db.assetFolders.find((entry) => entry.id === req.params.folderId);
    if (!folder) {
      return { error: "Folder not found." };
    }

    const channelFolders = db.assetFolders.filter((entry) => entry.channelId === folder.channelId);

    if (name) {
      folder.name = name.slice(0, 80);
    }

    if (parentProvided) {
      if (parentFolderInput) {
        const parent = channelFolders.find((entry) => entry.id === parentFolderInput);
        if (!parent) {
          return { error: "Parent folder not found." };
        }
        if (createsFolderCycle(channelFolders, folder.id, parentFolderInput)) {
          return { error: "Cannot move folder into itself or a child folder." };
        }
        folder.parentFolderId = parentFolderInput;
      } else {
        folder.parentFolderId = undefined;
      }
    }

    folder.updatedAt = nowIso();
    return { folder };
  });

  if (hasError(payload)) {
    return sendError(res, 400, payload.error);
  }

  res.json(payload);
});

app.delete("/api/folders/:folderId", async (req, res) => {
  const payload = await transaction((db) => {
    const folderIndex = db.assetFolders.findIndex((entry) => entry.id === req.params.folderId);
    if (folderIndex === -1) {
      return { error: "Folder not found." };
    }

    const [folder] = db.assetFolders.splice(folderIndex, 1);
    const fallbackParentId = folder.parentFolderId;

    for (const child of db.assetFolders) {
      if (child.parentFolderId === folder.id) {
        child.parentFolderId = fallbackParentId;
        child.updatedAt = nowIso();
      }
    }

    for (const asset of db.assets) {
      if (asset.folderId === folder.id) {
        asset.folderId = fallbackParentId;
      }
    }

    return { deleted: folder.id };
  });

  if (hasError(payload)) {
    return sendError(res, statusForPayloadError(payload.error), payload.error);
  }

  res.json(payload);
});

app.get("/api/channels/:channelId/schedules", async (req, res) => {
  const db = await readDb();
  const channel = getChannel(db, req.params.channelId);
  if (!channel) {
    return sendError(res, 404, "Channel not found.");
  }

  const schedules = getChannelSchedules(db, channel.id);
  res.json({ schedules });
});

app.post("/api/channels/:channelId/schedules", async (req, res) => {
  const startAt = normalizeIsoDateTime(req.body?.startAt);
  const endAt = normalizeIsoDateTime(req.body?.endAt);
  const enabled = typeof req.body?.enabled === "boolean" ? req.body.enabled : true;

  if (!startAt) {
    return sendError(res, 400, "startAt is required and must be a valid date-time.");
  }

  if (endAt && Date.parse(endAt) <= Date.parse(startAt)) {
    return sendError(res, 400, "endAt must be later than startAt.");
  }

  const payload = await transaction((db) => {
    const channel = getChannel(db, req.params.channelId);
    if (!channel) {
      return { error: "Channel not found." };
    }

    const createdAt = nowIso();
    const schedule: StreamSchedule = {
      id: uuidv4(),
      channelId: channel.id,
      startAt,
      endAt,
      enabled,
      createdAt,
      updatedAt: createdAt
    };

    db.streamSchedules.push(schedule);
    return { schedule };
  });

  if (hasError(payload)) {
    return sendError(res, statusForPayloadError(payload.error), payload.error);
  }

  res.status(201).json(payload);
});

app.patch("/api/schedules/:scheduleId", async (req, res) => {
  const startProvided = req.body && Object.prototype.hasOwnProperty.call(req.body, "startAt");
  const endProvided = req.body && Object.prototype.hasOwnProperty.call(req.body, "endAt");
  const enabledProvided = req.body && Object.prototype.hasOwnProperty.call(req.body, "enabled");
  const enabled = req.body?.enabled;

  const payload = await transaction((db) => {
    const schedule = db.streamSchedules.find((entry) => entry.id === req.params.scheduleId);
    if (!schedule) {
      return { error: "Schedule not found." };
    }

    if (enabledProvided && typeof enabled !== "boolean") {
      return { error: "enabled must be a boolean when provided." };
    }

    const nextStartAt = startProvided ? normalizeIsoDateTime(req.body?.startAt) : schedule.startAt;
    if (!nextStartAt) {
      return { error: "startAt is required and must be a valid date-time." };
    }

    const nextEndAt = endProvided
      ? normalizeIsoDateTime(req.body?.endAt)
      : schedule.endAt;

    if (nextEndAt && Date.parse(nextEndAt) <= Date.parse(nextStartAt)) {
      return { error: "endAt must be later than startAt." };
    }

    schedule.startAt = nextStartAt;
    schedule.endAt = nextEndAt;
    if (enabledProvided) {
      schedule.enabled = enabled;
    }

    if (startProvided || endProvided) {
      schedule.startedAt = undefined;
      schedule.endedAt = undefined;
    }

    schedule.updatedAt = nowIso();
    return { schedule };
  });

  if (hasError(payload)) {
    const status = payload.error === "Schedule not found." ? 404 : 400;
    return sendError(res, status, payload.error);
  }

  res.json(payload);
});

app.delete("/api/schedules/:scheduleId", async (req, res) => {
  const payload = await transaction((db) => {
    const index = db.streamSchedules.findIndex((entry) => entry.id === req.params.scheduleId);
    if (index === -1) {
      return { error: "Schedule not found." };
    }
    const [deleted] = db.streamSchedules.splice(index, 1);
    return { deleted: deleted.id };
  });

  if (hasError(payload)) {
    return sendError(res, statusForPayloadError(payload.error), payload.error);
  }

  res.json(payload);
});

async function moveUploadedFile(tempPath: string, scopeId: string, assetId: string, originalName: string) {
  const ext = path.extname(originalName || ".mp4") || ".mp4";
  const storageDir = path.join(UPLOAD_ROOT, toStorageScopeId(scopeId));
  await fs.mkdir(storageDir, { recursive: true });

  const finalPath = path.join(storageDir, `${assetId}${ext.toLowerCase()}`);
  await fs.rename(tempPath, finalPath);
  return finalPath;
}

app.post("/api/library/assets/upload", upload.single("file"), async (req, res) => {
  if (!req.file) {
    return sendError(res, 400, "No file uploaded.");
  }

  const ownerWalletInput = req.body?.ownerWallet;
  const ownerWallet = normalizeWalletAddress(ownerWalletInput);
  if (!ownerWallet) {
    return sendError(res, 400, "ownerWallet is required and must be a valid wallet address.");
  }

  const libraryScopeId = toLibraryScopeId(ownerWallet);
  const assetId = uuidv4();
  const uploadedPath = await moveUploadedFile(req.file.path, libraryScopeId, assetId, req.file.originalname);
  const mediaKind = await probeMediaKind(uploadedPath);
  const uploadSizeBytes = Number.isFinite(req.file.size) ? Math.max(0, Math.floor(req.file.size)) : undefined;
  let streamReadyPath = uploadedPath;
  let originalLocalPath: string | undefined;
  let compression: Asset["compression"];
  let compressionWarning: string | undefined;

  if (MAX_COMPRESSION_INPUT_BYTES && uploadSizeBytes && uploadSizeBytes > MAX_COMPRESSION_INPUT_BYTES) {
    compressionWarning = `Compression skipped for large upload (${formatMiB(uploadSizeBytes)} > ${formatMiB(
      MAX_COMPRESSION_INPUT_BYTES
    )}). Using source file directly for faster ingest.`;
  } else {
    try {
      const compressed = await compressForStreaming(
        uploadedPath,
        path.join(UPLOAD_ROOT, toStorageScopeId(libraryScopeId), "compressed"),
        assetId,
        mediaKind
      );
      streamReadyPath = compressed.outputPath;
      compression = {
        tool: "ffmpeg",
        profile: compressed.profile,
        compressedAt: nowIso()
      };
    } catch (error) {
      if (isNoSpaceCompressionError(error)) {
        compressionWarning =
          "Compression skipped because storage is full (ENOSPC). Using source file directly; free space or increase volume to restore compression.";
      } else {
        compressionWarning = error instanceof Error ? error.message : "FFmpeg compression failed.";
      }
    }
  }

  if (streamReadyPath !== uploadedPath) {
    if (KEEP_ORIGINAL_UPLOADS) {
      originalLocalPath = uploadedPath;
    } else {
      await fs.unlink(uploadedPath).catch(() => undefined);
    }
  }

  const durationSec = await probeDurationSec(streamReadyPath);
  const title = String(req.body?.title ?? req.file.originalname ?? `Asset ${assetId.slice(0, 8)}`).trim();
  const type = normalizeAssetType(req.body?.type);
  const insertionCategory = normalizeInsertionCategory(req.body?.insertionCategory, type);

  const pinataConfigured = hasPinataJwt();
  if (UPLOAD_STORAGE_MODE === "ipfs" && !pinataConfigured) {
    await removeLocalFiles([streamReadyPath, uploadedPath, originalLocalPath]);
    return sendError(res, 503, "IPFS-only storage mode requires PINATA_JWT to be configured.");
  }

  let ipfsCid: string | undefined;
  let ipfsUrl: string | undefined;
  let ipfsWarning: string | undefined;
  if (pinataConfigured && UPLOAD_STORAGE_MODE !== "local") {
    try {
      const pin = await uploadFileToIpfs(streamReadyPath, title);
      ipfsCid = pin.cid;
      ipfsUrl = pin.url;
    } catch (error) {
      ipfsWarning = error instanceof Error ? error.message : "IPFS upload failed.";
    }
  } else if (UPLOAD_STORAGE_MODE !== "local" && !pinataConfigured) {
    ipfsWarning = "PINATA_JWT is not configured; falling back to local storage.";
  }

  if (UPLOAD_STORAGE_MODE === "ipfs" && !ipfsUrl) {
    await removeLocalFiles([streamReadyPath, uploadedPath, originalLocalPath]);
    return sendError(res, 502, `IPFS pinning failed in ipfs mode. ${ipfsWarning ?? "Unknown pinning error."}`);
  }

  if (ipfsUrl && DELETE_LOCAL_AFTER_IPFS) {
    await removeLocalFiles([streamReadyPath, uploadedPath, originalLocalPath]);
    originalLocalPath = undefined;
  }

  const storageProvider: "local" | "ipfs" = ipfsUrl ? "ipfs" : "local";
  const playbackSourcePath = ipfsUrl ?? streamReadyPath;

  const payload = await transaction((editable) => {
    const asset: Asset = {
      id: assetId,
      channelId: libraryScopeId,
      title,
      sourceType: "upload",
      localPath: playbackSourcePath,
      originalLocalPath,
      storageProvider,
      ipfsCid,
      ipfsUrl,
      compression,
      durationSec,
      type,
      insertionCategory,
      mediaKind,
      createdAt: nowIso()
    };
    editable.assets.push(asset);
    return { asset, ipfsWarning, compressionWarning };
  });

  res.status(201).json(payload);
});

app.post("/api/channels/:channelId/assets/upload", upload.single("file"), async (req, res) => {
  if (!req.file) {
    return sendError(res, 400, "No file uploaded.");
  }

  const db = await readDb();
  const channel = getChannel(db, req.params.channelId);
  if (!channel) {
    return sendError(res, 404, "Channel not found.");
  }

  const assetId = uuidv4();
  const uploadedPath = await moveUploadedFile(req.file.path, channel.id, assetId, req.file.originalname);
  const mediaKind = await probeMediaKind(uploadedPath);
  const uploadSizeBytes = Number.isFinite(req.file.size) ? Math.max(0, Math.floor(req.file.size)) : undefined;
  let streamReadyPath = uploadedPath;
  let originalLocalPath: string | undefined;
  let compression: Asset["compression"];
  let compressionWarning: string | undefined;

  if (MAX_COMPRESSION_INPUT_BYTES && uploadSizeBytes && uploadSizeBytes > MAX_COMPRESSION_INPUT_BYTES) {
    compressionWarning = `Compression skipped for large upload (${formatMiB(uploadSizeBytes)} > ${formatMiB(
      MAX_COMPRESSION_INPUT_BYTES
    )}). Using source file directly for faster ingest.`;
  } else {
    try {
      const compressed = await compressForStreaming(
        uploadedPath,
        path.join(UPLOAD_ROOT, toStorageScopeId(channel.id), "compressed"),
        assetId,
        mediaKind
      );
      streamReadyPath = compressed.outputPath;
      compression = {
        tool: "ffmpeg",
        profile: compressed.profile,
        compressedAt: nowIso()
      };
    } catch (error) {
      if (isNoSpaceCompressionError(error)) {
        compressionWarning =
          "Compression skipped because storage is full (ENOSPC). Using source file directly; free space or increase volume to restore compression.";
      } else {
        compressionWarning = error instanceof Error ? error.message : "FFmpeg compression failed.";
      }
    }
  }

  if (streamReadyPath !== uploadedPath) {
    if (KEEP_ORIGINAL_UPLOADS) {
      originalLocalPath = uploadedPath;
    } else {
      await fs.unlink(uploadedPath).catch(() => undefined);
    }
  }

  const durationSec = await probeDurationSec(streamReadyPath);
  const title = String(req.body?.title ?? req.file.originalname ?? `Asset ${assetId.slice(0, 8)}`).trim();
  const type = normalizeAssetType(req.body?.type);
  const insertionCategory = normalizeInsertionCategory(req.body?.insertionCategory, type);
  const folderId = normalizeOptionalFolderId(req.body?.folderId);
  if (folderId && !db.assetFolders.some((folder) => folder.id === folderId && folder.channelId === channel.id)) {
    return sendError(res, 400, "folderId does not belong to this channel.");
  }
  const pinataConfigured = hasPinataJwt();
  if (UPLOAD_STORAGE_MODE === "ipfs" && !pinataConfigured) {
    await removeLocalFiles([streamReadyPath, uploadedPath, originalLocalPath]);
    return sendError(res, 503, "IPFS-only storage mode requires PINATA_JWT to be configured.");
  }

  let ipfsCid: string | undefined;
  let ipfsUrl: string | undefined;
  let ipfsWarning: string | undefined;
  if (pinataConfigured && UPLOAD_STORAGE_MODE !== "local") {
    try {
      const pin = await uploadFileToIpfs(streamReadyPath, title);
      ipfsCid = pin.cid;
      ipfsUrl = pin.url;
    } catch (error) {
      ipfsWarning = error instanceof Error ? error.message : "IPFS upload failed.";
    }
  } else if (UPLOAD_STORAGE_MODE !== "local" && !pinataConfigured) {
    ipfsWarning = "PINATA_JWT is not configured; falling back to local storage.";
  }

  if (UPLOAD_STORAGE_MODE === "ipfs" && !ipfsUrl) {
    await removeLocalFiles([streamReadyPath, uploadedPath, originalLocalPath]);
    return sendError(res, 502, `IPFS pinning failed in ipfs mode. ${ipfsWarning ?? "Unknown pinning error."}`);
  }

  if (ipfsUrl && DELETE_LOCAL_AFTER_IPFS) {
    await removeLocalFiles([streamReadyPath, uploadedPath, originalLocalPath]);
    originalLocalPath = undefined;
  }

  const storageProvider: "local" | "ipfs" = ipfsUrl ? "ipfs" : "local";
  const playbackSourcePath = ipfsUrl ?? streamReadyPath;

  const payload = await transaction((editable) => {
    const asset: Asset = {
      id: assetId,
      channelId: channel.id,
      title,
      sourceType: "upload",
      localPath: playbackSourcePath,
      originalLocalPath,
      folderId,
      storageProvider,
      ipfsCid,
      ipfsUrl,
      compression,
      durationSec,
      type,
      insertionCategory,
      mediaKind,
      createdAt: nowIso()
    };

    editable.assets.push(asset);
    return { asset, ipfsWarning, compressionWarning };
  });

  res.status(201).json(payload);
});

app.post("/api/channels/:channelId/profile-image", upload.single("file"), async (req, res) => {
  if (!req.file) {
    return sendError(res, 400, "No file uploaded.");
  }

  if (!isSupportedImageFile(req.file)) {
    return sendError(res, 400, "Profile image must be an image or GIF (jpg, png, webp, gif).");
  }

  const db = await readDb();
  const channel = getChannel(db, req.params.channelId);
  if (!channel) {
    return sendError(res, 404, "Channel not found.");
  }

  const ext = path.extname(req.file.originalname || ".png") || ".png";
  const imageId = `profile-image-${Date.now()}`;
  const fileName = `${imageId}${ext.toLowerCase()}`;
  const localPath = await moveUploadedFile(req.file.path, channel.id, imageId, fileName);
  const relativePath = path.relative(UPLOAD_ROOT, localPath).split(path.sep).join("/");
  const publicPath = `/uploads/${relativePath}`;

  const payload = await transaction((editable) => {
    const editableChannel = getChannel(editable, req.params.channelId);
    if (!editableChannel) {
      return { error: "Channel not found." };
    }

    editableChannel.profileImageUrl = publicPath;
    editableChannel.updatedAt = nowIso();
    return { channel: editableChannel };
  });

  if (hasError(payload)) {
    return sendError(res, statusForPayloadError(payload.error), payload.error);
  }

  res.status(201).json(payload);
});

app.post("/api/channels/:channelId/banner-image", upload.single("file"), async (req, res) => {
  if (!req.file) {
    return sendError(res, 400, "No file uploaded.");
  }

  if (!isSupportedImageFile(req.file)) {
    return sendError(res, 400, "Banner image must be an image or GIF (jpg, png, webp, gif).");
  }

  const db = await readDb();
  const channel = getChannel(db, req.params.channelId);
  if (!channel) {
    return sendError(res, 404, "Channel not found.");
  }

  const ext = path.extname(req.file.originalname || ".png") || ".png";
  const imageId = `banner-image-${Date.now()}`;
  const fileName = `${imageId}${ext.toLowerCase()}`;
  const localPath = await moveUploadedFile(req.file.path, channel.id, imageId, fileName);
  const relativePath = path.relative(UPLOAD_ROOT, localPath).split(path.sep).join("/");
  const publicPath = `/uploads/${relativePath}`;

  const payload = await transaction((editable) => {
    const editableChannel = getChannel(editable, req.params.channelId);
    if (!editableChannel) {
      return { error: "Channel not found." };
    }

    editableChannel.bannerImageUrl = publicPath;
    editableChannel.updatedAt = nowIso();
    return { channel: editableChannel };
  });

  if (hasError(payload)) {
    return sendError(res, statusForPayloadError(payload.error), payload.error);
  }

  res.status(201).json(payload);
});

app.post("/api/channels/:channelId/radio/background", upload.single("file"), async (req, res) => {
  if (!req.file) {
    return sendError(res, 400, "No file uploaded.");
  }

  if (!isSupportedImageFile(req.file)) {
    return sendError(res, 400, "Background must be an image or GIF (jpg, png, webp, gif).");
  }

  const db = await readDb();
  const channel = getChannel(db, req.params.channelId);
  if (!channel) {
    return sendError(res, 404, "Channel not found.");
  }

  const ext = path.extname(req.file.originalname || ".png") || ".png";
  const backgroundId = `radio-background-${Date.now()}`;
  const fileName = `${backgroundId}${ext.toLowerCase()}`;
  const localPath = await moveUploadedFile(req.file.path, channel.id, backgroundId, fileName);
  const relativePath = path.relative(UPLOAD_ROOT, localPath).split(path.sep).join("/");
  const publicPath = `/uploads/${relativePath}`;

  const payload = await transaction((editable) => {
    const editableChannel = getChannel(editable, req.params.channelId);
    if (!editableChannel) {
      return { error: "Channel not found." };
    }

    editableChannel.radioBackgroundUrl = publicPath;
    editableChannel.updatedAt = nowIso();
    return { channel: editableChannel };
  });

  if (hasError(payload)) {
    return sendError(res, statusForPayloadError(payload.error), payload.error);
  }

  res.status(201).json(payload);
});

app.get("/api/channels/:channelId/assets/external/jobs", async (req, res) => {
  const db = await readDb();
  const channel = getChannel(db, req.params.channelId);
  if (!channel) {
    return sendError(res, 404, "Channel not found.");
  }

  const limitRaw = Number(req.query.limit ?? 25);
  const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(200, Math.floor(limitRaw))) : 25;
  const jobs = getChannelExternalJobs(db, channel.id).slice(0, limit);
  res.json({ jobs });
});

app.get("/api/channels/:channelId/assets/external/jobs/:jobId", async (req, res) => {
  const db = await readDb();
  const channel = getChannel(db, req.params.channelId);
  if (!channel) {
    return sendError(res, 404, "Channel not found.");
  }

  const job = db.externalIngestJobs.find(
    (entry) => entry.channelId === channel.id && entry.id === req.params.jobId
  );
  if (!job) {
    return sendError(res, 404, "External ingest job not found.");
  }

  res.json({ job });
});

app.post("/api/channels/:channelId/assets/external/jobs", async (req, res) => {
  const db = await readDb();
  const channel = getChannel(db, req.params.channelId);
  if (!channel) {
    return sendError(res, 404, "Channel not found.");
  }

  const urls = dedupeStrings([
    ...parseExternalUrlInput(req.body?.urls),
    ...parseExternalUrlInput(req.body?.url)
  ]);
  if (!urls.length) {
    return sendError(res, 400, "Provide one or more valid URLs in url or urls.");
  }

  const type = normalizeAssetType(req.body?.type);
  const titlePrefixRaw = typeof req.body?.titlePrefix === "string" ? req.body.titlePrefix.trim() : "";
  const titlePrefix = titlePrefixRaw ? titlePrefixRaw.slice(0, 96) : undefined;
  const expandPlaylists = req.body?.expandPlaylists !== false;
  const createdAt = nowIso();
  const job: ExternalIngestJob = {
    id: uuidv4(),
    channelId: channel.id,
    type,
    titlePrefix,
    requestedUrls: urls,
    expandedUrls: [],
    expandPlaylists,
    status: "queued",
    progressPct: 0,
    createdAt,
    updatedAt: createdAt,
    items: []
  };

  const payload = await transaction((editable) => {
    editable.externalIngestJobs.push(job);
    pruneExternalIngestJobs(editable, channel.id);
    return { job };
  });

  void drainExternalIngestQueue(channel.id);
  res.status(202).json(payload);
});

app.post("/api/channels/:channelId/assets/external/jobs/:jobId/cancel", async (req, res) => {
  const payload = await transaction((db) => {
    const channel = getChannel(db, req.params.channelId);
    if (!channel) {
      return { error: "Channel not found." };
    }

    const job = db.externalIngestJobs.find(
      (entry) => entry.channelId === channel.id && entry.id === req.params.jobId
    );
    if (!job) {
      return { error: "External ingest job not found." };
    }

    if (!isExternalIngestJobTerminal(job.status)) {
      cancelExternalIngestJobState(job, "Canceled by user.");
    }

    return { job };
  });

  if (hasError(payload)) {
    return sendError(res, statusForPayloadError(payload.error), payload.error);
  }

  externalIngestAbortControllers.get(req.params.jobId)?.abort();
  res.json(payload);
});

app.delete("/api/channels/:channelId/assets/external/jobs/:jobId", async (req, res) => {
  const payload = await transaction((db) => {
    const channel = getChannel(db, req.params.channelId);
    if (!channel) {
      return { error: "Channel not found." };
    }

    const index = db.externalIngestJobs.findIndex(
      (entry) => entry.channelId === channel.id && entry.id === req.params.jobId
    );
    if (index === -1) {
      return { error: "External ingest job not found." };
    }

    const [deletedJob] = db.externalIngestJobs.splice(index, 1);
    return { deleted: deletedJob.id };
  });

  if (hasError(payload)) {
    return sendError(res, statusForPayloadError(payload.error), payload.error);
  }

  externalIngestAbortControllers.get(req.params.jobId)?.abort();
  res.json(payload);
});

app.patch("/api/channels/:channelId/assets/external/jobs/:jobId/items/:itemId", async (req, res) => {
  const titleInput = typeof req.body?.title === "string" ? req.body.title.trim() : "";
  const nextTitle = titleInput ? titleInput.slice(0, 120) : undefined;

  const payload = await transaction((db) => {
    const channel = getChannel(db, req.params.channelId);
    if (!channel) {
      return { error: "Channel not found." };
    }

    const job = db.externalIngestJobs.find(
      (entry) => entry.channelId === channel.id && entry.id === req.params.jobId
    );
    if (!job) {
      return { error: "External ingest job not found." };
    }

    const item = job.items.find((entry) => entry.id === req.params.itemId);
    if (!item) {
      return { error: "External ingest job item not found." };
    }

    item.title = nextTitle;
    item.updatedAt = nowIso();

    if (item.assetId && nextTitle) {
      const asset = db.assets.find((entry) => entry.id === item.assetId && entry.channelId === channel.id);
      if (asset) {
        asset.title = nextTitle;
      }
    }

    job.updatedAt = nowIso();
    return { item };
  });

  if (hasError(payload)) {
    return sendError(res, statusForPayloadError(payload.error), payload.error);
  }

  res.json(payload);
});

app.post("/api/channels/:channelId/assets/external", async (req, res) => {
  const url = String(req.body?.url ?? "").trim();
  if (!url) {
    return sendError(res, 400, "External URL is required.");
  }

  const db = await readDb();
  const channel = getChannel(db, req.params.channelId);
  if (!channel) {
    return sendError(res, 404, "Channel not found.");
  }

  const assetId = uuidv4();
  const type = normalizeAssetType(req.body?.type);
  const insertionCategory = normalizeInsertionCategory(req.body?.insertionCategory, type);
  const title = String(req.body?.title ?? `Imported ${assetId.slice(0, 8)}`).trim();
  const folderId = normalizeOptionalFolderId(req.body?.folderId);
  if (folderId && !db.assetFolders.some((folder) => folder.id === folderId && folder.channelId === channel.id)) {
    return sendError(res, 400, "folderId does not belong to this channel.");
  }
  const channelDir = path.join(UPLOAD_ROOT, toStorageScopeId(channel.id));

  try {
    const localPath = await ingestFromExternalUrl(url, channelDir, assetId);
    const [durationSec, mediaKind] = await Promise.all([probeDurationSec(localPath), probeMediaKind(localPath)]);
    let ipfsCid: string | undefined;
    let ipfsUrl: string | undefined;
    let storageProvider: "local" | "ipfs" = "local";
    let ipfsWarning: string | undefined;

    if (hasPinataJwt()) {
      try {
        const pin = await uploadFileToIpfs(localPath, title);
        ipfsCid = pin.cid;
        ipfsUrl = pin.url;
        storageProvider = "ipfs";
      } catch (error) {
        ipfsWarning = error instanceof Error ? error.message : "IPFS upload failed.";
      }
    }

    const payload = await transaction((editable) => {
      const asset: Asset = {
        id: assetId,
        channelId: channel.id,
        title,
        sourceType: "external",
        sourceUrl: url,
        localPath,
        folderId,
        storageProvider,
        ipfsCid,
        ipfsUrl,
        durationSec,
        type,
        insertionCategory,
        mediaKind,
        createdAt: nowIso()
      };

      editable.assets.push(asset);
      return { asset, ipfsWarning };
    });

    res.status(201).json(payload);
  } catch (error) {
    sendError(res, 500, error instanceof Error ? error.message : "External ingest failed.");
  }
});

app.patch("/api/assets/:assetId", async (req, res) => {
  const title = typeof req.body?.title === "string" ? req.body.title.trim() : undefined;
  const type = req.body?.type;
  const insertionCategoryProvided = req.body && Object.prototype.hasOwnProperty.call(req.body, "insertionCategory");
  const insertionCategoryInput = insertionCategoryProvided ? req.body?.insertionCategory : undefined;
  const folderProvided = req.body && Object.prototype.hasOwnProperty.call(req.body, "folderId");
  const folderId = folderProvided ? normalizeOptionalFolderId(req.body?.folderId) : undefined;

  const payload = await transaction((db) => {
    const asset = db.assets.find((entry) => entry.id === req.params.assetId);
    if (!asset) {
      return { error: "Asset not found." };
    }

    if (folderProvided && folderId) {
      const folder = db.assetFolders.find((entry) => entry.id === folderId && entry.channelId === asset.channelId);
      if (!folder) {
        return { error: "folderId does not belong to this asset channel." };
      }
    }

    if (title) asset.title = title;
    if (type === "program" || type === "ad") {
      asset.type = type;
      asset.insertionCategory = normalizeInsertionCategory(insertionCategoryInput, asset.type);
    } else if (insertionCategoryProvided) {
      asset.insertionCategory = normalizeInsertionCategory(insertionCategoryInput, asset.type);
    }
    if (folderProvided) asset.folderId = folderId;
    return { asset };
  });

  if (hasError(payload)) {
    return sendError(res, statusForPayloadError(payload.error), payload.error);
  }

  res.json(payload);
});

app.delete("/api/assets/:assetId", async (req, res) => {
  const payload = await transaction(async (db) => {
    const index = db.assets.findIndex((entry) => entry.id === req.params.assetId);
    if (index === -1) {
      return { error: "Asset not found." };
    }

    const [asset] = db.assets.splice(index, 1);
    db.playlistItems = db.playlistItems.filter((item) => item.assetId !== asset.id);

    const localPathStillReferenced = db.assets.some(
      (entry) => entry.localPath === asset.localPath || entry.originalLocalPath === asset.localPath
    );
    if (!localPathStillReferenced) {
      try {
        await fs.unlink(asset.localPath);
      } catch {
        // Ignore missing files in local MVP mode.
      }
    }

    if (asset.originalLocalPath && asset.originalLocalPath !== asset.localPath) {
      const originalPathStillReferenced = db.assets.some(
        (entry) => entry.localPath === asset.originalLocalPath || entry.originalLocalPath === asset.originalLocalPath
      );
      if (!originalPathStillReferenced) {
        try {
          await fs.unlink(asset.originalLocalPath);
        } catch {
          // Ignore missing files in local MVP mode.
        }
      }
    }

    return { deleted: asset.id };
  });

  if (hasError(payload)) {
    return sendError(res, statusForPayloadError(payload.error), payload.error);
  }

  res.json(payload);
});

app.post("/api/channels/:channelId/library/import", async (req, res) => {
  const assetIds: string[] | null = Array.isArray(req.body?.assetIds)
    ? req.body.assetIds.map((value: unknown) => String(value).trim()).filter(Boolean)
    : null;
  if (!assetIds || assetIds.length === 0) {
    return sendError(res, 400, "assetIds array is required.");
  }

  const ownerWalletInput = req.body?.ownerWallet;
  const ownerWallet = normalizeWalletAddress(ownerWalletInput);
  if (!ownerWallet) {
    return sendError(res, 400, "ownerWallet is required and must be a valid wallet address.");
  }

  const payload = await transaction((db) => {
    const channel = getChannel(db, req.params.channelId);
    if (!channel) {
      return { error: "Channel not found." };
    }

    if (channel.ownerWallet && channel.ownerWallet !== ownerWallet) {
      return { error: "Channel owner wallet does not match ownerWallet." };
    }

    const libraryAssets = getCreatorLibraryAssets(db, ownerWallet);
    const libraryById = new Map(libraryAssets.map((asset) => [asset.id, asset]));
    const missing = assetIds.find((assetId) => !libraryById.has(assetId));
    if (missing) {
      return { error: `Library asset not found: ${missing}` };
    }

    const importedAssets = assetIds.map((assetId) => {
      const source = libraryById.get(assetId)!;
      const clone: Asset = {
        ...source,
        id: uuidv4(),
        channelId: channel.id,
        createdAt: nowIso()
      };
      db.assets.push(clone);
      return clone;
    });

    return { assets: importedAssets };
  });

  if (hasError(payload)) {
    return sendError(res, 400, payload.error);
  }

  res.status(201).json(payload);
});

app.get("/api/channels/:channelId/playlist", async (req, res) => {
  const db = await readDb();
  const channel = getChannel(db, req.params.channelId);
  if (!channel) {
    return sendError(res, 404, "Channel not found.");
  }

  const playlist = hydratePlaylist(channel.id, db.playlistItems, getChannelAssets(db, channel.id));
  res.json({ playlist });
});

app.put("/api/channels/:channelId/playlist", async (req, res) => {
  const assetIds: string[] | null = Array.isArray(req.body?.assetIds)
    ? req.body.assetIds.map((value: unknown) => String(value))
    : null;
  if (!assetIds) {
    return sendError(res, 400, "assetIds array is required.");
  }

  const payload = await transaction((db) => {
    const channel = getChannel(db, req.params.channelId);
    if (!channel) {
      return { error: "Channel not found." };
    }

    const programsById = new Map(
      getChannelAssets(db, channel.id)
        .filter((asset) => asset.type === "program")
        .map((asset) => [asset.id, asset])
    );
    const invalidAsset = assetIds.find((assetId) => !programsById.has(assetId));
    if (invalidAsset) {
      return { error: `Playlist only accepts program assets. Invalid asset: ${invalidAsset}` };
    }

    db.playlistItems = db.playlistItems.filter((item) => item.channelId !== channel.id);
    assetIds.forEach((assetId, position) => {
      db.playlistItems.push({
        id: uuidv4(),
        channelId: channel.id,
        assetId,
        position,
        createdAt: nowIso()
      });
    });

    const state = getOrCreatePlayoutState(db, channel.id);
    if (assetIds.length === 0) {
      state.queueIndex = 0;
      state.currentProgramOffsetSec = 0;
    } else {
      const normalizedQueueIndex = ((state.queueIndex % assetIds.length) + assetIds.length) % assetIds.length;
      let nextQueueIndex = normalizedQueueIndex;

      if (state.currentAssetId && assetIds[normalizedQueueIndex] !== state.currentAssetId) {
        const matchingIndexes = assetIds
          .map((assetId, index) => (assetId === state.currentAssetId ? index : -1))
          .filter((index) => index >= 0);
        if (matchingIndexes.length) {
          nextQueueIndex = matchingIndexes.find((index) => index >= normalizedQueueIndex) ?? matchingIndexes[0];
        }
      }

      state.queueIndex = nextQueueIndex;
      state.currentProgramOffsetSec = 0;
    }
    state.updatedAt = nowIso();

    return {
      playlist: hydratePlaylist(channel.id, db.playlistItems, getChannelAssets(db, channel.id))
    };
  });

  if (hasError(payload)) {
    return sendError(res, 400, payload.error);
  }

  res.json(payload);
});

app.post("/api/channels/:channelId/playlist/items", async (req, res) => {
  const assetId = String(req.body?.assetId ?? "").trim();
  const desiredPosition = Number(req.body?.position);

  if (!assetId) {
    return sendError(res, 400, "assetId is required.");
  }

  const payload = await transaction((db) => {
    const channel = getChannel(db, req.params.channelId);
    if (!channel) return { error: "Channel not found." };

    const asset = db.assets.find(
      (entry) => entry.id === assetId && entry.channelId === channel.id && entry.type === "program"
    );
    if (!asset) return { error: "Asset not found for this channel." };

    const channelItems = db.playlistItems
      .filter((item) => item.channelId === channel.id)
      .sort((a, b) => a.position - b.position);

    const position = Number.isInteger(desiredPosition)
      ? Math.max(0, Math.min(desiredPosition, channelItems.length))
      : channelItems.length;

    for (const item of channelItems) {
      if (item.position >= position) {
        item.position += 1;
      }
    }

    const newItem: PlaylistItem = {
      id: uuidv4(),
      channelId: channel.id,
      assetId,
      position,
      createdAt: nowIso()
    };

    db.playlistItems.push(newItem);
    return { playlistItem: newItem };
  });

  if (hasError(payload)) {
    return sendError(res, 400, payload.error);
  }

  res.status(201).json(payload);
});

app.delete("/api/channels/:channelId/playlist/items/:itemId", async (req, res) => {
  const payload = await transaction((db) => {
    const channel = getChannel(db, req.params.channelId);
    if (!channel) return { error: "Channel not found." };

    const index = db.playlistItems.findIndex(
      (item) => item.channelId === channel.id && item.id === req.params.itemId
    );
    if (index === -1) return { error: "Playlist item not found." };

    const [removed] = db.playlistItems.splice(index, 1);
    const remaining = db.playlistItems
      .filter((item) => item.channelId === channel.id)
      .sort((a, b) => a.position - b.position);

    remaining.forEach((item, position) => {
      item.position = position;
    });

    return { removed };
  });

  if (hasError(payload)) {
    return sendError(res, statusForPayloadError(payload.error), payload.error);
  }

  res.json(payload);
});

app.get("/api/channels/:channelId/status", async (req, res) => {
  const db = await readDb();
  const channel = getChannel(db, req.params.channelId);
  if (!channel) {
    return sendError(res, 404, "Channel not found.");
  }

  const state = getOrCreatePlayoutState(db, channel.id);
  const livepeerConfig = getLivepeerConfigForChannel(db, channel.id);
  res.json({
    state,
    livepeer: publicLivepeer(livepeerConfig),
    streamUrl: pickStreamUrl(channel.id, livepeerConfig)
  });
});

app.get("/api/channels/:channelId/livepeer", async (req, res) => {
  const db = await readDb();
  const channel = getChannel(db, req.params.channelId);
  if (!channel) {
    return sendError(res, 404, "Channel not found.");
  }

  const config = getLivepeerConfigForChannel(db, channel.id);
  res.json({
    livepeer: publicLivepeer(config),
    configured: Boolean(config?.streamId && config?.playbackId)
  });
});

app.post("/api/channels/:channelId/livepeer/provision", async (req, res) => {
  if (!hasLivepeerApiKey()) {
    return sendError(res, 400, "LIVEPEER_API_KEY is not configured on the server.");
  }

  try {
    const config = await ensureLivepeerChannelConfig(String(req.params.channelId));
    res.status(201).json({ livepeer: publicLivepeer(config) });
  } catch (error) {
    sendError(res, 500, error instanceof Error ? error.message : "Livepeer provisioning failed.");
  }
});

app.patch("/api/channels/:channelId/livepeer", async (req, res) => {
  const enabled = req.body?.enabled;
  if (typeof enabled !== "boolean") {
    return sendError(res, 400, "enabled boolean is required.");
  }

  if (enabled) {
    if (hasLivepeerApiKey()) {
      try {
        await ensureLivepeerChannelConfig(String(req.params.channelId));
      } catch (error) {
        return sendError(res, 500, error instanceof Error ? error.message : "Livepeer provisioning failed.");
      }
    } else {
      const db = await readDb();
      const channel = getChannel(db, req.params.channelId);
      if (!channel) {
        return sendError(res, 404, "Channel not found.");
      }

      const config = getLivepeerConfigForChannel(db, channel.id);
      const hasProvisionedRoute = Boolean(config?.streamId && config?.streamKey && config?.playbackId && config?.ingestUrl);
      if (!hasProvisionedRoute) {
        return sendError(
          res,
          400,
          "Cannot enable Livepeer because no provisioned route exists and LIVEPEER_API_KEY is not configured."
        );
      }
    }
  }

  const payload = await transaction((db) => {
    const channel = getChannel(db, req.params.channelId);
    if (!channel) {
      return { error: "Channel not found." };
    }

    if (!enabled && !hasEnabledCustomOutput(db, channel.id)) {
      return { error: "Add and enable a custom RTMP output before disabling Livepeer." };
    }

    let config = getLivepeerConfigForChannel(db, channel.id);
    if (!config) {
      config = {
        channelId: channel.id,
        enabled,
        updatedAt: nowIso()
      };
      db.livepeerConfigs.push(config);
    } else {
      config.enabled = enabled;
      config.updatedAt = nowIso();
    }

    return { livepeer: publicLivepeer(config) };
  });

  if (hasError(payload)) {
    return sendError(res, statusForPayloadError(payload.error), payload.error);
  }

  res.json(payload);
});

app.get("/api/channels/:channelId/destinations", async (req, res) => {
  const db = await readDb();
  const channel = getChannel(db, req.params.channelId);
  if (!channel) {
    return sendError(res, 404, "Channel not found.");
  }

  const destinations = db.destinations.filter((destination) => destination.channelId === channel.id);
  res.json({ destinations });
});

app.post("/api/channels/:channelId/destinations", async (req, res) => {
  const name = String(req.body?.name ?? "").trim();
  const rtmpUrl = String(req.body?.rtmpUrl ?? "").trim();
  const streamKey = String(req.body?.streamKey ?? "").trim();

  if (!name || !rtmpUrl || !streamKey) {
    return sendError(res, 400, "name, rtmpUrl, and streamKey are required.");
  }

  const payload = await transaction((db) => {
    const channel = getChannel(db, req.params.channelId);
    if (!channel) {
      return { error: "Channel not found." };
    }

    for (const existing of db.destinations) {
      if (existing.channelId === channel.id) {
        existing.enabled = false;
      }
    }

    const destination: MultistreamDestination = {
      id: uuidv4(),
      channelId: channel.id,
      name,
      rtmpUrl,
      streamKey,
      enabled: true,
      createdAt: nowIso()
    };

    db.destinations.push(destination);
    return { destination };
  });

  if (hasError(payload)) {
    return sendError(res, statusForPayloadError(payload.error), payload.error);
  }

  res.status(201).json(payload);
});

app.patch("/api/destinations/:destinationId", async (req, res) => {
  const payload = await transaction((db) => {
    const destination = db.destinations.find((entry) => entry.id === req.params.destinationId);
    if (!destination) {
      return { error: "Destination not found." };
    }

    const name = typeof req.body?.name === "string" ? req.body.name.trim() : undefined;
    const rtmpUrl = typeof req.body?.rtmpUrl === "string" ? req.body.rtmpUrl.trim() : undefined;
    const streamKey = typeof req.body?.streamKey === "string" ? req.body.streamKey.trim() : undefined;
    const enabled = req.body?.enabled;

    if (name) destination.name = name;
    if (rtmpUrl) destination.rtmpUrl = rtmpUrl;
    if (streamKey) destination.streamKey = streamKey;
    if (typeof enabled === "boolean") {
      const livepeerConfig = getLivepeerConfigForChannel(db, destination.channelId);
      const livepeerEnabled = livepeerConfig?.enabled ?? LIVEPEER_DEFAULT_ENABLED;

      if (enabled) {
        for (const existing of db.destinations) {
          if (existing.channelId === destination.channelId && existing.id !== destination.id) {
            existing.enabled = false;
          }
        }
        destination.enabled = true;
      } else {
        const hasOtherEnabledCustomOutput = db.destinations.some(
          (entry) =>
            entry.channelId === destination.channelId &&
            entry.id !== destination.id &&
            hasUsableDestination(entry)
        );
        if (!livepeerEnabled && !hasOtherEnabledCustomOutput) {
          return { error: "Cannot disable the only custom output while Livepeer is disabled." };
        }
        destination.enabled = false;
      }
    }

    return { destination };
  });

  if (hasError(payload)) {
    return sendError(res, statusForPayloadError(payload.error), payload.error);
  }

  res.json(payload);
});

app.delete("/api/destinations/:destinationId", async (req, res) => {
  const payload = await transaction((db) => {
    const index = db.destinations.findIndex((entry) => entry.id === req.params.destinationId);
    if (index === -1) {
      return { error: "Destination not found." };
    }

    const destination = db.destinations[index];
    const livepeerConfig = getLivepeerConfigForChannel(db, destination.channelId);
    const livepeerEnabled = livepeerConfig?.enabled ?? LIVEPEER_DEFAULT_ENABLED;
    if (destination.enabled && !livepeerEnabled) {
      const hasOtherEnabledCustomOutput = db.destinations.some(
        (entry, cursor) =>
          cursor !== index &&
          entry.channelId === destination.channelId &&
          hasUsableDestination(entry)
      );
      if (!hasOtherEnabledCustomOutput) {
        return { error: "Cannot delete the only active custom output while Livepeer is disabled." };
      }
    }

    const [removed] = db.destinations.splice(index, 1);
    return { removed };
  });

  if (hasError(payload)) {
    return sendError(res, statusForPayloadError(payload.error), payload.error);
  }

  res.json(payload);
});

app.post("/api/channels/:channelId/control", async (req: Request, res: Response) => {
  const action = String(req.body?.action ?? "");
  if (action !== "start" && action !== "stop" && action !== "skip" && action !== "previous") {
    return sendError(res, 400, "action must be start|stop|skip|previous");
  }

  const channelId = String(req.params.channelId);
  let livepeerProvisionError: string | undefined;
  let livepeerConfigSnapshot: ReturnType<typeof publicLivepeer>;
  if (action === "start") {
    const snapshot = await readDb();
    const currentConfig = getLivepeerConfigForChannel(snapshot, channelId);
    const livepeerEnabled = currentConfig?.enabled ?? LIVEPEER_DEFAULT_ENABLED;
    if (livepeerEnabled && hasLivepeerApiKey()) {
      try {
        const config = await ensureLivepeerChannelConfig(channelId);
        if (config.enabled) {
          livepeerConfigSnapshot = publicLivepeer(config);
        }
      } catch (error) {
        livepeerProvisionError = error instanceof Error ? error.message : "Livepeer provisioning failed.";
      }
    } else if (livepeerEnabled) {
      livepeerProvisionError = "Livepeer is enabled but LIVEPEER_API_KEY is not configured on the server.";
    }
  }

  const payload = await transaction((db) => {
    const channel = getChannel(db, channelId);
    if (!channel) {
      return { error: "Channel not found." };
    }

    const livepeerConfig = getLivepeerConfigForChannel(db, channel.id);
    const livepeerEnabled = livepeerConfig?.enabled ?? LIVEPEER_DEFAULT_ENABLED;
    const hasLivepeerOutput = Boolean(livepeerEnabled && livepeerConfig?.ingestUrl && livepeerConfig?.streamKey);
    const hasCustomOutput = hasEnabledCustomOutput(db, channel.id);
    if (action === "start" && !hasLivepeerOutput && !hasCustomOutput) {
      return {
        error: "No broadcast output is configured. Keep Livepeer enabled or add and enable a custom RTMP output."
      };
    }

    const command: PlayoutCommand = {
      id: uuidv4(),
      channelId: channel.id,
      action,
      createdAt: nowIso()
    };

    db.commands.push(command);
    const state = getOrCreatePlayoutState(db, channel.id);
    if (action === "start") {
      state.isRunning = true;
      state.lastAdAt = nowIso();
      state.currentProgramOffsetSec = 0;
    }
    if (action === "stop") {
      state.isRunning = false;
      state.currentProgramOffsetSec = 0;
    }
    if (action === "previous") {
      state.queueIndex -= 1;
      state.currentProgramOffsetSec = 0;
    }
    if (action === "start" && livepeerProvisionError && !hasCustomOutput) {
      state.lastError = `Livepeer setup error: ${livepeerProvisionError}`;
    }
    state.updatedAt = nowIso();

    return { command, state, livepeer: livepeerConfigSnapshot ?? publicLivepeer(livepeerConfig) };
  });

  if (hasError(payload)) {
    return sendError(res, statusForPayloadError(payload.error), payload.error);
  }

  res.status(202).json(payload);
});

const serveWebApp = String(process.env.SERVE_WEB_APP ?? "true") !== "false";
const webIndexPath = path.join(WEB_DIST_DIR, "index.html");
if (serveWebApp && fsSync.existsSync(webIndexPath)) {
  app.use(express.static(WEB_DIST_DIR));
  app.get(/.*/, (req, res, next) => {
    if (req.method !== "GET") {
      return next();
    }

    if (
      req.path === "/api" ||
      req.path.startsWith("/api/") ||
      req.path.startsWith("/hls/") ||
      req.path.startsWith("/uploads/")
    ) {
      return next();
    }

    res.sendFile(webIndexPath);
  });
} else if (serveWebApp) {
  console.warn(`[api] Web dist not found at ${webIndexPath}; frontend static hosting disabled.`);
}

app.listen(API_PORT, () => {
  console.log(`OpenChannel API listening on port ${API_PORT}`);
  console.log(`Serving HLS output from ${HLS_ROOT}`);
  if (serveWebApp) {
    console.log(`Serving web build from ${WEB_DIST_DIR}`);
  }
  void recoverExternalIngestJobs();
});
