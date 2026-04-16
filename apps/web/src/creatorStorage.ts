export interface VisualAssetRecord {
  id: string;
  channelId: string;
  name: string;
  url: string;
  kind: "image" | "gif";
  createdAt: string;
}

export interface AdEngineSettings {
  useUploadedBumpers: boolean;
  useSponsoredStings: boolean;
  useEmbeddedAdService: boolean;
  useGoogleAds: boolean;
  maxAdBreaksPerHour: number;
  bumperRotation: "sequential" | "weighted_random";
  allowMidroll: boolean;
  preferShortBumpers: boolean;
}

const VISUAL_STORE_KEY = "openchannel.creator.visual-assets.v1";
const AD_ENGINE_STORE_KEY = "openchannel.creator.ad-engine.v1";

const DEFAULT_AD_ENGINE_SETTINGS: AdEngineSettings = {
  useUploadedBumpers: true,
  useSponsoredStings: true,
  useEmbeddedAdService: false,
  useGoogleAds: false,
  maxAdBreaksPerHour: 6,
  bumperRotation: "sequential",
  allowMidroll: true,
  preferShortBumpers: true
};

function canUseStorage(): boolean {
  return typeof window !== "undefined" && Boolean(window.localStorage);
}

function readJson<T>(key: string, fallback: T): T {
  if (!canUseStorage()) {
    return fallback;
  }

  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) {
      return fallback;
    }
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function writeJson<T>(key: string, value: T): void {
  if (!canUseStorage()) {
    return;
  }

  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Ignore localStorage write failures.
  }
}

export function listVisualAssets(): VisualAssetRecord[] {
  const payload = readJson<Record<string, VisualAssetRecord>>(VISUAL_STORE_KEY, {});
  return Object.values(payload).sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

export function listVisualAssetsByChannel(channelId: string): VisualAssetRecord[] {
  return listVisualAssets().filter((asset) => asset.channelId === channelId);
}

export function saveVisualAsset(input: Omit<VisualAssetRecord, "id" | "createdAt">): VisualAssetRecord {
  const payload = readJson<Record<string, VisualAssetRecord>>(VISUAL_STORE_KEY, {});
  const id =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `visual-${Date.now()}-${Math.floor(Math.random() * 1000)}`;

  const record: VisualAssetRecord = {
    id,
    createdAt: new Date().toISOString(),
    ...input
  };

  payload[id] = record;
  writeJson(VISUAL_STORE_KEY, payload);
  return record;
}

export function deleteVisualAsset(assetId: string): void {
  const payload = readJson<Record<string, VisualAssetRecord>>(VISUAL_STORE_KEY, {});
  delete payload[assetId];
  writeJson(VISUAL_STORE_KEY, payload);
}

export function getAdEngineSettings(channelId: string): AdEngineSettings {
  const payload = readJson<Record<string, AdEngineSettings>>(AD_ENGINE_STORE_KEY, {});
  return {
    ...DEFAULT_AD_ENGINE_SETTINGS,
    ...(payload[channelId] ?? {})
  };
}

export function saveAdEngineSettings(channelId: string, settings: AdEngineSettings): void {
  const payload = readJson<Record<string, AdEngineSettings>>(AD_ENGINE_STORE_KEY, {});
  payload[channelId] = settings;
  writeJson(AD_ENGINE_STORE_KEY, payload);
}
