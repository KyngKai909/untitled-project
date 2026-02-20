import type {
  AdTriggerMode,
  AssetType,
  AssetFolder,
  ChannelDetail,
  ChannelSummary,
  ExternalIngestJob,
  ExternalIngestItem,
  LivepeerStatus,
  PlayoutState,
  PlaylistItem,
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
    throw new ApiError(response.status, payload?.error ?? `Request failed with ${response.status}`);
  }

  return payload as T;
}

export function getApiBase(): string {
  return API_BASE;
}

export async function listChannels(): Promise<ChannelSummary[]> {
  const payload = await request<{ channels: ChannelSummary[] }>("/api/channels");
  return payload.channels;
}

export async function createChannel(input: {
  name: string;
  description?: string;
  slug?: string;
  adInterval?: number;
  adTriggerMode?: AdTriggerMode;
  adTimeIntervalSec?: number;
  brandColor?: string;
  playerLabel?: string;
  streamMode?: StreamMode;
}) {
  return request<{ channel: ChannelSummary["channel"] }>("/api/channels", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(input)
  });
}

export async function getChannelDetail(channelId: string): Promise<ChannelDetail> {
  return request<ChannelDetail>(`/api/channels/${channelId}`);
}

export async function patchChannel(
  channelId: string,
  input: {
    name?: string;
    description?: string;
    adInterval?: number;
    adTriggerMode?: AdTriggerMode;
    adTimeIntervalSec?: number;
    slug?: string;
    brandColor?: string;
    playerLabel?: string;
    streamMode?: StreamMode;
    radioBackgroundUrl?: string | null;
  }
) {
  return request<{ channel: ChannelSummary["channel"] }>(`/api/channels/${channelId}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(input)
  });
}

export async function uploadRadioBackground(channelId: string, file: File) {
  const form = new FormData();
  form.set("file", file);

  return request<{ channel: ChannelSummary["channel"] }>(`/api/channels/${channelId}/radio/background`, {
    method: "POST",
    body: form
  });
}

export async function getChannelStatus(
  channelId: string
): Promise<{ state: PlayoutState; streamUrl: string; livepeer?: LivepeerStatus }> {
  return request<{ state: PlayoutState; streamUrl: string; livepeer?: LivepeerStatus }>(
    `/api/channels/${channelId}/status`
  );
}

export async function sendChannelControl(channelId: string, action: "start" | "stop" | "skip") {
  return request<{ state: PlayoutState }>(`/api/channels/${channelId}/control`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ action })
  });
}

export async function uploadAsset(channelId: string, input: { file: File; title?: string; type: AssetType }) {
  const form = new FormData();
  form.set("file", input.file);
  if (input.title?.trim()) {
    form.set("title", input.title.trim());
  }
  form.set("type", input.type);

  return request(`/api/channels/${channelId}/assets/upload`, {
    method: "POST",
    body: form
  });
}

export async function ingestExternal(channelId: string, input: { url: string; title?: string; type: AssetType }) {
  return request(`/api/channels/${channelId}/assets/external`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(input)
  });
}

export async function queueExternalIngestJob(
  channelId: string,
  input: { urls: string[]; titlePrefix?: string; type: AssetType; expandPlaylists?: boolean }
) {
  return request<{ job: ExternalIngestJob }>(`/api/channels/${channelId}/assets/external/jobs`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(input)
  });
}

export async function listExternalIngestJobs(channelId: string, limit = 20): Promise<ExternalIngestJob[]> {
  const payload = await request<{ jobs: ExternalIngestJob[] }>(
    `/api/channels/${channelId}/assets/external/jobs?limit=${Math.max(1, Math.floor(limit))}`
  );
  return payload.jobs;
}

export async function patchExternalIngestJobItem(
  channelId: string,
  jobId: string,
  itemId: string,
  input: { title?: string }
) {
  return request<{ item: ExternalIngestItem }>(
    `/api/channels/${channelId}/assets/external/jobs/${jobId}/items/${itemId}`,
    {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(input)
    }
  );
}

export async function cancelExternalIngestJob(channelId: string, jobId: string) {
  return request<{ job: ExternalIngestJob }>(`/api/channels/${channelId}/assets/external/jobs/${jobId}/cancel`, {
    method: "POST"
  });
}

export async function deleteExternalIngestJob(channelId: string, jobId: string) {
  return request<{ deleted: string }>(`/api/channels/${channelId}/assets/external/jobs/${jobId}`, {
    method: "DELETE"
  });
}

export async function patchAsset(assetId: string, input: { title?: string; type?: AssetType; folderId?: string | null }) {
  return request(`/api/assets/${assetId}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(input)
  });
}

export async function deleteAsset(assetId: string) {
  return request(`/api/assets/${assetId}`, {
    method: "DELETE"
  });
}

export async function createFolder(channelId: string, input: { name: string; parentFolderId?: string | null }) {
  return request<{ folder: AssetFolder }>(`/api/channels/${channelId}/folders`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(input)
  });
}

export async function patchFolder(
  folderId: string,
  input: {
    name?: string;
    parentFolderId?: string | null;
  }
) {
  return request<{ folder: AssetFolder }>(`/api/folders/${folderId}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(input)
  });
}

export async function deleteFolder(folderId: string) {
  return request<{ deleted: string }>(`/api/folders/${folderId}`, {
    method: "DELETE"
  });
}

export async function createStreamSchedule(
  channelId: string,
  input: { startAt: string; endAt?: string; enabled?: boolean }
) {
  return request<{ schedule: StreamSchedule }>(`/api/channels/${channelId}/schedules`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(input)
  });
}

export async function patchStreamSchedule(
  scheduleId: string,
  input: { startAt?: string; endAt?: string | null; enabled?: boolean }
) {
  return request<{ schedule: StreamSchedule }>(`/api/schedules/${scheduleId}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(input)
  });
}

export async function deleteStreamSchedule(scheduleId: string) {
  return request<{ deleted: string }>(`/api/schedules/${scheduleId}`, {
    method: "DELETE"
  });
}

export async function listStreamSchedules(channelId: string): Promise<StreamSchedule[]> {
  const payload = await request<{ schedules: StreamSchedule[] }>(`/api/channels/${channelId}/schedules`);
  return payload.schedules;
}

export async function putPlaylist(channelId: string, assetIds: string[]) {
  return request<{ playlist: PlaylistItem[] }>(`/api/channels/${channelId}/playlist`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ assetIds })
  });
}

export async function addPlaylistItem(channelId: string, assetId: string) {
  return request(`/api/channels/${channelId}/playlist/items`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ assetId })
  });
}

export async function deletePlaylistItem(channelId: string, itemId: string) {
  return request(`/api/channels/${channelId}/playlist/items/${itemId}`, {
    method: "DELETE"
  });
}

export async function createDestination(
  channelId: string,
  input: { name: string; rtmpUrl: string; streamKey: string }
) {
  return request(`/api/channels/${channelId}/destinations`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(input)
  });
}

export async function patchDestination(
  destinationId: string,
  input: { name?: string; rtmpUrl?: string; streamKey?: string; enabled?: boolean }
) {
  return request(`/api/destinations/${destinationId}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(input)
  });
}

export async function deleteDestination(destinationId: string) {
  return request(`/api/destinations/${destinationId}`, {
    method: "DELETE"
  });
}

export async function getLivepeerStatus(channelId: string) {
  return request<{ livepeer?: LivepeerStatus; configured: boolean }>(`/api/channels/${channelId}/livepeer`);
}

export async function provisionLivepeer(channelId: string) {
  return request<{ livepeer?: LivepeerStatus }>(`/api/channels/${channelId}/livepeer/provision`, {
    method: "POST"
  });
}

export async function setLivepeerEnabled(channelId: string, enabled: boolean) {
  return request<{ livepeer?: LivepeerStatus }>(`/api/channels/${channelId}/livepeer`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ enabled })
  });
}
