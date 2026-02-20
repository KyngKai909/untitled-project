import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const workspaceRoot = path.resolve(__dirname, "../../..");
loadEnvFile(path.join(workspaceRoot, ".env"));

export const STORAGE_ROOT = resolveStorageRoot(process.env.STORAGE_ROOT);
export const HLS_ROOT = path.join(STORAGE_ROOT, "hls");
export const UPLOAD_ROOT = path.join(STORAGE_ROOT, "uploads");
export const DB_PATH = path.join(STORAGE_ROOT, "db.json");
export const DB_LOCK_PATH = path.join(STORAGE_ROOT, "db.lock");
export const POLL_INTERVAL_MS = Number(process.env.WORKER_POLL_INTERVAL_MS ?? 1000);

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
