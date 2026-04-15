import { promises as fs } from "node:fs";
import path from "node:path";
import type { Asset, Channel, DatabaseSchema, PlayoutState } from "@openchannel/shared";
import { DB_LOCK_PATH, DB_PATH, HLS_ROOT, UPLOAD_ROOT } from "./config.js";

const DEFAULT_DB: DatabaseSchema = {
  channels: [],
  assets: [],
  assetFolders: [],
  playlistItems: [],
  playoutStates: [],
  commands: [],
  streamSchedules: [],
  destinations: [],
  livepeerConfigs: [],
  externalIngestJobs: []
};

let writeQueue: Promise<void> = Promise.resolve();
const LOCK_STALE_MS = 30_000;

function guessMediaKindFromPath(localPath: string | undefined): "video" | "audio" {
  if (!localPath) {
    return "video";
  }

  const ext = path.extname(localPath).toLowerCase();
  if ([".mp3", ".wav", ".aac", ".m4a", ".flac", ".ogg", ".opus"].includes(ext)) {
    return "audio";
  }

  return "video";
}

function normalizeAdTriggerMode(value: unknown): Channel["adTriggerMode"] {
  if (value === "disabled" || value === "time_interval" || value === "every_n_programs") {
    return value;
  }
  return "every_n_programs";
}

function normalizeStreamMode(value: unknown): Channel["streamMode"] {
  return value === "radio" ? "radio" : "video";
}

function normalizeInsertionCategory(value: unknown, assetType: Asset["type"]): Asset["insertionCategory"] {
  if (assetType === "program") {
    return "program";
  }
  if (value === "sponsor" || value === "bumper" || value === "ad") {
    return value;
  }
  return "ad";
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const timeoutMs = 15_000;
  const startedAt = Date.now();

  while (true) {
    try {
      const handle = await fs.open(DB_LOCK_PATH, "wx");
      try {
        return await fn();
      } finally {
        await handle.close();
        await fs.unlink(DB_LOCK_PATH).catch(() => undefined);
      }
    } catch (error) {
      if (Date.now() - startedAt > timeoutMs) {
        throw new Error(`Timed out acquiring DB lock at ${DB_LOCK_PATH}`);
      }
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
      try {
        const lockStat = await fs.stat(DB_LOCK_PATH);
        if (Date.now() - lockStat.mtimeMs > LOCK_STALE_MS) {
          await fs.unlink(DB_LOCK_PATH).catch(() => undefined);
          continue;
        }
      } catch {
        // Lock file may have been released between retries.
      }
      await sleep(25);
    }
  }
}

async function ensureStorage() {
  await fs.mkdir(path.dirname(DB_PATH), { recursive: true });
  await fs.mkdir(UPLOAD_ROOT, { recursive: true });
  await fs.mkdir(HLS_ROOT, { recursive: true });

  try {
    await fs.access(DB_PATH);
  } catch {
    await fs.writeFile(DB_PATH, `${JSON.stringify(DEFAULT_DB, null, 2)}\n`, "utf8");
  }
}

export async function readDb(): Promise<DatabaseSchema> {
  await ensureStorage();
  const raw = await fs.readFile(DB_PATH, "utf8");
  const parsed = JSON.parse(raw) as DatabaseSchema;

  const normalizedChannels = (parsed.channels ?? []).map((channel) => ({
    ...channel,
    ownerWallet:
      typeof channel.ownerWallet === "string" && /^0x[a-fA-F0-9]{40}$/.test(channel.ownerWallet.trim())
        ? channel.ownerWallet.trim().toLowerCase()
        : undefined,
    adInterval: Number.isFinite(channel.adInterval) ? Math.max(0, Math.floor(channel.adInterval)) : 2,
    adTriggerMode: normalizeAdTriggerMode(channel.adTriggerMode),
    adTimeIntervalSec: Number.isFinite(channel.adTimeIntervalSec)
      ? Math.max(30, Math.floor(channel.adTimeIntervalSec))
      : 10 * 60,
    brandColor: channel.brandColor ?? "#00a96b",
    playerLabel: channel.playerLabel ?? channel.name,
    streamMode: normalizeStreamMode(channel.streamMode),
    radioBackgroundUrl:
      typeof channel.radioBackgroundUrl === "string" && channel.radioBackgroundUrl.trim()
        ? channel.radioBackgroundUrl.trim()
        : undefined
  }));

  const normalizedAssets = (parsed.assets ?? []).map((asset) => ({
    ...asset,
    folderId: typeof asset.folderId === "string" && asset.folderId.trim() ? asset.folderId : undefined,
    storageProvider: asset.storageProvider ?? (asset.ipfsCid ? "ipfs" : "local"),
    insertionCategory: normalizeInsertionCategory(asset.insertionCategory, asset.type === "ad" ? "ad" : "program"),
    mediaKind: asset.mediaKind === "audio" ? "audio" : guessMediaKindFromPath(asset.localPath)
  }));
  const normalizedPlayoutStates = (parsed.playoutStates ?? []).map((state) => {
    const rawOffset = state.currentProgramOffsetSec;
    return {
      ...state,
      currentProgramOffsetSec:
        typeof rawOffset === "number" && Number.isFinite(rawOffset) ? Math.max(0, Math.floor(rawOffset)) : 0
    };
  });

  return {
    ...DEFAULT_DB,
    ...parsed,
    channels: normalizedChannels,
    assets: normalizedAssets,
    playoutStates: normalizedPlayoutStates,
    assetFolders: parsed.assetFolders ?? [],
    commands: parsed.commands ?? [],
    streamSchedules: parsed.streamSchedules ?? [],
    destinations: parsed.destinations ?? [],
    livepeerConfigs: parsed.livepeerConfigs ?? [],
    externalIngestJobs: parsed.externalIngestJobs ?? []
  };
}

export async function writeDb(db: DatabaseSchema): Promise<void> {
  await ensureStorage();
  const tmpPath = `${DB_PATH}.tmp`;
  await fs.writeFile(tmpPath, `${JSON.stringify(db, null, 2)}\n`, "utf8");
  await fs.rename(tmpPath, DB_PATH);
}

export async function transaction<T>(fn: (db: DatabaseSchema) => T | Promise<T>): Promise<T> {
  let result!: T;
  await (writeQueue = writeQueue
    .catch(() => undefined)
    .then(async () => {
      await withLock(async () => {
        const db = await readDb();
        result = await fn(db);
        await writeDb(db);
      });
    }));
  return result;
}

export function getChannel(db: DatabaseSchema, channelId: unknown): Channel | undefined {
  if (typeof channelId !== "string") {
    return undefined;
  }

  return db.channels.find((channel) => channel.id === channelId);
}

export function getOrCreatePlayoutState(db: DatabaseSchema, channelId: string): PlayoutState {
  let state = db.playoutStates.find((entry) => entry.channelId === channelId);
  if (!state) {
    state = {
      channelId,
      isRunning: false,
      queueIndex: 0,
      programCountSinceAd: 0,
      currentProgramOffsetSec: 0,
      updatedAt: new Date().toISOString()
    };
    db.playoutStates.push(state);
  }
  return state;
}

export function getChannelAssets(db: DatabaseSchema, channelId: string): Asset[] {
  return db.assets.filter((asset) => asset.channelId === channelId);
}
