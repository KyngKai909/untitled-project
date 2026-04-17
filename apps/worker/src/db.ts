import { promises as fs } from "node:fs";
import path from "node:path";
import { Pool } from "pg";
import type { Asset, Channel, DatabaseSchema, PlayoutState } from "@openchannel/shared";
import { DATABASE_URL, DB_LOCK_PATH, DB_PATH, HLS_ROOT } from "./config.js";

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

const LOCK_STALE_MS = 30_000;
const DB_LOCK_TIMEOUT_MS = 15_000;
const POSTGRES_STATE_TABLE = "opencast_state";
const POSTGRES_ROW_ID = 1;

let fileWriteQueue: Promise<void> = Promise.resolve();
let postgresInitPromise: Promise<void> | undefined;

const postgresPool = DATABASE_URL ? new Pool({ connectionString: DATABASE_URL }) : undefined;

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

function normalizeDb(input: unknown): DatabaseSchema {
  const parsed =
    typeof input === "object" && input !== null ? (input as Partial<DatabaseSchema>) : ({} as Partial<DatabaseSchema>);

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
    profileImageUrl:
      typeof channel.profileImageUrl === "string" && channel.profileImageUrl.trim()
        ? channel.profileImageUrl.trim()
        : undefined,
    bannerImageUrl:
      typeof channel.bannerImageUrl === "string" && channel.bannerImageUrl.trim()
        ? channel.bannerImageUrl.trim()
        : undefined,
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

async function ensureStorageRoots(): Promise<void> {
  await fs.mkdir(path.dirname(DB_PATH), { recursive: true });
  await fs.mkdir(HLS_ROOT, { recursive: true });
}

async function readLegacyFileDb(): Promise<DatabaseSchema> {
  try {
    const raw = await fs.readFile(DB_PATH, "utf8");
    return normalizeDb(JSON.parse(raw));
  } catch {
    return DEFAULT_DB;
  }
}

async function ensureFileDbExists(): Promise<void> {
  await ensureStorageRoots();
  try {
    await fs.access(DB_PATH);
  } catch {
    await fs.writeFile(DB_PATH, `${JSON.stringify(DEFAULT_DB, null, 2)}\n`, "utf8");
  }
}

async function withFileLock<T>(fn: () => Promise<T>): Promise<T> {
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
      if (Date.now() - startedAt > DB_LOCK_TIMEOUT_MS) {
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

async function readDbFromFile(): Promise<DatabaseSchema> {
  await ensureFileDbExists();
  const raw = await fs.readFile(DB_PATH, "utf8");
  return normalizeDb(JSON.parse(raw));
}

async function writeDbToFile(db: DatabaseSchema): Promise<void> {
  await ensureFileDbExists();
  const tmp = `${DB_PATH}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(db, null, 2)}\n`, "utf8");
  await fs.rename(tmp, DB_PATH);
}

async function transactionOnFile<T>(fn: (db: DatabaseSchema) => T | Promise<T>): Promise<T> {
  let result!: T;
  await (fileWriteQueue = fileWriteQueue
    .catch(() => undefined)
    .then(async () => {
      await withFileLock(async () => {
        const db = await readDbFromFile();
        result = await fn(db);
        await writeDbToFile(db);
      });
    }));

  return result;
}

async function ensurePostgresInitialized(): Promise<void> {
  if (!postgresPool) {
    return;
  }
  if (!postgresInitPromise) {
    postgresInitPromise = (async () => {
      await ensureStorageRoots();
      await postgresPool.query(
        `CREATE TABLE IF NOT EXISTS ${POSTGRES_STATE_TABLE} (
          id SMALLINT PRIMARY KEY,
          state JSONB NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          CONSTRAINT ${POSTGRES_STATE_TABLE}_single_row CHECK (id = ${POSTGRES_ROW_ID})
        )`
      );

      const seed = await readLegacyFileDb();
      await postgresPool.query(
        `INSERT INTO ${POSTGRES_STATE_TABLE} (id, state, updated_at)
         VALUES ($1, $2::jsonb, NOW())
         ON CONFLICT (id) DO NOTHING`,
        [POSTGRES_ROW_ID, JSON.stringify(seed)]
      );
    })();
  }
  await postgresInitPromise;
}

async function readDbFromPostgres(): Promise<DatabaseSchema> {
  if (!postgresPool) {
    throw new Error("Postgres pool is not configured.");
  }
  await ensurePostgresInitialized();
  const result = await postgresPool.query<{ state: unknown }>(
    `SELECT state FROM ${POSTGRES_STATE_TABLE} WHERE id = $1`,
    [POSTGRES_ROW_ID]
  );
  return normalizeDb(result.rows[0]?.state ?? DEFAULT_DB);
}

export async function readDb(): Promise<DatabaseSchema> {
  await ensureStorageRoots();
  if (postgresPool) {
    return readDbFromPostgres();
  }
  return readDbFromFile();
}

export async function transaction<T>(fn: (db: DatabaseSchema) => T | Promise<T>): Promise<T> {
  if (!postgresPool) {
    return transactionOnFile(fn);
  }

  await ensurePostgresInitialized();
  const client = await postgresPool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO ${POSTGRES_STATE_TABLE} (id, state, updated_at)
       VALUES ($1, $2::jsonb, NOW())
       ON CONFLICT (id) DO NOTHING`,
      [POSTGRES_ROW_ID, JSON.stringify(DEFAULT_DB)]
    );

    const current = await client.query<{ state: unknown }>(
      `SELECT state FROM ${POSTGRES_STATE_TABLE} WHERE id = $1 FOR UPDATE`,
      [POSTGRES_ROW_ID]
    );

    const db = normalizeDb(current.rows[0]?.state ?? DEFAULT_DB);
    const result = await fn(db);

    await client.query(
      `UPDATE ${POSTGRES_STATE_TABLE} SET state = $1::jsonb, updated_at = NOW() WHERE id = $2`,
      [JSON.stringify(db), POSTGRES_ROW_ID]
    );
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
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
