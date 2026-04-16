import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const cwd = process.cwd();
const rootEnvPath = path.join(cwd, ".env");
const webEnvPath = path.join(cwd, "apps", "web", ".env");

function parseEnvFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return new Map();
  }

  const content = fs.readFileSync(filePath, "utf8");
  const parsed = new Map();
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const equalsIndex = line.indexOf("=");
    if (equalsIndex < 0) {
      continue;
    }
    const key = line.slice(0, equalsIndex).trim().replace(/^export\s+/, "");
    let value = line.slice(equalsIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    parsed.set(key, value);
  }
  return parsed;
}

const rootEnv = parseEnvFile(rootEnvPath);
const webEnv = parseEnvFile(webEnvPath);
const forceRailway = process.argv.includes("--railway");
const railwayDetected =
  forceRailway ||
  Boolean(
    process.env.RAILWAY_PROJECT_ID ||
      process.env.RAILWAY_ENVIRONMENT_ID ||
      process.env.RAILWAY_SERVICE_ID
  );

function readValue(key, envMap) {
  if (process.env[key] !== undefined) {
    return process.env[key] ?? "";
  }
  return envMap.get(key) ?? "";
}

function hasValue(key, envMap) {
  return readValue(key, envMap).trim().length > 0;
}

const checks = [
  {
    key: "STORAGE_ROOT",
    scope: "root",
    required: railwayDetected,
    note: railwayDetected ? "Set this to /data/storage on Railway." : "Recommended for custom local location."
  },
  {
    key: "DATABASE_URL",
    scope: "root",
    required: railwayDetected,
    note: railwayDetected
      ? "Required for PostgreSQL-backed state in production."
      : "Optional locally; when unset, JSON file storage is used."
  },
  {
    key: "WEB_ORIGIN",
    scope: "root",
    required: false,
    note: "Use '*' or comma-separated allowed origins."
  },
  {
    key: "LIVEPEER_API_KEY",
    scope: "root",
    required: false,
    note: "Required only for Livepeer provisioning and RTMP output."
  },
  {
    key: "PINATA_JWT",
    scope: "root",
    required: false,
    note: "Required only for IPFS pinning uploads."
  },
  {
    key: "VITE_API_BASE",
    scope: "web",
    required: false,
    note: "Set to API URL for split-service deploys; leave blank for same-origin single-service deploys."
  },
  {
    key: "MEDIA_BASE_URL",
    scope: "root",
    required: false,
    note: "Set to API URL for split worker deployments so worker can fetch uploaded media over HTTP."
  }
];

let hasBlockingIssue = false;
const lines = [];
lines.push(`Environment check (${railwayDetected ? "Railway mode" : "local mode"})`);
lines.push("");

for (const check of checks) {
  const envMap = check.scope === "web" ? webEnv : rootEnv;
  const value = readValue(check.key, envMap);
  const present = hasValue(check.key, envMap);
  const state = present ? "SET" : check.required ? "MISSING" : "OPTIONAL";
  if (check.required && !present) {
    hasBlockingIssue = true;
  }

  const displayValue = present ? "[redacted]" : "(empty)";
  lines.push(`${state.padEnd(8)} ${check.key.padEnd(18)} ${displayValue}`);
  lines.push(`         ${check.note}`);
}

if (railwayDetected) {
  const storageRoot = readValue("STORAGE_ROOT", rootEnv).trim();
  if (storageRoot && storageRoot !== "/data/storage") {
    lines.push("");
    lines.push(`WARN     STORAGE_ROOT is '${storageRoot}'. Railway persistent volume path is usually '/data'.`);
  }
}

lines.push("");
if (hasBlockingIssue) {
  lines.push("Result: FAILED (required values missing).");
} else {
  lines.push("Result: OK.");
}

console.log(lines.join("\n"));
process.exit(hasBlockingIssue ? 1 : 0);
