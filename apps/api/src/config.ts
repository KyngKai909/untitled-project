import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const workspaceRoot = path.resolve(__dirname, "../../..");
loadEnvFile(path.join(workspaceRoot, ".env"));

export const API_PORT = Number(process.env.PORT ?? process.env.API_PORT ?? 8787);
export const WEB_ORIGIN = process.env.WEB_ORIGIN ?? "*";
export const STORAGE_ROOT = resolveStorageRoot(process.env.STORAGE_ROOT);
export const DATABASE_URL = process.env.DATABASE_URL?.trim() ?? "";
export const UPLOAD_ROOT = path.join(STORAGE_ROOT, "uploads");
export const HLS_ROOT = path.join(STORAGE_ROOT, "hls");
export const DB_PATH = path.join(STORAGE_ROOT, "db.json");
export const DB_LOCK_PATH = path.join(STORAGE_ROOT, "db.lock");
export const WEB_DIST_DIR = resolveWebDistDir(process.env.WEB_DIST_DIR);
export const KEEP_ORIGINAL_UPLOADS = String(process.env.KEEP_ORIGINAL_UPLOADS ?? "false") === "true";
export const MAX_COMPRESSION_INPUT_BYTES = parsePositiveIntEnv(
  process.env.MAX_COMPRESSION_INPUT_BYTES,
  1024 * 1024 * 1024
);
export const UPLOAD_STORAGE_MODE = normalizeUploadStorageMode(process.env.UPLOAD_STORAGE_MODE);
export const DELETE_LOCAL_AFTER_IPFS = String(process.env.DELETE_LOCAL_AFTER_IPFS ?? "true") !== "false";

export const LIVEPEER_API_KEY = process.env.LIVEPEER_API_KEY ?? "";
export const LIVEPEER_API_BASE = process.env.LIVEPEER_API_BASE ?? "https://livepeer.studio/api";
export const LIVEPEER_RTMP_INGEST_BASE =
  process.env.LIVEPEER_RTMP_INGEST_BASE ?? "rtmp://rtmp.livepeer.com/live";
export const LIVEPEER_DEFAULT_ENABLED = String(process.env.LIVEPEER_DEFAULT_ENABLED ?? "true") !== "false";

export const PINATA_JWT = process.env.PINATA_JWT ?? "";
export const PINATA_UPLOAD_URL = process.env.PINATA_UPLOAD_URL ?? "https://uploads.pinata.cloud/v3/files";
export const PINATA_GATEWAY_BASE =
  process.env.PINATA_GATEWAY_BASE ?? "https://gateway.pinata.cloud/ipfs";
export const PINATA_NETWORK = process.env.PINATA_NETWORK ?? "public";

export const EXTERNAL_INGEST_DOWNLOAD_TIMEOUT_MS = parsePositiveIntEnv(
  process.env.EXTERNAL_INGEST_DOWNLOAD_TIMEOUT_MS,
  30 * 60 * 1000
);
export const EXTERNAL_INGEST_DOWNLOAD_STALL_TIMEOUT_MS = parsePositiveIntEnv(
  process.env.EXTERNAL_INGEST_DOWNLOAD_STALL_TIMEOUT_MS,
  4 * 60 * 1000
);
export const EXTERNAL_INGEST_EXPAND_TIMEOUT_MS = parsePositiveIntEnv(
  process.env.EXTERNAL_INGEST_EXPAND_TIMEOUT_MS,
  2 * 60 * 1000
);
export const EXTERNAL_INGEST_EXPAND_STALL_TIMEOUT_MS = parsePositiveIntEnv(
  process.env.EXTERNAL_INGEST_EXPAND_STALL_TIMEOUT_MS,
  45 * 1000
);

function loadEnvFile(envPath: string): void {
  if (!fs.existsSync(envPath)) {
    return;
  }

  const content = fs.readFileSync(envPath, "utf8");
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const equalsIndex = line.indexOf("=");
    if (equalsIndex < 0) {
      continue;
    }

    let key = line.slice(0, equalsIndex).trim();
    if (key.startsWith("export ")) {
      key = key.slice("export ".length).trim();
    }
    if (!key || process.env[key] !== undefined) {
      continue;
    }

    let value = line.slice(equalsIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

function resolveStorageRoot(configured: string | undefined): string {
  if (!configured || !configured.trim()) {
    return path.join(workspaceRoot, "storage");
  }

  const value = configured.trim();
  return path.isAbsolute(value) ? value : path.resolve(workspaceRoot, value);
}

function resolveWebDistDir(configured: string | undefined): string {
  if (!configured || !configured.trim()) {
    return path.join(workspaceRoot, "apps", "web", "dist");
  }

  const value = configured.trim();
  return path.isAbsolute(value) ? value : path.resolve(workspaceRoot, value);
}

function parsePositiveIntEnv(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.floor(parsed);
}

function normalizeUploadStorageMode(value: string | undefined): "local" | "hybrid" | "ipfs" {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "local" || normalized === "ipfs") {
    return normalized;
  }
  return "hybrid";
}
