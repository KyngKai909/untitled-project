import { FormEvent, useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  createDestination,
  createStreamSchedule,
  deleteAsset,
  deleteDestination,
  deleteStreamSchedule,
  getApiBase,
  getChannelDetail,
  getChannelStatus,
  importLibraryAssetsToChannel,
  listLibraryAssets,
  patchDestination,
  patchChannel,
  putPlaylist,
  sendChannelControl,
  setLivepeerEnabled,
  uploadChannelBannerImage,
  uploadChannelProfileImage
} from "../api";
import AppIcon from "../components/AppIcon";
import HlsPlayer from "../components/HlsPlayer";
import OverlayPanel from "../components/OverlayPanel";
import type { Asset, ChannelDetail, StreamMode } from "../types";
import { getStoredWalletAddress } from "../wallet";

type ManagerTab = "monitor" | "playlist" | "runtime" | "ads";

interface ManagerGuideEntry {
  asset: Asset;
  slot: number;
  isNow: boolean;
  durationSec?: number;
  startMs?: number;
  endMs?: number;
}

type ManagerViewerMode = "public" | "unlisted" | "token";
type ManagerMulticastStatus = "live" | "standby" | "idle";

interface ManagerMulticastDestination {
  id: string;
  name: string;
  wordmark: string;
  handle: string;
  region: string;
  viewers: number;
  active: boolean;
  status: ManagerMulticastStatus;
}

const MANAGER_MULTICAST_DESTINATIONS: ManagerMulticastDestination[] = [
  {
    id: "youtube",
    name: "YouTube",
    wordmark: "YT",
    handle: "@opencastcore",
    region: "Global",
    viewers: 281,
    active: true,
    status: "live"
  },
  {
    id: "twitch",
    name: "Twitch",
    wordmark: "TW",
    handle: "opencast_live",
    region: "North America",
    viewers: 97,
    active: true,
    status: "standby"
  },
  {
    id: "vimeo",
    name: "Vimeo",
    wordmark: "VI",
    handle: "OpenCast Broadcast",
    region: "EMEA",
    viewers: 42,
    active: true,
    status: "standby"
  },
  {
    id: "tiktok",
    name: "TikTok Live",
    wordmark: "TT",
    handle: "@opencast.tv",
    region: "US East",
    viewers: 0,
    active: false,
    status: "idle"
  },
  {
    id: "x",
    name: "X Live",
    wordmark: "X",
    handle: "@OpenCastCore",
    region: "US West",
    viewers: 0,
    active: false,
    status: "idle"
  }
];

function formatDateTime(iso: string | undefined): string {
  if (!iso) {
    return "Not set";
  }
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) {
    return "Invalid";
  }
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit"
  }).format(parsed);
}

function formatTimeFromMs(ms: number | undefined): string {
  if (!ms) {
    return "--";
  }
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit"
  }).format(new Date(ms));
}

function formatDateFromMs(ms: number | undefined): string {
  if (!ms) {
    return "Date unavailable";
  }
  return new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric"
  }).format(new Date(ms));
}

function formatDuration(seconds: number | undefined): string {
  if (!seconds || seconds <= 0) {
    return "--:--";
  }
  const total = Math.floor(seconds);
  const mins = Math.floor(total / 60);
  const rem = total % 60;
  return `${mins}:${String(rem).padStart(2, "0")}`;
}

function formatElapsed(seconds: number | undefined): string {
  if (!seconds || seconds <= 0) {
    return "--";
  }
  const total = Math.floor(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hours > 0) {
    return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${String(secs).padStart(2, "0")}s`;
  }
  return `${secs}s`;
}

function stationInitials(name: string | undefined): string {
  if (!name?.trim()) {
    return "ST";
  }
  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((word) => word.charAt(0))
    .join("")
    .toUpperCase();
}

function toMs(iso: string | undefined): number | undefined {
  if (!iso) {
    return undefined;
  }
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) {
    return undefined;
  }
  return parsed;
}

function toIsoDateTime(localInput: string): string | undefined {
  const trimmed = localInput.trim();
  if (!trimmed) {
    return undefined;
  }
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) {
    return undefined;
  }
  return parsed.toISOString();
}

function resolveStreamUrl(channelId: string, detail: ChannelDetail): string {
  const preferred =
    detail.livepeer?.enabled && detail.livepeer.playbackUrl ? detail.livepeer.playbackUrl : detail.streamUrl;

  if (preferred.startsWith("http")) {
    return preferred;
  }

  const normalized = preferred.startsWith("/") ? preferred : `/${preferred}`;
  return `${getApiBase()}${normalized || `/hls/${channelId}/index.m3u8`}`;
}

function toLivepeerEmbedUrl(playbackId: string | undefined): string | undefined {
  const id = playbackId?.trim();
  if (!id) {
    return undefined;
  }
  return `https://lvpr.tv/?v=${encodeURIComponent(id)}`;
}

function mod(index: number, length: number): number {
  if (!length) {
    return 0;
  }
  return ((index % length) + length) % length;
}

function findClosestIndex(ids: string[], targetId: string | undefined, preferredIndex: number): number | undefined {
  if (!targetId) {
    return undefined;
  }
  const matches = ids.map((id, index) => (id === targetId ? index : -1)).filter((value) => value >= 0);
  if (!matches.length) {
    return undefined;
  }

  let best = matches[0];
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of matches) {
    const distance = Math.abs(candidate - preferredIndex);
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }

  return best;
}

export default function StationManagerPage() {
  const { channelId } = useParams();

  const [detail, setDetail] = useState<ChannelDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  const [tab, setTab] = useState<ManagerTab>("monitor");

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [streamMode, setStreamMode] = useState<StreamMode>("video");

  const [queueDraft, setQueueDraft] = useState<string[]>([]);

  const [scheduleStart, setScheduleStart] = useState("");
  const [scheduleEnd, setScheduleEnd] = useState("");

  const [libraryAssets, setLibraryAssets] = useState<Asset[]>([]);
  const [loadingLibrary, setLoadingLibrary] = useState(false);
  const [selectedLibraryPrograms, setSelectedLibraryPrograms] = useState<string[]>([]);
  const [selectedLibraryAds, setSelectedLibraryAds] = useState<string[]>([]);

  const [adTriggerMode, setAdTriggerMode] = useState<"disabled" | "every_n_programs" | "time_interval">("every_n_programs");
  const [adInterval, setAdInterval] = useState(2);
  const [adTimeIntervalSec, setAdTimeIntervalSec] = useState(600);
  const [destinationName, setDestinationName] = useState("");
  const [destinationRtmpUrl, setDestinationRtmpUrl] = useState("");
  const [destinationStreamKey, setDestinationStreamKey] = useState("");

  const [scheduleModalOpen, setScheduleModalOpen] = useState(false);
  const [importProgramsModalOpen, setImportProgramsModalOpen] = useState(false);
  const [importAdsModalOpen, setImportAdsModalOpen] = useState(false);
  const [profileModalOpen, setProfileModalOpen] = useState(false);
  const [managerSettingsModalOpen, setManagerSettingsModalOpen] = useState(false);
  const [viewerMode, setViewerMode] = useState<ManagerViewerMode>("public");
  const [viewerCommentsEnabled, setViewerCommentsEnabled] = useState(true);
  const [viewerVotingEnabled, setViewerVotingEnabled] = useState(true);
  const [managerMulticastDestinations, setManagerMulticastDestinations] = useState<ManagerMulticastDestination[]>(
    MANAGER_MULTICAST_DESTINATIONS
  );
  const [profileImageUrlInput, setProfileImageUrlInput] = useState("");
  const [bannerImageUrlInput, setBannerImageUrlInput] = useState("");
  const [profileImageFile, setProfileImageFile] = useState<File | null>(null);
  const [bannerImageFile, setBannerImageFile] = useState<File | null>(null);

  const [nowMs, setNowMs] = useState(() => Date.now());

  async function refresh() {
    if (!channelId) {
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const [station, status] = await Promise.all([
        getChannelDetail(channelId),
        getChannelStatus(channelId).catch(() => null)
      ]);

      const merged: ChannelDetail = {
        ...station,
        state: status?.state ?? station.state,
        livepeer: status?.livepeer ?? station.livepeer,
        streamUrl: status?.streamUrl ?? station.streamUrl
      };

      setDetail(merged);
      setName(merged.channel.name);
      setDescription(merged.channel.description || "");
      setStreamMode(merged.channel.streamMode);
      setProfileImageUrlInput(merged.channel.profileImageUrl ?? "");
      setBannerImageUrlInput(merged.channel.bannerImageUrl ?? "");
      setQueueDraft(merged.playlist.map((item) => item.assetId));
      setAdTriggerMode(merged.channel.adTriggerMode);
      setAdInterval(merged.channel.adInterval);
      setAdTimeIntervalSec(merged.channel.adTimeIntervalSec);
      setInfo(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load station");
    } finally {
      setLoading(false);
    }
  }

  async function refreshLibrary(ownerWallet?: string | null) {
    if (!ownerWallet) {
      setLibraryAssets([]);
      return;
    }

    setLoadingLibrary(true);
    try {
      const assets = await listLibraryAssets(ownerWallet);
      setLibraryAssets(assets);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load creator library");
    } finally {
      setLoadingLibrary(false);
    }
  }

  useEffect(() => {
    void refresh();
  }, [channelId]);

  useEffect(() => {
    if (!channelId) {
      return;
    }

    const timer = setInterval(async () => {
      try {
        const status = await getChannelStatus(channelId);
        setDetail((current) => {
          if (!current) {
            return current;
          }
          return {
            ...current,
            state: status.state,
            livepeer: status.livepeer ?? current.livepeer,
            streamUrl: status.streamUrl
          };
        });
      } catch {
        // Keep last known status.
      }
    }, 5_000);

    return () => clearInterval(timer);
  }, [channelId]);

  useEffect(() => {
    const ownerWallet = detail?.channel.ownerWallet ?? getStoredWalletAddress();
    void refreshLibrary(ownerWallet);
  }, [detail?.channel.ownerWallet]);

  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const ownerWallet = detail?.channel.ownerWallet ?? getStoredWalletAddress();

  const streamUrl = useMemo(() => {
    if (!channelId || !detail) {
      return "";
    }
    return resolveStreamUrl(channelId, detail);
  }, [channelId, detail]);

  const livepeerEmbedUrl = useMemo(
    () => toLivepeerEmbedUrl(detail?.livepeer?.enabled ? detail.livepeer.playbackId : undefined),
    [detail]
  );

  const activeCustomDestination = useMemo(() => {
    return detail?.destinations.find((destination) => destination.enabled);
  }, [detail]);

  const stationPrograms = useMemo(() => {
    return detail ? detail.assets.filter((asset) => asset.type === "program") : [];
  }, [detail]);

  const stationAds = useMemo(() => {
    return detail ? detail.assets.filter((asset) => asset.type === "ad") : [];
  }, [detail]);

  const globalProgramLibrary = useMemo(() => {
    return libraryAssets.filter((asset) => asset.type === "program");
  }, [libraryAssets]);

  const globalAdLibrary = useMemo(() => {
    return libraryAssets.filter((asset) => asset.type === "ad");
  }, [libraryAssets]);

  const queuePreview = useMemo(() => {
    if (!detail) {
      return [] as Asset[];
    }
    const byId = new Map(stationPrograms.map((asset) => [asset.id, asset]));
    return queueDraft.map((assetId) => byId.get(assetId)).filter((asset): asset is Asset => Boolean(asset));
  }, [detail, queueDraft, stationPrograms]);

  const timeline = useMemo(() => {
    if (!detail) {
      return {
        current: undefined as Asset | undefined,
        remainingSec: undefined as number | undefined,
        progressPct: 0,
        guideEntries: [] as ManagerGuideEntry[],
        guideDateLabel: "Date unavailable"
      };
    }

    const playlist = detail.playlist.map((item) => item.asset).filter((asset) => asset.type === "program");
    const playlistIds = playlist.map((asset) => asset.id);
    const queueLength = playlist.length;
    const normalizedQueueIndex = queueLength > 0 ? mod(detail.state.queueIndex, queueLength) : 0;

    const currentAsset = detail.assets.find((asset) => asset.id === detail.state.currentAssetId);
    const currentPlaylistIndex = findClosestIndex(playlistIds, detail.state.currentAssetId, normalizedQueueIndex);

    let remainingSec: number | undefined;
    let progressPct = 0;

    if (currentAsset?.durationSec && detail.state.currentStartedAt) {
      const startedAtMs = Date.parse(detail.state.currentStartedAt);
      if (!Number.isNaN(startedAtMs)) {
        const elapsedChunkSec = Math.max(0, Math.floor((nowMs - startedAtMs) / 1000));
        const baseOffsetSec = Math.max(0, Math.floor(detail.state.currentProgramOffsetSec ?? 0));
        const elapsedSec = currentAsset.type === "program" ? baseOffsetSec + elapsedChunkSec : elapsedChunkSec;
        remainingSec = Math.max(0, currentAsset.durationSec - elapsedSec);
        progressPct = Math.min(100, Math.max(0, (elapsedSec / currentAsset.durationSec) * 100));
      }
    }

    const guideEntries: ManagerGuideEntry[] = [];
    const rawStartedMs = toMs(detail.state.currentStartedAt);

    if (queueLength > 0) {
      const startIndex = currentPlaylistIndex ?? normalizedQueueIndex;
      const currentOffsetSec = Math.max(0, Math.floor(detail.state.currentProgramOffsetSec ?? 0));
      const currentAssetStartMs = rawStartedMs !== undefined ? rawStartedMs - currentOffsetSec * 1000 : undefined;
      let cursorMs = currentAssetStartMs;
      const count = Math.min(queueLength, 12);

      for (let slot = 0; slot < count; slot += 1) {
        const asset = playlist[mod(startIndex + slot, queueLength)];
        const durationSec = asset.durationSec && asset.durationSec > 0 ? Math.floor(asset.durationSec) : undefined;
        const startMs = cursorMs;
        const endMs = durationSec !== undefined && cursorMs !== undefined ? cursorMs + durationSec * 1000 : undefined;

        guideEntries.push({
          asset,
          slot,
          isNow: slot === 0,
          durationSec,
          startMs,
          endMs
        });

        if (durationSec !== undefined && cursorMs !== undefined) {
          cursorMs = endMs;
        } else {
          cursorMs = undefined;
        }
      }
    }

    const guideDateLabel = formatDateFromMs(guideEntries[0]?.startMs ?? rawStartedMs);

    return {
      current: currentAsset,
      remainingSec,
      progressPct,
      guideEntries,
      guideDateLabel
    };
  }, [detail, nowMs]);

  const streamUptimeSec = useMemo(() => {
    if (!detail?.state.currentStartedAt || !detail.state.isRunning) {
      return undefined;
    }
    const startedAtMs = Date.parse(detail.state.currentStartedAt);
    if (Number.isNaN(startedAtMs)) {
      return undefined;
    }
    return Math.max(0, Math.floor((nowMs - startedAtMs) / 1000));
  }, [detail, nowMs]);

  const monitorStats = useMemo(() => {
    return {
      health: detail?.state.isRunning ? "Healthy" : "Offline",
      route: detail?.livepeer?.enabled
        ? "Livepeer"
        : activeCustomDestination
          ? `Custom RTMP (${activeCustomDestination.name})`
          : "Direct HLS",
      schedules: detail?.schedules.length ?? 0,
      queueDepth: detail?.playlist.length ?? 0
    };
  }, [activeCustomDestination, detail]);
  const managerActiveMulticast = useMemo(
    () => managerMulticastDestinations.filter((destination) => destination.active),
    [managerMulticastDestinations]
  );
  const managerLiveMulticast = useMemo(
    () => managerActiveMulticast.filter((destination) => destination.status === "live"),
    [managerActiveMulticast]
  );
  const managerTotalMulticastViewers = useMemo(
    () => managerActiveMulticast.reduce((total, destination) => total + destination.viewers, 0),
    [managerActiveMulticast]
  );
  const profileImageFilePreview = useMemo(
    () => (profileImageFile ? URL.createObjectURL(profileImageFile) : undefined),
    [profileImageFile]
  );
  const bannerImageFilePreview = useMemo(
    () => (bannerImageFile ? URL.createObjectURL(bannerImageFile) : undefined),
    [bannerImageFile]
  );
  const profileImagePreview = profileImageFilePreview || profileImageUrlInput.trim() || detail?.channel.profileImageUrl || "";
  const bannerImagePreview = bannerImageFilePreview || bannerImageUrlInput.trim() || detail?.channel.bannerImageUrl || "";

  useEffect(() => {
    return () => {
      if (profileImageFilePreview) {
        URL.revokeObjectURL(profileImageFilePreview);
      }
    };
  }, [profileImageFilePreview]);

  useEffect(() => {
    return () => {
      if (bannerImageFilePreview) {
        URL.revokeObjectURL(bannerImageFilePreview);
      }
    };
  }, [bannerImageFilePreview]);

  function toggleManagerMulticastDestination(destinationId: string) {
    setManagerMulticastDestinations((current) =>
      current.map((destination) => {
        if (destination.id !== destinationId) {
          return destination;
        }
        if (destination.active) {
          return { ...destination, active: false, status: "idle" };
        }
        return { ...destination, active: true, status: "standby" };
      })
    );
  }

  function cycleManagerMulticastState(destinationId: string) {
    setManagerMulticastDestinations((current) =>
      current.map((destination) => {
        if (destination.id !== destinationId || !destination.active) {
          return destination;
        }
        if (destination.status === "standby") {
          return { ...destination, status: "live" };
        }
        if (destination.status === "live") {
          return { ...destination, status: "standby" };
        }
        return { ...destination, status: "standby" };
      })
    );
  }

  function managerMulticastStatusLabel(destination: ManagerMulticastDestination): string {
    if (!destination.active) {
      return "Disabled";
    }
    if (destination.status === "live") {
      return "Live";
    }
    return "Standby";
  }

  function addProgramToDraft(assetId: string) {
    setQueueDraft((current) => [...current, assetId]);
  }

  function removeDraftItem(index: number) {
    setQueueDraft((current) => current.filter((_, cursor) => cursor !== index));
  }

  function moveDraftItem(index: number, delta: number) {
    setQueueDraft((current) => {
      const nextIndex = index + delta;
      if (nextIndex < 0 || nextIndex >= current.length) {
        return current;
      }
      const next = [...current];
      const [item] = next.splice(index, 1);
      next.splice(nextIndex, 0, item);
      return next;
    });
  }

  function toggleLibraryProgram(assetId: string, checked: boolean) {
    setSelectedLibraryPrograms((current) => {
      if (checked) {
        return current.includes(assetId) ? current : [...current, assetId];
      }
      return current.filter((id) => id !== assetId);
    });
  }

  function toggleLibraryAd(assetId: string, checked: boolean) {
    setSelectedLibraryAds((current) => {
      if (checked) {
        return current.includes(assetId) ? current : [...current, assetId];
      }
      return current.filter((id) => id !== assetId);
    });
  }

  async function onImportLibraryAssets(assetIds: string[]) {
    if (!channelId || !ownerWallet || assetIds.length === 0) {
      return;
    }

    setBusy(true);
    setError(null);
    setInfo(null);

    try {
      const payload = await importLibraryAssetsToChannel(channelId, {
        ownerWallet,
        assetIds
      });
      setInfo(`Imported ${payload.assets.length} asset${payload.assets.length === 1 ? "" : "s"} into this station.`);
      setSelectedLibraryPrograms([]);
      setSelectedLibraryAds([]);
      setImportProgramsModalOpen(false);
      setImportAdsModalOpen(false);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to import assets from creator library");
    } finally {
      setBusy(false);
    }
  }

  async function onSaveStationProfile() {
    if (!channelId) {
      return;
    }

    setBusy(true);
    setError(null);
    setInfo(null);

    try {
      await patchChannel(channelId, {
        name: name.trim() || undefined,
        description: description.trim(),
        streamMode,
        profileImageUrl: profileImageUrlInput.trim(),
        bannerImageUrl: bannerImageUrlInput.trim()
      });
      if (profileImageFile) {
        await uploadChannelProfileImage(channelId, { file: profileImageFile });
      }
      if (bannerImageFile) {
        await uploadChannelBannerImage(channelId, { file: bannerImageFile });
      }
      setProfileImageFile(null);
      setBannerImageFile(null);
      setProfileModalOpen(false);
      setInfo("Station profile updated.");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update station profile");
    } finally {
      setBusy(false);
    }
  }

  async function onSaveAdRules() {
    if (!channelId) {
      return;
    }

    setBusy(true);
    setError(null);
    setInfo(null);

    try {
      await patchChannel(channelId, {
        adTriggerMode,
        adInterval: Math.max(0, Math.floor(adInterval)),
        adTimeIntervalSec: Math.max(30, Math.floor(adTimeIntervalSec))
      });
      setInfo("Ad injection rules updated.");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update ad settings");
    } finally {
      setBusy(false);
    }
  }

  async function onDeleteAsset(assetId: string) {
    setBusy(true);
    setError(null);
    setInfo(null);

    try {
      await deleteAsset(assetId);
      setInfo("Asset removed.");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete asset");
    } finally {
      setBusy(false);
    }
  }

  async function onSaveQueue() {
    if (!channelId) {
      return;
    }

    setBusy(true);
    setError(null);
    setInfo(null);

    try {
      await putPlaylist(channelId, queueDraft);
      setInfo("Playlist order pushed to station.");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save queue");
    } finally {
      setBusy(false);
    }
  }

  async function onCreateSchedule(event: FormEvent) {
    event.preventDefault();
    if (!channelId) {
      return;
    }

    const startAt = toIsoDateTime(scheduleStart);
    const endAt = scheduleEnd ? toIsoDateTime(scheduleEnd) : undefined;

    if (!startAt) {
      setError("Start time is required.");
      return;
    }

    setBusy(true);
    setError(null);
    setInfo(null);

    try {
      await createStreamSchedule(channelId, { startAt, endAt, enabled: true });
      setScheduleStart("");
      setScheduleEnd("");
      setScheduleModalOpen(false);
      setInfo("Schedule created.");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create schedule");
    } finally {
      setBusy(false);
    }
  }

  async function onStartAlwaysOnNow() {
    if (!channelId) {
      return;
    }

    setBusy(true);
    setError(null);
    setInfo(null);

    try {
      await createStreamSchedule(channelId, {
        startAt: new Date().toISOString(),
        enabled: true
      });
      await sendChannelControl(channelId, "start");
      setInfo("24/7 schedule started. Station is now live.");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start 24/7 schedule");
    } finally {
      setBusy(false);
    }
  }

  async function onDeleteSchedule(scheduleId: string) {
    setBusy(true);
    setError(null);
    setInfo(null);

    try {
      await deleteStreamSchedule(scheduleId);
      setInfo("Schedule removed.");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete schedule");
    } finally {
      setBusy(false);
    }
  }

  async function onControl(action: "start" | "stop" | "skip" | "previous") {
    if (!channelId) {
      return;
    }

    setBusy(true);
    setError(null);
    setInfo(null);

    try {
      await sendChannelControl(channelId, action);
      if (action === "start") {
        setInfo("Station is going live.");
      } else if (action === "stop") {
        setInfo("Station stopped.");
      } else if (action === "skip") {
        setInfo("Skipped to next item.");
      } else {
        setInfo("Jumped back to previous playlist item.");
      }
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to send control action");
    } finally {
      setBusy(false);
    }
  }

  async function onSetLivepeerRoute(enabled: boolean) {
    if (!channelId) {
      return;
    }

    if (!enabled && !activeCustomDestination) {
      setError("Add and enable a custom RTMP output before switching away from Livepeer.");
      return;
    }

    setBusy(true);
    setError(null);
    setInfo(null);

    try {
      await setLivepeerEnabled(channelId, enabled);
      setInfo(enabled ? "Output route switched to Livepeer." : "Output route switched to custom RTMP.");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update output route");
    } finally {
      setBusy(false);
    }
  }

  async function onCreateDestination(event: FormEvent) {
    event.preventDefault();
    if (!channelId) {
      return;
    }

    setBusy(true);
    setError(null);
    setInfo(null);

    try {
      await createDestination(channelId, {
        name: destinationName.trim(),
        rtmpUrl: destinationRtmpUrl.trim(),
        streamKey: destinationStreamKey.trim()
      });
      setDestinationName("");
      setDestinationRtmpUrl("");
      setDestinationStreamKey("");
      setInfo("Custom output added and set as active destination.");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add custom output destination");
    } finally {
      setBusy(false);
    }
  }

  async function onSetDestinationEnabled(destinationId: string, enabled: boolean) {
    setBusy(true);
    setError(null);
    setInfo(null);

    try {
      await patchDestination(destinationId, { enabled });
      setInfo(enabled ? "Custom output activated." : "Custom output disabled.");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update custom output destination");
    } finally {
      setBusy(false);
    }
  }

  async function onDeleteDestination(destinationId: string) {
    setBusy(true);
    setError(null);
    setInfo(null);

    try {
      await deleteDestination(destinationId);
      setInfo("Custom output destination removed.");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete custom output destination");
    } finally {
      setBusy(false);
    }
  }

  if (!channelId) {
    return (
      <main className="routeFrame routeFrame--workspace">
        <div className="inlineAlert inlineAlert--error">Channel id is missing.</div>
      </main>
    );
  }

  return (
    <main className="routeFrame routeFrame--workspace">
      {error ? <div className="inlineAlert inlineAlert--error">{error}</div> : null}
      {info ? <div className="inlineAlert inlineAlert--info">{info}</div> : null}

      <section className="workspaceMain workspaceMain--manager managerConsole">
        <header className="managerConsoleHead">
          <div className="managerConsoleIdentity">
            <div className="managerConsoleIdentity__logo">
              {profileImagePreview ? (
                <img src={profileImagePreview} alt={`${detail?.channel.name ?? "Station"} logo`} />
              ) : (
                <span>{stationInitials(detail?.channel.name)}</span>
              )}
            </div>
            <div className="managerConsoleIdentity__meta">
              <p className="managerConsoleIdentity__eyebrow">Station Manager</p>
              <h1>{detail?.channel.name ?? "Loading station"}</h1>
              <p>
                {detail?.channel.description?.trim() ||
                  "Operational console for playback, routing, runtime scheduling, and ad pacing."}
              </p>
              {detail ? (
                <p className="metaLine">
                  <span className={`statusPill ${detail.state.isRunning ? "statusPill--live" : "statusPill--off"}`}>
                    {detail.state.isRunning ? "Live" : "Off Air"}
                  </span>
                  <span>{detail.channel.streamMode.toUpperCase()} mode</span>
                  {timeline.current ? <span>Now: {timeline.current.title}</span> : <span>No active item</span>}
                  {timeline.remainingSec !== undefined ? <span>Remaining {formatDuration(timeline.remainingSec)}</span> : null}
                </p>
              ) : null}
            </div>
          </div>
          <div className="managerConsoleActions">
            <Link className="uiButton uiButton--secondary" to={`/stations/${channelId}/preview`}>
              <AppIcon name="eye" />
              Open Viewer
            </Link>
            <button className="uiButton uiButton--secondary" type="button" onClick={() => setProfileModalOpen(true)} disabled={busy || loading || !detail}>
              <AppIcon name="user" />
              Edit Station
            </button>
            <button className="uiButton uiButton--secondary" type="button" onClick={() => setManagerSettingsModalOpen(true)} disabled={busy || loading}>
              <AppIcon name="menu" />
              Stream Settings
            </button>
            <button
              className={`uiButton ${detail?.state.isRunning ? "uiButton--danger" : "uiButton--accent"}`}
              type="button"
              onClick={() => void onControl(detail?.state.isRunning ? "stop" : "start")}
              disabled={busy || loading || !detail}
            >
              <AppIcon name={detail?.state.isRunning ? "stop" : "zap"} />
              {detail?.state.isRunning ? "Stop Stream" : "Go Live"}
            </button>
          </div>
        </header>

        {detail ? (
          <section className="summaryStrip summaryStrip--manager">
            <article>
              <h4>Status</h4>
              <p>{detail.state.isRunning ? "Live" : "Off Air"}</p>
            </article>
            <article>
              <h4>Output Route</h4>
              <p>{monitorStats.route}</p>
            </article>
            <article>
              <h4>Queue Depth</h4>
              <p>{monitorStats.queueDepth}</p>
            </article>
            <article>
              <h4>Schedules</h4>
              <p>{monitorStats.schedules}</p>
            </article>
          </section>
        ) : null}

        <nav className="managerTabs" aria-label="Station Workspace Tabs">
            <button type="button" data-active={tab === "monitor"} onClick={() => setTab("monitor")}>
              <span className="uiInline">
                <AppIcon name="monitor" />
                Monitor
              </span>
            </button>
            <button type="button" data-active={tab === "playlist"} onClick={() => setTab("playlist")}>
              <span className="uiInline">
                <AppIcon name="list" />
                Playlist
              </span>
            </button>
            <button type="button" data-active={tab === "runtime"} onClick={() => setTab("runtime")}>
              <span className="uiInline">
                <AppIcon name="clock" />
                Runtime
              </span>
            </button>
            <button type="button" data-active={tab === "ads"} onClick={() => setTab("ads")}>
              <span className="uiInline">
                <AppIcon name="megaphone" />
                Ads
              </span>
            </button>
        </nav>

        <section className="workspaceContent managerConsoleContent">
            {loading || !detail ? (
              <section className="workspaceSection">
                <div className="workspaceSection__body">
                  <p className="loadingState">Loading station...</p>
                </div>
              </section>
            ) : null}

            {!loading && detail && tab === "monitor" ? (
              <>
                <section className="workspaceSection">
                  <header className="workspaceSection__head">
                    <div>
                      <h2>Live Monitor</h2>
                      <p>Primary feed, stream health, and route controls.</p>
                    </div>
                    <div className="workspaceHead__actions">
                      <button
                        className="uiButton uiButton--secondary"
                        type="button"
                        onClick={() => void onSetLivepeerRoute(true)}
                        disabled={busy || Boolean(detail.livepeer?.enabled)}
                      >
                        <AppIcon name="zap" />
                        Use Livepeer Output
                      </button>
                      <button
                        className="uiButton uiButton--secondary"
                        type="button"
                        onClick={() => void onSetLivepeerRoute(false)}
                        disabled={busy || !activeCustomDestination || !detail.livepeer?.enabled}
                      >
                        <AppIcon name="send" />
                        Use Custom Output
                      </button>
                    </div>
                  </header>
                  <div className="workspaceSection__body">
                    <div className="healthGrid">
                      <article className="healthCard">
                        <h4>Stream Health</h4>
                        <p>{monitorStats.health}</p>
                        <small>{detail.state.isRunning ? "Receiving active signal" : "No live signal detected"}</small>
                      </article>
                      <article className="healthCard">
                        <h4>Output Route</h4>
                        <p>{monitorStats.route}</p>
                        <small className="wrapAnywhere">{streamUrl || "URL unavailable"}</small>
                      </article>
                      <article className="healthCard">
                        <h4>Uptime</h4>
                        <p>{formatElapsed(streamUptimeSec)}</p>
                        <small>Since current segment started</small>
                      </article>
                      <article className="healthCard">
                        <h4>Queue & Schedule</h4>
                        <p>
                          {monitorStats.queueDepth} / {monitorStats.schedules}
                        </p>
                        <small>Programs in queue / active schedules</small>
                      </article>
                    </div>
                    {livepeerEmbedUrl ? (
                      <div className="mediaShell">
                        <iframe
                          src={livepeerEmbedUrl}
                          title="Livepeer Player"
                          allow="autoplay; fullscreen; picture-in-picture"
                        />
                      </div>
                    ) : streamUrl ? (
                      <HlsPlayer src={streamUrl} muted />
                    ) : (
                      <p className="emptyState">Stream URL not available.</p>
                    )}
                    <p className="metaLine">
                      <span>Livepeer is the default broadcast route.</span>
                      {activeCustomDestination ? (
                        <span>Active custom output: {activeCustomDestination.name}</span>
                      ) : (
                        <span>Add a custom output before switching away from Livepeer.</span>
                      )}
                    </p>
                  </div>
                </section>

                <section className="workspaceSection">
                  <header className="workspaceSection__head">
                    <div>
                      <h2>Output Destinations</h2>
                      <p>Configure custom RTMP routes and keep one active fallback target.</p>
                    </div>
                  </header>
                  <div className="workspaceSection__body">
                    {detail.destinations.length === 0 ? (
                      <p className="emptyState">No custom outputs configured yet.</p>
                    ) : (
                      <div className="dataTable">
                        {detail.destinations.map((destination) => (
                          <article className="dataRow" key={destination.id}>
                            <div>
                              <h4 className="dataRow__title">{destination.name}</h4>
                              <p className="dataRow__meta">
                                {destination.rtmpUrl}
                                <br />
                                Key: {destination.streamKey ? "••••••••" : "(missing)"}
                              </p>
                            </div>
                            <div className="dataRow__actions">
                              <button
                                className="uiButton uiButton--secondary"
                                type="button"
                                onClick={() => void onSetDestinationEnabled(destination.id, !destination.enabled)}
                                disabled={busy}
                              >
                                {destination.enabled ? "Deactivate" : "Activate"}
                              </button>
                              <button
                                className="uiButton uiButton--danger"
                                type="button"
                                onClick={() => void onDeleteDestination(destination.id)}
                                disabled={busy}
                              >
                                <AppIcon name="trash" />
                                Delete
                              </button>
                            </div>
                          </article>
                        ))}
                      </div>
                    )}

                    <form className="fieldGrid" onSubmit={(event) => void onCreateDestination(event)}>
                      <label className="field">
                        <span>Destination Name</span>
                        <input
                          className="uiInput"
                          value={destinationName}
                          onChange={(event) => setDestinationName(event.target.value)}
                          placeholder="My RTMP Endpoint"
                          disabled={busy}
                          required
                        />
                      </label>
                      <label className="field">
                        <span>RTMP URL</span>
                        <input
                          className="uiInput"
                          value={destinationRtmpUrl}
                          onChange={(event) => setDestinationRtmpUrl(event.target.value)}
                          placeholder="rtmp://your-server/live"
                          disabled={busy}
                          required
                        />
                      </label>
                      <label className="field">
                        <span>Stream Key</span>
                        <input
                          className="uiInput"
                          value={destinationStreamKey}
                          onChange={(event) => setDestinationStreamKey(event.target.value)}
                          placeholder="your-stream-key"
                          disabled={busy}
                          required
                        />
                      </label>
                      <div className="workspaceHead__actions">
                        <button className="uiButton uiButton--accent" type="submit" disabled={busy}>
                          <AppIcon name="plus" />
                          Add Custom Output
                        </button>
                      </div>
                    </form>
                  </div>
                </section>

                <section className="workspaceSection">
                  <header className="workspaceSection__head">
                    <div>
                      <h2>Audience Controls (Prototype)</h2>
                      <p>Viewer access, comments/voting toggles, and multicast destinations.</p>
                    </div>
                  </header>
                  <div className="workspaceSection__body">
                    <section className="managerPrototypeSummary">
                      <article>
                        <h4>Viewer Access</h4>
                        <p>{viewerMode === "public" ? "Public" : viewerMode === "unlisted" ? "Unlisted" : "Token-gated"}</p>
                      </article>
                      <article>
                        <h4>Comments</h4>
                        <p>{viewerCommentsEnabled ? "Enabled" : "Disabled"}</p>
                      </article>
                      <article>
                        <h4>Voting</h4>
                        <p>{viewerVotingEnabled ? "Enabled" : "Disabled"}</p>
                      </article>
                      <article>
                        <h4>Multicast</h4>
                        <p>
                          {managerLiveMulticast.length} live / {managerActiveMulticast.length} active
                        </p>
                      </article>
                    </section>

                    <section className="multicastBoard" aria-label="Manager Multicast Destinations">
                      {managerMulticastDestinations.map((destination) => (
                        <article className="multicastRow" key={`manager-${destination.id}`}>
                          <div className="multicastRow__identity">
                            <span className={`multicastWordmark multicastWordmark--${destination.id}`}>{destination.wordmark}</span>
                            <div className="multicastMeta">
                              <p className="multicastMeta__name">{destination.name}</p>
                              <p className="multicastMeta__handle">{destination.handle}</p>
                            </div>
                          </div>
                          <div className="multicastRow__actions">
                            <span
                              className={`statusPill ${
                                destination.status === "live"
                                  ? "statusPill--live"
                                  : destination.active
                                    ? ""
                                    : "statusPill--off"
                              }`}
                            >
                              {managerMulticastStatusLabel(destination)}
                            </span>
                            <div className="managerInlineActions">
                              <button
                                className="uiButton uiButton--ghost uiButton--compact"
                                type="button"
                                onClick={() => toggleManagerMulticastDestination(destination.id)}
                              >
                                {destination.active ? "Disable" : "Enable"}
                              </button>
                              <button
                                className="uiButton uiButton--secondary uiButton--compact"
                                type="button"
                                onClick={() => cycleManagerMulticastState(destination.id)}
                                disabled={!destination.active}
                              >
                                {destination.status === "live" ? "Standby" : "Go Live"}
                              </button>
                            </div>
                          </div>
                        </article>
                      ))}
                    </section>

                    <p className="emptyState">
                      Prototype only. Persisting these settings to API and auth roles can be wired after backend work.
                    </p>
                  </div>
                </section>

                <section className="workspaceSection">
                  <header className="workspaceSection__head">
                    <div>
                      <h2>Program Guide</h2>
                      <p>{timeline.guideDateLabel}</p>
                    </div>
                    <div className="workspaceHead__actions">
                      <button className="uiButton uiButton--secondary" type="button" onClick={() => void onControl("previous")} disabled={busy}>
                        <AppIcon name="skip-prev" />
                        Previous
                      </button>
                      <button className="uiButton uiButton--secondary" type="button" onClick={() => void onControl("skip")} disabled={busy}>
                        <AppIcon name="skip-next" />
                        Skip
                      </button>
                    </div>
                  </header>
                  <div className="workspaceSection__body">
                    <p className="metaLine">
                      <span>{timeline.current?.title ?? "No active program"}</span>
                      <span>Progress {Math.round(timeline.progressPct)}%</span>
                      <span>Remaining {formatDuration(timeline.remainingSec)}</span>
                    </p>

                    {timeline.guideEntries.length === 0 ? (
                      <p className="emptyState">No lineup available yet. Add programs in the Playlist tab.</p>
                    ) : (
                      <section className="guideTable" aria-label="Station Program Guide">
                        <div className="guideTable__head">
                          <p>Time</p>
                          <p>Program</p>
                          <p>Status</p>
                        </div>
                        <div className="guideTable__body">
                          {timeline.guideEntries.map((entry) => (
                            <article className={`guideItem ${entry.isNow ? "guideItem--live" : ""}`} key={`${entry.asset.id}-${entry.slot}`}>
                              <div className="guideItem__top">
                                <p className="guideItem__time">
                                  {formatTimeFromMs(entry.startMs)} - {formatTimeFromMs(entry.endMs)}
                                </p>
                                <span className={`statusPill ${entry.isNow ? "statusPill--live" : "statusPill--off"}`}>
                                  {entry.isNow ? "Now" : "Up Next"}
                                </span>
                              </div>
                              <p className="guideItem__title" title={entry.asset.title}>
                                {entry.asset.title}
                              </p>
                              <p className="guideItem__meta">Length {formatDuration(entry.durationSec)}</p>
                            </article>
                          ))}
                        </div>
                      </section>
                    )}
                  </div>
                </section>
              </>
            ) : null}

            {!loading && detail && tab === "playlist" ? (
              <section className="workspaceSection">
                <header className="workspaceSection__head">
                  <div>
                    <h2>Playlist Workbench</h2>
                    <p>Add programs, reorder queue, and push finalized sequence to playout.</p>
                  </div>
                  <button className="uiButton uiButton--secondary" type="button" onClick={() => setImportProgramsModalOpen(true)}>
                    <AppIcon name="upload" />
                    Import Programs
                  </button>
                </header>
                <div className="workspaceSection__body">
                  <div className="managerSplit">
                    <section className="managerSplit__pane">
                      <header className="managerSplit__head">
                        <div>
                          <h3>Station Programs</h3>
                          <p>{stationPrograms.length} available</p>
                        </div>
                      </header>
                      <div className="managerSplit__body">
                        {stationPrograms.length === 0 ? <p className="emptyState">No programs imported yet.</p> : null}
                        {stationPrograms.length > 0 ? (
                          <div className="dataTable">
                            {stationPrograms.map((asset) => (
                              <article className="dataRow" key={asset.id}>
                                <div>
                                  <p className="dataRow__title">{asset.title}</p>
                                  <p className="dataRow__meta">{formatDuration(asset.durationSec)}</p>
                                </div>
                                <div className="dataRow__actions">
                                  <button className="uiButton uiButton--secondary" type="button" onClick={() => addProgramToDraft(asset.id)} disabled={busy}>
                                    <AppIcon name="plus" />
                                    Add
                                  </button>
                                </div>
                              </article>
                            ))}
                          </div>
                        ) : null}
                      </div>
                    </section>

                    <section className="managerSplit__pane">
                      <header className="managerSplit__head">
                        <div>
                          <h3>Draft Queue</h3>
                          <p>{queuePreview.length} staged</p>
                        </div>
                      </header>
                      <div className="managerSplit__body">
                        {queuePreview.length === 0 ? <p className="emptyState">Draft queue is empty.</p> : null}
                        {queuePreview.length > 0 ? (
                          <div className="dataTable">
                            {queuePreview.map((asset, index) => (
                              <article className="dataRow" key={`${asset.id}-${index}`}>
                                <div>
                                  <p className="dataRow__title">{index + 1}. {asset.title}</p>
                                  <p className="dataRow__meta">{formatDuration(asset.durationSec)}</p>
                                </div>
                                <div className="dataRow__actions">
                                  <button
                                    className="uiButton uiButton--secondary uiButton--icon"
                                    type="button"
                                    disabled={busy || index === 0}
                                    onClick={() => moveDraftItem(index, -1)}
                                    title="Move up"
                                    aria-label="Move up"
                                  >
                                    <AppIcon name="arrow-left" className="uiIcon--rotate-up" />
                                  </button>
                                  <button
                                    className="uiButton uiButton--secondary uiButton--icon"
                                    type="button"
                                    disabled={busy || index === queuePreview.length - 1}
                                    onClick={() => moveDraftItem(index, 1)}
                                    title="Move down"
                                    aria-label="Move down"
                                  >
                                    <AppIcon name="arrow-left" className="uiIcon--rotate-down" />
                                  </button>
                                  <button
                                    className="uiButton uiButton--danger uiButton--icon"
                                    type="button"
                                    disabled={busy}
                                    onClick={() => removeDraftItem(index)}
                                    title="Remove"
                                    aria-label="Remove"
                                  >
                                    <AppIcon name="trash" />
                                  </button>
                                </div>
                              </article>
                            ))}
                          </div>
                        ) : null}
                        <button className="uiButton uiButton--accent" type="button" onClick={() => void onSaveQueue()} disabled={busy}>
                          <AppIcon name="upload" />
                          Push Playlist
                        </button>
                      </div>
                    </section>
                  </div>
                </div>
              </section>
            ) : null}

            {!loading && detail && tab === "runtime" ? (
              <>
                <section className="workspaceSection">
                  <header className="workspaceSection__head">
                    <div>
                      <h2>Runtime Scheduling</h2>
                      <p>Use windows for planned broadcasts or trigger always-on mode.</p>
                    </div>
                    <div className="workspaceHead__actions">
                      <button className="uiButton uiButton--secondary" type="button" onClick={() => setScheduleModalOpen(true)}>
                        <AppIcon name="plus" />
                        Add Schedule
                      </button>
                      <button className="uiButton uiButton--accent" type="button" onClick={() => void onStartAlwaysOnNow()} disabled={busy}>
                        <AppIcon name="zap" />
                        Start 24/7 Now
                      </button>
                    </div>
                  </header>
                  <div className="workspaceSection__body">
                    <p className="emptyState">Schedules are evaluated in chronological order.</p>
                  </div>
                </section>

                <section className="workspaceSection">
                  <header className="workspaceSection__head">
                    <div>
                      <h2>Active Schedules</h2>
                      <p>Currently attached runtime windows for this station.</p>
                    </div>
                  </header>
                  <div className="workspaceSection__body">
                    {detail.schedules.length === 0 ? <p className="emptyState">No schedules yet.</p> : null}
                    {detail.schedules.length > 0 ? (
                      <div className="dataTable">
                        {[...detail.schedules]
                          .sort((left, right) => Date.parse(left.startAt) - Date.parse(right.startAt))
                          .map((schedule) => (
                            <article className="dataRow" key={schedule.id}>
                              <div>
                                <p className="dataRow__title">{formatDateTime(schedule.startAt)}</p>
                                <p className="dataRow__meta">
                                  {schedule.endAt ? `Ends ${formatDateTime(schedule.endAt)}` : "24/7 (no end)"}
                                </p>
                              </div>
                              <div className="dataRow__actions">
                                <button
                                  className="uiButton uiButton--danger"
                                  type="button"
                                  onClick={() => void onDeleteSchedule(schedule.id)}
                                  disabled={busy}
                                >
                                  <AppIcon name="trash" />
                                  Remove
                                </button>
                              </div>
                            </article>
                          ))}
                      </div>
                    ) : null}
                  </div>
                </section>
              </>
            ) : null}

            {!loading && detail && tab === "ads" ? (
              <>
                <section className="workspaceSection">
                  <header className="workspaceSection__head">
                    <div>
                      <h2>Ad Injection Rules</h2>
                      <p>Control pacing of ads, sponsors, and bumper segments.</p>
                    </div>
                  </header>
                  <div className="workspaceSection__body">
                    <label className="field">
                      <span>Trigger Mode</span>
                      <select
                        className="uiSelect"
                        value={adTriggerMode}
                        onChange={(event) => {
                          const value = event.target.value;
                          if (value === "disabled" || value === "time_interval") {
                            setAdTriggerMode(value);
                            return;
                          }
                          setAdTriggerMode("every_n_programs");
                        }}
                        disabled={busy}
                      >
                        <option value="disabled">Disabled</option>
                        <option value="every_n_programs">Every N Programs</option>
                        <option value="time_interval">Time Interval</option>
                      </select>
                    </label>

                    {adTriggerMode === "every_n_programs" ? (
                      <label className="field">
                        <span>Programs Interval</span>
                        <input
                          className="uiInput"
                          type="number"
                          min={1}
                          value={adInterval}
                          onChange={(event) => setAdInterval(Number(event.target.value || 1))}
                          disabled={busy}
                        />
                      </label>
                    ) : null}

                    {adTriggerMode === "time_interval" ? (
                      <label className="field">
                        <span>Seconds Interval</span>
                        <input
                          className="uiInput"
                          type="number"
                          min={30}
                          value={adTimeIntervalSec}
                          onChange={(event) => setAdTimeIntervalSec(Number(event.target.value || 30))}
                          disabled={busy}
                        />
                      </label>
                    ) : null}

                    <button className="uiButton uiButton--accent" type="button" onClick={() => void onSaveAdRules()} disabled={busy}>
                      <AppIcon name="chart" />
                      Save Rules
                    </button>
                  </div>
                </section>

                <section className="workspaceSection">
                  <header className="workspaceSection__head">
                    <div>
                      <h2>Station Ad Pool</h2>
                      <p>Ad assets currently linked to this station.</p>
                    </div>
                    <button className="uiButton uiButton--secondary" type="button" onClick={() => setImportAdsModalOpen(true)}>
                      <AppIcon name="upload" />
                      Import Ads
                    </button>
                  </header>
                  <div className="workspaceSection__body">
                    {stationAds.length === 0 ? <p className="emptyState">No ad assets in this station.</p> : null}
                    {stationAds.length > 0 ? (
                      <div className="dataTable">
                        {stationAds.map((asset) => (
                          <article className="dataRow" key={asset.id}>
                            <div>
                              <p className="dataRow__title">{asset.title}</p>
                              <p className="dataRow__meta">
                                {asset.insertionCategory ?? "ad"} · {formatDuration(asset.durationSec)}
                              </p>
                            </div>
                            <div className="dataRow__actions">
                              <button className="uiButton uiButton--danger" type="button" onClick={() => void onDeleteAsset(asset.id)} disabled={busy}>
                                <AppIcon name="trash" />
                                Remove
                              </button>
                            </div>
                          </article>
                        ))}
                      </div>
                    ) : null}
                  </div>
                </section>
              </>
            ) : null}
          </section>
        </section>

      <OverlayPanel
        open={profileModalOpen}
        onClose={() => setProfileModalOpen(false)}
        title="Edit Station Details"
        subtitle="Name, description, mode, logo, and banner settings."
        mode="right"
      >
        <form
          className="streamSettingsModal"
          onSubmit={(event) => {
            event.preventDefault();
            void onSaveStationProfile();
          }}
        >
          <section className="streamSettingsCard">
            <h3>Core Profile</h3>
            <label className="field">
              <span>Station Name</span>
              <input className="uiInput" value={name} onChange={(event) => setName(event.target.value)} required disabled={busy} />
            </label>
            <label className="field">
              <span>Description</span>
              <textarea className="uiTextarea" value={description} onChange={(event) => setDescription(event.target.value)} disabled={busy} />
            </label>
            <label className="field">
              <span>Stream Mode</span>
              <select
                className="uiSelect"
                value={streamMode}
                onChange={(event) => setStreamMode(event.target.value === "radio" ? "radio" : "video")}
                disabled={busy}
              >
                <option value="video">Video</option>
                <option value="radio">Radio</option>
              </select>
            </label>
          </section>

          <section className="streamSettingsCard">
            <h3>Brand Images</h3>
            <div className="stationIdentityInputs">
              <label className="field">
                <span>Logo URL</span>
                <input
                  className="uiInput"
                  value={profileImageUrlInput}
                  onChange={(event) => setProfileImageUrlInput(event.target.value)}
                  placeholder="https://... or /uploads/..."
                  disabled={busy}
                />
              </label>
              <label className="field">
                <span>Upload Logo</span>
                <input
                  className="uiFile"
                  type="file"
                  accept="image/*"
                  onChange={(event) => setProfileImageFile(event.target.files?.[0] ?? null)}
                  disabled={busy}
                />
              </label>
              <label className="field">
                <span>Banner URL</span>
                <input
                  className="uiInput"
                  value={bannerImageUrlInput}
                  onChange={(event) => setBannerImageUrlInput(event.target.value)}
                  placeholder="https://... or /uploads/..."
                  disabled={busy}
                />
              </label>
              <label className="field">
                <span>Upload Banner</span>
                <input
                  className="uiFile"
                  type="file"
                  accept="image/*"
                  onChange={(event) => setBannerImageFile(event.target.files?.[0] ?? null)}
                  disabled={busy}
                />
              </label>
            </div>

            <div className="stationIdentityPreview">
              <div
                className="stationIdentityPreview__banner"
                style={
                  bannerImagePreview
                    ? { backgroundImage: `linear-gradient(to top, var(--overlay), transparent), url(${bannerImagePreview})` }
                    : undefined
                }
              />
              <div className="stationIdentityPreview__logo">
                {profileImagePreview ? (
                  <img src={profileImagePreview} alt="Station logo preview" />
                ) : (
                  <span>{stationInitials(name)}</span>
                )}
              </div>
            </div>
          </section>

          <div className="modalActions">
            <button className="uiButton uiButton--accent" type="submit" disabled={busy || !name.trim()}>
              <AppIcon name="upload" />
              Save Station Details
            </button>
            <button className="uiButton uiButton--secondary" type="button" onClick={() => setProfileModalOpen(false)}>
              <AppIcon name="close" />
              Cancel
            </button>
          </div>
        </form>
      </OverlayPanel>

      <OverlayPanel
        open={managerSettingsModalOpen}
        onClose={() => setManagerSettingsModalOpen(false)}
        title="Public Viewer Stream Settings"
        subtitle="Click-through prototype for manager-only controls."
        mode="right"
      >
        <div className="streamSettingsModal">
          <section className="streamSettingsCard">
            <h3>Audience Access</h3>
            <p>Set how the broadcast viewer page should be exposed to the public.</p>
            <label className="field">
              <span>Viewer Access Mode</span>
              <select className="uiSelect" value={viewerMode} onChange={(event) => setViewerMode(event.target.value as ManagerViewerMode)}>
                <option value="public">Public</option>
                <option value="unlisted">Unlisted Link</option>
                <option value="token">Token Protected</option>
              </select>
            </label>
            <div className="managerToggleGrid">
              <button
                className={`managerToggle ${viewerCommentsEnabled ? "isActive" : ""}`}
                type="button"
                onClick={() => setViewerCommentsEnabled((current) => !current)}
              >
                <span>Comments</span>
                <strong>{viewerCommentsEnabled ? "Enabled" : "Disabled"}</strong>
              </button>
              <button
                className={`managerToggle ${viewerVotingEnabled ? "isActive" : ""}`}
                type="button"
                onClick={() => setViewerVotingEnabled((current) => !current)}
              >
                <span>Skip Voting</span>
                <strong>{viewerVotingEnabled ? "Enabled" : "Disabled"}</strong>
              </button>
            </div>
          </section>

          <section className="streamSettingsCard">
            <h3>Multicast Distribution</h3>
            <p>Manage outbound broadcast routes by platform. This prototype is local only.</p>

            <section className="multicastOverview">
              <article>
                <h4>Active</h4>
                <p>
                  {managerActiveMulticast.length} / {managerMulticastDestinations.length}
                </p>
              </article>
              <article>
                <h4>Live</h4>
                <p>{managerLiveMulticast.length}</p>
              </article>
              <article>
                <h4>Concurrent Viewers</h4>
                <p>{managerTotalMulticastViewers}</p>
              </article>
            </section>

            <section className="multicastStack">
              {managerMulticastDestinations.map((destination) => (
                <article className="multicastCard" key={`manager-modal-${destination.id}`}>
                  <div className="multicastCard__head">
                    <div className="multicastRow__identity">
                      <span className={`multicastWordmark multicastWordmark--${destination.id}`}>{destination.wordmark}</span>
                      <div className="multicastMeta">
                        <p className="multicastMeta__name">{destination.name}</p>
                        <p className="multicastMeta__handle">{destination.handle}</p>
                      </div>
                    </div>
                    <span
                      className={`statusPill ${
                        destination.status === "live"
                          ? "statusPill--live"
                          : destination.active
                            ? ""
                            : "statusPill--off"
                      }`}
                    >
                      {managerMulticastStatusLabel(destination)}
                    </span>
                  </div>
                  <div className="multicastCard__meta">
                    <p>
                      Region <strong>{destination.region}</strong>
                    </p>
                    <p>
                      Viewers <strong>{destination.active ? destination.viewers : 0}</strong>
                    </p>
                  </div>
                  <div className="multicastCard__actions">
                    <button
                      className="uiButton uiButton--secondary uiButton--compact"
                      type="button"
                      onClick={() => toggleManagerMulticastDestination(destination.id)}
                    >
                      <AppIcon name={destination.active ? "stop" : "plus"} />
                      {destination.active ? "Disable Route" : "Enable Route"}
                    </button>
                    <button
                      className="uiButton uiButton--ghost uiButton--compact"
                      type="button"
                      onClick={() => cycleManagerMulticastState(destination.id)}
                      disabled={!destination.active}
                    >
                      <AppIcon name={destination.status === "live" ? "refresh" : "zap"} />
                      {destination.status === "live" ? "Move To Standby" : "Mark Live"}
                    </button>
                  </div>
                </article>
              ))}
            </section>
          </section>

          <div className="modalActions">
            <button className="uiButton uiButton--accent" type="button" onClick={() => setManagerSettingsModalOpen(false)}>
              <AppIcon name="zap" />
              Save Prototype Settings
            </button>
            <button className="uiButton uiButton--secondary" type="button" onClick={() => setManagerSettingsModalOpen(false)}>
              <AppIcon name="close" />
              Close
            </button>
          </div>
        </div>
      </OverlayPanel>

      <OverlayPanel
        open={scheduleModalOpen}
        onClose={() => setScheduleModalOpen(false)}
        title="Create Runtime Schedule"
        subtitle="Define broadcast start and optional stop windows."
        mode="center"
      >
        <form className="fieldGrid" onSubmit={(event) => void onCreateSchedule(event)}>
          <label className="field">
            <span>Start Time</span>
            <input
              className="uiInput"
              type="datetime-local"
              value={scheduleStart}
              onChange={(event) => setScheduleStart(event.target.value)}
              required
              disabled={busy}
            />
          </label>
          <label className="field">
            <span>End Time (Optional)</span>
            <input
              className="uiInput"
              type="datetime-local"
              value={scheduleEnd}
              onChange={(event) => setScheduleEnd(event.target.value)}
              disabled={busy}
            />
          </label>
          <div className="modalActions">
            <button className="uiButton uiButton--accent" type="submit" disabled={busy || !scheduleStart}>
              <AppIcon name="plus" />
              Create Schedule
            </button>
            <button className="uiButton uiButton--secondary" type="button" onClick={() => setScheduleModalOpen(false)}>
              <AppIcon name="close" />
              Cancel
            </button>
          </div>
        </form>
      </OverlayPanel>

      <OverlayPanel
        open={importProgramsModalOpen}
        onClose={() => setImportProgramsModalOpen(false)}
        title="Import Programs"
        subtitle="Select from your wallet library and add to station inventory."
        mode="center"
      >
        <div className="fieldGrid">
          <p className="metaLine">Select programs from your global library and import into this station.</p>
          {globalProgramLibrary.length === 0 ? <p className="emptyState">No global programs available.</p> : null}
          {globalProgramLibrary.length > 0 ? (
            <div className="checkTable">
              {globalProgramLibrary.map((asset) => {
                const checked = selectedLibraryPrograms.includes(asset.id);
                return (
                  <label className="checkRow" key={asset.id}>
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={(event) => toggleLibraryProgram(asset.id, event.target.checked)}
                      disabled={busy}
                    />
                    <span className="checkRow__label">{asset.title}</span>
                    <span className="checkRow__meta">{formatDuration(asset.durationSec)}</span>
                  </label>
                );
              })}
            </div>
          ) : null}
          <div className="modalActions">
            <button
              className="uiButton uiButton--accent"
              type="button"
              onClick={() => void onImportLibraryAssets(selectedLibraryPrograms)}
              disabled={busy || selectedLibraryPrograms.length === 0 || !ownerWallet}
            >
              <AppIcon name="upload" />
              Import Selected Programs
            </button>
            <button className="uiButton uiButton--secondary" type="button" onClick={() => setImportProgramsModalOpen(false)}>
              <AppIcon name="close" />
              Cancel
            </button>
          </div>
        </div>
      </OverlayPanel>

      <OverlayPanel
        open={importAdsModalOpen}
        onClose={() => setImportAdsModalOpen(false)}
        title="Import Ads / Sponsors"
        subtitle="Select ad assets from your global library for this station."
        mode="center"
      >
        <div className="fieldGrid">
          <p className="metaLine">Select ad assets from your global library and import into this station.</p>
          {loadingLibrary ? <p className="loadingState">Refreshing library...</p> : null}
          {globalAdLibrary.length === 0 ? <p className="emptyState">No global ads/sponsors/bumpers available.</p> : null}
          {globalAdLibrary.length > 0 ? (
            <div className="checkTable">
              {globalAdLibrary.map((asset) => {
                const checked = selectedLibraryAds.includes(asset.id);
                return (
                  <label className="checkRow" key={asset.id}>
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={(event) => toggleLibraryAd(asset.id, event.target.checked)}
                      disabled={busy}
                    />
                    <span className="checkRow__label">{asset.title}</span>
                    <span className="checkRow__meta">{asset.insertionCategory ?? "ad"}</span>
                  </label>
                );
              })}
            </div>
          ) : null}
          <div className="modalActions">
            <button
              className="uiButton uiButton--accent"
              type="button"
              onClick={() => void onImportLibraryAssets(selectedLibraryAds)}
              disabled={busy || selectedLibraryAds.length === 0 || !ownerWallet}
            >
              <AppIcon name="upload" />
              Import Selected Ads
            </button>
            <button className="uiButton uiButton--secondary" type="button" onClick={() => setImportAdsModalOpen(false)}>
              <AppIcon name="close" />
              Cancel
            </button>
          </div>
        </div>
      </OverlayPanel>
    </main>
  );
}
