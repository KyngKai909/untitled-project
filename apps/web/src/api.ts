import type {
  Asset,
  AssetInsertionCategory,
  AssetType,
  Channel,
  ChannelDetail,
  ChannelSummary,
  LivepeerStatus,
  PlayoutState,
  StreamMode,
  StreamSchedule
} from "./types";

const API_BASE = import.meta.env.VITE_API_BASE ?? "http://localhost:8787";

class ApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      ...(options.headers ?? {}),
      Accept: "application/json"
    }
  });

  const isJson = response.headers.get("content-type")?.includes("application/json") ?? false;
  const payload = isJson ? await response.json() : null;

  if (!response.ok) {
    throw new ApiError(response.status, payload?.error ?? `Request failed (${response.status})`);
  }

  return payload as T;
}

export function getApiBase(): string {
  return API_BASE;
}

export async function listChannels(ownerWallet?: string): Promise<ChannelSummary[]> {
  const query = ownerWallet ? `?ownerWallet=${encodeURIComponent(ownerWallet)}` : "";
  const payload = await request<{ channels: ChannelSummary[] }>(`/api/channels${query}`);
  return payload.channels;
}

export async function createChannel(input: {
  ownerWallet: string;
  name: string;
  description?: string;
  brandColor?: string;
  streamMode?: StreamMode;
}) {
  return request<{ channel: Channel }>(`/api/channels`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(input)
  });
}

export async function patchChannel(
  channelId: string,
  input: {
    name?: string;
    description?: string;
    brandColor?: string;
    playerLabel?: string;
    streamMode?: StreamMode;
    adTriggerMode?: "disabled" | "every_n_programs" | "time_interval";
    adInterval?: number;
    adTimeIntervalSec?: number;
  }
) {
  return request<{ channel: Channel }>(`/api/channels/${channelId}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(input)
  });
}

export async function getChannelDetail(channelId: string): Promise<ChannelDetail> {
  return request<ChannelDetail>(`/api/channels/${channelId}`);
}

export async function uploadAsset(
  channelId: string,
  input: { file: File; title?: string; type: AssetType; insertionCategory?: AssetInsertionCategory }
): Promise<{ asset: Asset; ipfsWarning?: string; compressionWarning?: string }> {
  const form = new FormData();
  form.set("file", input.file);
  if (input.title?.trim()) {
    form.set("title", input.title.trim());
  }
  form.set("type", input.type);
  if (input.insertionCategory) {
    form.set("insertionCategory", input.insertionCategory);
  }

  return request(`/api/channels/${channelId}/assets/upload`, {
    method: "POST",
    body: form
  });
}

export async function listLibraryAssets(ownerWallet: string, type?: AssetType): Promise<Asset[]> {
  const params = new URLSearchParams();
  params.set("ownerWallet", ownerWallet);
  if (type) {
    params.set("type", type);
  }
  const payload = await request<{ assets: Asset[] }>(`/api/library/assets?${params.toString()}`);
  return payload.assets;
}

export async function uploadLibraryAsset(input: {
  ownerWallet: string;
  file: File;
  title?: string;
  type: AssetType;
  insertionCategory?: AssetInsertionCategory;
}): Promise<{ asset: Asset; ipfsWarning?: string; compressionWarning?: string }> {
  const form = new FormData();
  form.set("ownerWallet", input.ownerWallet);
  form.set("file", input.file);
  form.set("type", input.type);
  if (input.title?.trim()) {
    form.set("title", input.title.trim());
  }
  if (input.insertionCategory) {
    form.set("insertionCategory", input.insertionCategory);
  }

  return request(`/api/library/assets/upload`, {
    method: "POST",
    body: form
  });
}

export async function importLibraryAssetsToChannel(
  channelId: string,
  input: { ownerWallet: string; assetIds: string[] }
): Promise<{ assets: Asset[] }> {
  return request(`/api/channels/${channelId}/library/import`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(input)
  });
}

export async function deleteAsset(assetId: string): Promise<{ deleted: string }> {
  return request(`/api/assets/${assetId}`, {
    method: "DELETE"
  });
}

export async function putPlaylist(channelId: string, assetIds: string[]): Promise<{ playlist: unknown[] }> {
  return request(`/api/channels/${channelId}/playlist`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ assetIds })
  });
}

export async function listStreamSchedules(channelId: string): Promise<StreamSchedule[]> {
  const payload = await request<{ schedules: StreamSchedule[] }>(`/api/channels/${channelId}/schedules`);
  return payload.schedules;
}

export async function createStreamSchedule(
  channelId: string,
  input: { startAt: string; endAt?: string; enabled?: boolean }
): Promise<{ schedule: StreamSchedule }> {
  return request(`/api/channels/${channelId}/schedules`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(input)
  });
}

export async function deleteStreamSchedule(scheduleId: string): Promise<{ deleted: string }> {
  return request(`/api/schedules/${scheduleId}`, {
    method: "DELETE"
  });
}

export async function getChannelStatus(
  channelId: string
): Promise<{ state: PlayoutState; streamUrl: string; livepeer?: LivepeerStatus }> {
  return request(`/api/channels/${channelId}/status`);
}

export async function sendChannelControl(channelId: string, action: "start" | "stop" | "skip" | "previous") {
  return request<{ state: PlayoutState }>(`/api/channels/${channelId}/control`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ action })
  });
}

export async function getLivepeerStatus(
  channelId: string
): Promise<{ livepeer?: LivepeerStatus; configured: boolean }> {
  return request(`/api/channels/${channelId}/livepeer`);
}

export async function provisionLivepeer(channelId: string): Promise<{ livepeer?: LivepeerStatus }> {
  return request(`/api/channels/${channelId}/livepeer/provision`, {
    method: "POST"
  });
}

export async function setLivepeerEnabled(
  channelId: string,
  enabled: boolean
): Promise<{ livepeer?: LivepeerStatus }> {
  return request(`/api/channels/${channelId}/livepeer`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ enabled })
  });
}
