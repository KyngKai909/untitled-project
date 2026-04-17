export type AssetType = "program" | "ad";
export type StreamMode = "video" | "radio";
export type AssetInsertionCategory = "program" | "ad" | "sponsor" | "bumper";

export interface Channel {
  id: string;
  ownerWallet?: string;
  name: string;
  slug: string;
  description: string;
  profileImageUrl?: string;
  bannerImageUrl?: string;
  adInterval: number;
  adTriggerMode: "disabled" | "every_n_programs" | "time_interval";
  adTimeIntervalSec: number;
  brandColor: string;
  playerLabel: string;
  streamMode: StreamMode;
  radioBackgroundUrl?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AssetCompression {
  tool: "ffmpeg";
  profile: "h264_aac_720p" | "aac_audio";
  compressedAt: string;
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
  mediaKind: "video" | "audio";
  createdAt: string;
}

export interface PlaylistItem {
  id: string;
  channelId: string;
  assetId: string;
  position: number;
  createdAt: string;
  asset: Asset;
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

export interface PlayoutState {
  channelId: string;
  isRunning: boolean;
  currentAssetId?: string;
  currentAssetTitle?: string;
  currentStartedAt?: string;
  currentProgramOffsetSec?: number;
  queueIndex: number;
  programCountSinceAd: number;
  lastAdAt?: string;
  updatedAt: string;
  lastError?: string;
}

export interface LivepeerStatus {
  channelId: string;
  enabled: boolean;
  streamId?: string;
  playbackId?: string;
  playbackUrl?: string;
  ingestUrl?: string;
  lastError?: string;
  updatedAt: string;
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

export interface ChannelSummary {
  channel: Channel;
  assetCount: number;
  playlistCount: number;
}

export interface ChannelDetail {
  channel: Channel;
  assets: Asset[];
  schedules: StreamSchedule[];
  playlist: PlaylistItem[];
  state: PlayoutState;
  destinations: MultistreamDestination[];
  livepeer?: LivepeerStatus;
  streamUrl: string;
}
