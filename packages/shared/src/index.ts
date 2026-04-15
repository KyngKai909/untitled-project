export type AssetType = "program" | "ad";
export type StreamMode = "video" | "radio";
export type AssetMediaKind = "video" | "audio";
export type AdTriggerMode = "disabled" | "every_n_programs" | "time_interval";
export type AssetInsertionCategory = "program" | "ad" | "sponsor" | "bumper";

export interface Channel {
  id: string;
  ownerWallet?: string;
  name: string;
  slug: string;
  description: string;
  adInterval: number;
  adTriggerMode: AdTriggerMode;
  adTimeIntervalSec: number;
  brandColor: string;
  playerLabel: string;
  streamMode: StreamMode;
  radioBackgroundUrl?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Asset {
  id: string;
  channelId: string;
  title: string;
  sourceType: "upload" | "external";
  sourceUrl?: string;
  localPath: string;
  originalLocalPath?: string;
  folderId?: string;
  storageProvider?: "local" | "ipfs";
  ipfsCid?: string;
  ipfsUrl?: string;
  compression?: AssetCompression;
  durationSec?: number;
  type: AssetType;
  insertionCategory?: AssetInsertionCategory;
  mediaKind: AssetMediaKind;
  createdAt: string;
}

export interface AssetCompression {
  tool: "ffmpeg";
  profile: "h264_aac_720p" | "aac_audio";
  compressedAt: string;
}

export interface PlaylistItem {
  id: string;
  channelId: string;
  assetId: string;
  position: number;
  createdAt: string;
}

export interface PlayoutState {
  channelId: string;
  isRunning: boolean;
  currentAssetId?: string;
  currentAssetTitle?: string;
  currentStartedAt?: string;
  queueIndex: number;
  programCountSinceAd: number;
  lastAdAt?: string;
  updatedAt: string;
  lastError?: string;
}

export interface PlayoutCommand {
  id: string;
  channelId: string;
  action: "start" | "stop" | "skip" | "previous";
  createdAt: string;
}

export interface StreamSchedule {
  id: string;
  channelId: string;
  startAt: string;
  endAt?: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  endedAt?: string;
}

export interface MultistreamDestination {
  id: string;
  channelId: string;
  name: string;
  rtmpUrl: string;
  streamKey: string;
  enabled: boolean;
  createdAt: string;
}

export interface LivepeerConfig {
  channelId: string;
  enabled: boolean;
  streamId?: string;
  streamKey?: string;
  playbackId?: string;
  playbackUrl?: string;
  ingestUrl?: string;
  lastError?: string;
  updatedAt: string;
}

export interface AssetFolder {
  id: string;
  channelId: string;
  name: string;
  parentFolderId?: string;
  createdAt: string;
  updatedAt: string;
}

export type ExternalIngestJobStatus =
  | "queued"
  | "expanding"
  | "running"
  | "completed"
  | "partial"
  | "failed"
  | "canceled";

export type ExternalIngestItemStatus =
  | "queued"
  | "downloading"
  | "processing"
  | "uploading_ipfs"
  | "completed"
  | "failed"
  | "canceled";

export interface ExternalIngestItem {
  id: string;
  sourceUrl: string;
  title?: string;
  status: ExternalIngestItemStatus;
  progressPct: number;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  assetId?: string;
  error?: string;
}

export interface ExternalIngestJob {
  id: string;
  channelId: string;
  type: AssetType;
  titlePrefix?: string;
  requestedUrls: string[];
  expandedUrls: string[];
  expandPlaylists: boolean;
  status: ExternalIngestJobStatus;
  progressPct: number;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  items: ExternalIngestItem[];
  error?: string;
}

export interface DatabaseSchema {
  channels: Channel[];
  assets: Asset[];
  assetFolders: AssetFolder[];
  playlistItems: PlaylistItem[];
  playoutStates: PlayoutState[];
  commands: PlayoutCommand[];
  streamSchedules: StreamSchedule[];
  destinations: MultistreamDestination[];
  livepeerConfigs: LivepeerConfig[];
  externalIngestJobs: ExternalIngestJob[];
}

export interface ApiError {
  error: string;
}
