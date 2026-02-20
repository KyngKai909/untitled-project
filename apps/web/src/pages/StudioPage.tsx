import { FormEvent, useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  cancelExternalIngestJob,
  createStreamSchedule,
  createFolder,
  createDestination,
  deleteAsset,
  deleteDestination,
  deleteExternalIngestJob,
  deleteFolder,
  deleteStreamSchedule,
  getApiBase,
  getChannelDetail,
  getChannelStatus,
  listExternalIngestJobs,
  listStreamSchedules,
  patchExternalIngestJobItem,
  patchAsset,
  patchChannel,
  patchDestination,
  patchFolder,
  patchStreamSchedule,
  provisionLivepeer,
  putPlaylist,
  queueExternalIngestJob,
  sendChannelControl,
  setLivepeerEnabled,
  uploadRadioBackground,
  uploadAsset
} from "../api";
import { buildBroadcastSchedule, deriveCreatorProfile, formatClockTime, formatDuration } from "../presentation";
import type {
  AdTriggerMode,
  AssetFolder,
  AssetType,
  ChannelDetail,
  ExternalIngestJob,
  ExternalIngestItemStatus,
  PlaylistItem,
  StreamMode,
  StreamSchedule
} from "../types";

type AssetFilter = "all" | "programs" | "ads" | "uploads" | "external" | "audio" | "video";
type SkipPhase = "switching" | "propagating";
type StudioTab = "background" | "content" | "lineup" | "destinations" | "activity";

const SKIP_SWITCH_TIMEOUT_MS = 12_000;
const LIVEPEER_PROPAGATION_MS = 18_000;

function parseExternalLinksInput(raw: string): string[] {
  return [...new Set(raw.split(/\r?\n|,/).map((value) => value.trim()).filter(Boolean))];
}

function ingestJobStatusLabel(status: ExternalIngestJob["status"]): string {
  if (status === "expanding") return "Expanding playlist links";
  if (status === "running") return "Importing media";
  if (status === "completed") return "Completed";
  if (status === "partial") return "Completed with some failures";
  if (status === "failed") return "Failed";
  if (status === "canceled") return "Canceled";
  return "Queued";
}

function ingestItemStatusLabel(status: ExternalIngestItemStatus): string {
  if (status === "downloading") return "Downloading";
  if (status === "processing") return "Processing";
  if (status === "uploading_ipfs") return "Pinning to IPFS";
  if (status === "completed") return "Completed";
  if (status === "failed") return "Failed";
  if (status === "canceled") return "Canceled";
  return "Queued";
}

function flattenFolders(
  folders: AssetFolder[],
  parentFolderId: string | undefined = undefined,
  depth = 0
): Array<AssetFolder & { depth: number }> {
  const children = folders
    .filter((folder) => folder.parentFolderId === parentFolderId)
    .sort((a, b) => a.name.localeCompare(b.name));

  const result: Array<AssetFolder & { depth: number }> = [];
  for (const child of children) {
    result.push({ ...child, depth });
    result.push(...flattenFolders(folders, child.id, depth + 1));
  }
  return result;
}

function collectFolderAndDescendants(folders: AssetFolder[], folderId: string): Set<string> {
  const selected = new Set<string>();
  const queue = [folderId];
  while (queue.length) {
    const current = queue.shift()!;
    if (selected.has(current)) {
      continue;
    }
    selected.add(current);
    for (const folder of folders) {
      if (folder.parentFolderId === current) {
        queue.push(folder.id);
      }
    }
  }
  return selected;
}

function parseLocalDateTimeInput(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) {
    return undefined;
  }
  return parsed.toISOString();
}

function formatDateTime(iso: string | undefined): string {
  if (!iso) {
    return "Not set";
  }
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) {
    return "Invalid date";
  }
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit"
  }).format(parsed);
}

function scheduleStatusLabel(schedule: StreamSchedule, nowMs: number): string {
  if (!schedule.enabled) {
    return "Disabled";
  }

  if (schedule.endedAt) {
    return "Completed";
  }

  const startMs = Date.parse(schedule.startAt);
  const endMs = schedule.endAt ? Date.parse(schedule.endAt) : undefined;

  if (!Number.isNaN(startMs) && nowMs < startMs) {
    return "Scheduled";
  }

  if (endMs !== undefined && !Number.isNaN(endMs) && nowMs >= endMs) {
    return "Completed";
  }

  if (schedule.startedAt && !schedule.endedAt) {
    return "Running";
  }

  return "Scheduled";
}

function splitInterval(totalSec: number) {
  const safe = Math.max(0, Math.floor(totalSec || 0));
  return {
    hours: Math.floor(safe / 3600),
    minutes: Math.floor((safe % 3600) / 60),
    seconds: safe % 60
  };
}

export default function StudioPage() {
  const { channelId } = useParams();

  const [detail, setDetail] = useState<ChannelDetail | null>(null);
  const [playlistDraft, setPlaylistDraft] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [channelName, setChannelName] = useState("");
  const [channelDescription, setChannelDescription] = useState("");
  const [adInterval, setAdInterval] = useState(2);
  const [adTriggerMode, setAdTriggerMode] = useState<AdTriggerMode>("every_n_programs");
  const [adIntervalHours, setAdIntervalHours] = useState(0);
  const [adIntervalMinutes, setAdIntervalMinutes] = useState(10);
  const [adIntervalSeconds, setAdIntervalSeconds] = useState(0);
  const [streamMode, setStreamMode] = useState<StreamMode>("video");
  const [brandColor, setBrandColor] = useState("#0a7c86");
  const [playerLabel, setPlayerLabel] = useState("");
  const [radioBackgroundFile, setRadioBackgroundFile] = useState<File | null>(null);

  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploadTitle, setUploadTitle] = useState("");
  const [uploadType, setUploadType] = useState<AssetType>("program");
  const [activeTab, setActiveTab] = useState<StudioTab>("background");

  const [singleExternalUrl, setSingleExternalUrl] = useState("");
  const [singleExternalTitle, setSingleExternalTitle] = useState("");
  const [singleExternalType, setSingleExternalType] = useState<AssetType>("program");
  const [playlistUrlsText, setPlaylistUrlsText] = useState("");
  const [playlistTitlePrefix, setPlaylistTitlePrefix] = useState("");
  const [playlistExternalType, setPlaylistExternalType] = useState<AssetType>("program");
  const [expandPlaylistLinks, setExpandPlaylistLinks] = useState(true);
  const [ingestJobs, setIngestJobs] = useState<ExternalIngestJob[]>([]);
  const [ingestTitleDrafts, setIngestTitleDrafts] = useState<Record<string, string>>({});

  const [destinationName, setDestinationName] = useState("");
  const [destinationUrl, setDestinationUrl] = useState("");
  const [destinationKey, setDestinationKey] = useState("");
  const [scheduleStartAt, setScheduleStartAt] = useState("");
  const [scheduleEndAt, setScheduleEndAt] = useState("");
  const [schedule24x7, setSchedule24x7] = useState(false);

  const [assetFilter, setAssetFilter] = useState<AssetFilter>("all");
  const [assetSearch, setAssetSearch] = useState("");
  const [assetSort, setAssetSort] = useState<
    "newest" | "oldest" | "title_asc" | "title_desc" | "duration_asc" | "duration_desc"
  >("newest");
  const [selectedFolderId, setSelectedFolderId] = useState<string>("all");
  const [newFolderName, setNewFolderName] = useState("");
  const [newFolderParentId, setNewFolderParentId] = useState<string>("");
  const [renameFolderName, setRenameFolderName] = useState("");
  const [moveFolderParentId, setMoveFolderParentId] = useState<string>("");
  const [skipFeedback, setSkipFeedback] = useState<{
    phase: SkipPhase;
    requestedAtMs: number;
    sourceAssetId?: string;
  } | null>(null);

  async function refresh() {
    if (!channelId) {
      return;
    }

    try {
      const [data, jobs] = await Promise.all([getChannelDetail(channelId), listExternalIngestJobs(channelId, 25)]);
      setDetail(data);
      setPlaylistDraft(data.playlist.map((item) => item.assetId));
      setChannelName(data.channel.name);
      setChannelDescription(data.channel.description || "");
      setAdInterval(data.channel.adInterval);
      setAdTriggerMode(data.channel.adTriggerMode ?? "every_n_programs");
      const intervalParts = splitInterval(data.channel.adTimeIntervalSec ?? 10 * 60);
      setAdIntervalHours(intervalParts.hours);
      setAdIntervalMinutes(intervalParts.minutes);
      setAdIntervalSeconds(intervalParts.seconds);
      setStreamMode(data.channel.streamMode ?? "video");
      setBrandColor(data.channel.brandColor || "#0a7c86");
      setPlayerLabel(data.channel.playerLabel || data.channel.name);
      setIngestJobs(jobs);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load station manager");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    setLoading(true);
    refresh();
  }, [channelId]);

  useEffect(() => {
    if (!channelId) {
      return;
    }

    const interval = setInterval(async () => {
      try {
        const [status, jobs, schedules] = await Promise.all([
          getChannelStatus(channelId),
          listExternalIngestJobs(channelId, 25),
          listStreamSchedules(channelId)
        ]);
        setDetail((current) => {
          if (!current) {
            return current;
          }

          return {
            ...current,
            state: status.state,
            livepeer: status.livepeer ?? current.livepeer,
            streamUrl: status.streamUrl,
            schedules
          };
        });
        setIngestJobs(jobs);
      } catch {
        // Keep last known state on polling issues.
      }
    }, 2000);

    return () => clearInterval(interval);
  }, [channelId]);

  const assetsById = useMemo(() => {
    const map = new Map<string, ChannelDetail["assets"][number]>();
    detail?.assets.forEach((asset) => map.set(asset.id, asset));
    return map;
  }, [detail]);

  const creator = detail ? deriveCreatorProfile(detail.channel) : null;
  const folders = detail?.folders ?? [];
  const streamSchedules = useMemo(
    () => [...(detail?.schedules ?? [])].sort((a, b) => Date.parse(a.startAt) - Date.parse(b.startAt)),
    [detail?.schedules]
  );
  const flattenedFolders = useMemo(() => flattenFolders(folders), [folders]);
  const folderNameById = useMemo(() => new Map(folders.map((folder) => [folder.id, folder.name])), [folders]);

  const selectedFolderSet = useMemo(() => {
    if (!detail || selectedFolderId === "all" || selectedFolderId === "ungrouped") {
      return undefined;
    }

    if (!folders.some((folder) => folder.id === selectedFolderId)) {
      return undefined;
    }

    return collectFolderAndDescendants(folders, selectedFolderId);
  }, [detail, folders, selectedFolderId]);

  useEffect(() => {
    const selected = folders.find((folder) => folder.id === selectedFolderId);
    if (!selected) {
      setRenameFolderName("");
      setMoveFolderParentId("");
      return;
    }
    setRenameFolderName(selected.name);
    setMoveFolderParentId(selected.parentFolderId ?? "");
  }, [folders, selectedFolderId]);

  const filteredAssets = useMemo(() => {
    if (!detail) {
      return [];
    }

    let list = [...detail.assets];

    list = list.filter((asset) => {
      if (assetFilter === "programs") {
        return asset.type === "program";
      }
      if (assetFilter === "ads") {
        return asset.type === "ad";
      }
      if (assetFilter === "uploads") {
        return asset.sourceType === "upload";
      }
      if (assetFilter === "external") {
        return asset.sourceType === "external";
      }
      if (assetFilter === "audio") {
        return asset.mediaKind === "audio";
      }
      if (assetFilter === "video") {
        return asset.mediaKind === "video";
      }
      return true;
    });

    if (selectedFolderId === "ungrouped") {
      list = list.filter((asset) => !asset.folderId);
    } else if (selectedFolderSet) {
      list = list.filter((asset) => asset.folderId && selectedFolderSet.has(asset.folderId));
    }

    const query = assetSearch.trim().toLowerCase();
    if (query) {
      list = list.filter((asset) => {
        const haystack = `${asset.title} ${asset.sourceUrl ?? ""}`.toLowerCase();
        return haystack.includes(query);
      });
    }

    list.sort((left, right) => {
      if (assetSort === "oldest") return left.createdAt.localeCompare(right.createdAt);
      if (assetSort === "title_asc") return left.title.localeCompare(right.title);
      if (assetSort === "title_desc") return right.title.localeCompare(left.title);
      if (assetSort === "duration_asc") return (left.durationSec ?? 0) - (right.durationSec ?? 0);
      if (assetSort === "duration_desc") return (right.durationSec ?? 0) - (left.durationSec ?? 0);
      return right.createdAt.localeCompare(left.createdAt);
    });

    return list;
  }, [assetFilter, assetSearch, assetSort, detail, selectedFolderId, selectedFolderSet]);

  const previewPlaylist = useMemo<PlaylistItem[]>(() => {
    if (!detail) {
      return [];
    }

    return playlistDraft
      .map((assetId, position) => {
        const asset = assetsById.get(assetId);
        if (!asset) {
          return null;
        }

        return {
          id: `draft-${assetId}-${position}`,
          channelId: detail.channel.id,
          assetId,
          position,
          createdAt: detail.channel.updatedAt,
          asset
        };
      })
      .filter((item): item is PlaylistItem => Boolean(item));
  }, [assetsById, detail, playlistDraft]);

  const liveSchedule = useMemo(() => {
    if (!detail || !detail.playlist.length) {
      return [];
    }

    return buildBroadcastSchedule({
      playlist: detail.playlist,
      queueIndex: detail.state.queueIndex,
      limit: 8
    });
  }, [detail]);

  const nextScheduledStart = useMemo(() => {
    const nowMs = Date.now();
    return streamSchedules.find((schedule) => {
      if (!schedule.enabled || schedule.endedAt || schedule.startedAt) {
        return false;
      }
      const startMs = Date.parse(schedule.startAt);
      return !Number.isNaN(startMs) && startMs > nowMs;
    });
  }, [streamSchedules]);

  const scheduleBasis = useMemo(() => {
    if (detail?.state.isRunning) {
      return "Live schedule based on current on-air queue.";
    }
    if (nextScheduledStart) {
      return `Preview from next scheduled start (${formatDateTime(nextScheduledStart.startAt)}) and lineup position 1.`;
    }
    return "Preview if started now from lineup position 1.";
  }, [detail?.state.isRunning, nextScheduledStart]);

  const previewSchedule = useMemo(() => {
    if (!detail || !previewPlaylist.length) {
      return [];
    }

    return buildBroadcastSchedule({
      playlist: previewPlaylist,
      queueIndex: 0,
      limit: 8,
      startsAt: nextScheduledStart?.startAt
    });
  }, [detail, nextScheduledStart, previewPlaylist]);

  const scheduleRows = detail?.state.isRunning ? liveSchedule : previewSchedule;
  const showPreviewTag = !detail?.state.isRunning;

  const activeIngestJobs = useMemo(
    () => ingestJobs.filter((job) => job.status === "queued" || job.status === "expanding" || job.status === "running"),
    [ingestJobs]
  );
  const selectedFolder = useMemo(
    () => folders.find((folder) => folder.id === selectedFolderId),
    [folders, selectedFolderId]
  );
  const radioBackgroundPreviewUrl = useMemo(() => {
    const raw = detail?.channel.radioBackgroundUrl;
    if (!raw) {
      return undefined;
    }
    if (/^https?:\/\//i.test(raw)) {
      return raw;
    }
    return `${getApiBase()}${raw}`;
  }, [detail?.channel.radioBackgroundUrl]);
  const blockedMoveParentIds = useMemo(
    () => (selectedFolder ? collectFolderAndDescendants(folders, selectedFolder.id) : new Set<string>()),
    [folders, selectedFolder]
  );

  useEffect(() => {
    if (!skipFeedback || !detail) {
      return;
    }

    if (skipFeedback.phase === "switching") {
      if (
        skipFeedback.sourceAssetId &&
        detail.state.currentAssetId &&
        detail.state.currentAssetId !== skipFeedback.sourceAssetId
      ) {
        if (detail.livepeer?.enabled && detail.livepeer.playbackUrl) {
          setSkipFeedback({
            phase: "propagating",
            requestedAtMs: Date.now()
          });
          return;
        }

        setSkipFeedback(null);
      }
      return;
    }

    const propagationAge = Date.now() - skipFeedback.requestedAtMs;
    if (propagationAge >= LIVEPEER_PROPAGATION_MS) {
      setSkipFeedback(null);
    }
  }, [detail, skipFeedback]);

  useEffect(() => {
    if (!skipFeedback) {
      return;
    }

    const ttl = skipFeedback.phase === "switching" ? SKIP_SWITCH_TIMEOUT_MS : LIVEPEER_PROPAGATION_MS;
    const timeout = setTimeout(() => setSkipFeedback(null), ttl);
    return () => clearTimeout(timeout);
  }, [skipFeedback]);

  const skipStatusMessage = useMemo(() => {
    if (!skipFeedback) {
      return null;
    }

    if (skipFeedback.phase === "switching") {
      return "Skip requested. Switching to the next program source...";
    }

    const remainingSec = Math.max(
      0,
      Math.ceil((LIVEPEER_PROPAGATION_MS - (Date.now() - skipFeedback.requestedAtMs)) / 1000)
    );
    return `Program source switched. Public playback is catching up (${remainingSec}s est).`;
  }, [skipFeedback, detail?.state.updatedAt]);

  async function handleControl(action: "start" | "stop" | "skip") {
    if (!channelId) {
      return;
    }

    if (action === "skip") {
      setSkipFeedback({
        phase: "switching",
        requestedAtMs: Date.now(),
        sourceAssetId: detail?.state.currentAssetId
      });
    } else {
      setSkipFeedback(null);
    }

    setBusy(true);
    try {
      await sendChannelControl(channelId, action);
      await refresh();
    } catch (err) {
      if (action === "skip") {
        setSkipFeedback(null);
      }
      setError(err instanceof Error ? err.message : "Control action failed");
    } finally {
      setBusy(false);
    }
  }

  async function saveSettings(event: FormEvent) {
    event.preventDefault();
    if (!channelId) {
      return;
    }

    const adTimeIntervalSec = Math.max(
      30,
      Math.floor(Number(adIntervalHours) || 0) * 3600 +
        Math.floor(Number(adIntervalMinutes) || 0) * 60 +
        Math.floor(Number(adIntervalSeconds) || 0)
    );

    setBusy(true);
    try {
      await patchChannel(channelId, {
        name: channelName.trim(),
        description: channelDescription.trim(),
        adInterval: Math.max(0, Math.floor(Number(adInterval) || 0)),
        adTriggerMode,
        adTimeIntervalSec,
        streamMode,
        brandColor: brandColor.trim(),
        playerLabel: playerLabel.trim()
      });
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save station settings");
    } finally {
      setBusy(false);
    }
  }

  async function submitUpload(event: FormEvent) {
    event.preventDefault();
    if (!channelId || !uploadFile) {
      return;
    }

    setBusy(true);
    try {
      await uploadAsset(channelId, {
        file: uploadFile,
        title: uploadTitle,
        type: uploadType
      });
      setUploadFile(null);
      setUploadTitle("");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setBusy(false);
    }
  }

  async function submitRadioBackground(event?: FormEvent) {
    event?.preventDefault();
    if (!channelId || !radioBackgroundFile) {
      return;
    }

    setBusy(true);
    try {
      await uploadRadioBackground(channelId, radioBackgroundFile);
      setRadioBackgroundFile(null);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Background upload failed");
    } finally {
      setBusy(false);
    }
  }

  async function clearRadioBackground() {
    if (!channelId) {
      return;
    }

    setBusy(true);
    try {
      await patchChannel(channelId, { radioBackgroundUrl: null });
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to clear background");
    } finally {
      setBusy(false);
    }
  }

  async function queueExternalLinks(input: {
    urls: string[];
    titlePrefix?: string;
    type: AssetType;
    expandPlaylists: boolean;
    successReset: () => void;
  }) {
    if (!channelId) {
      return;
    }

    if (!input.urls.length) {
      setError("Add at least one external URL to import.");
      return;
    }

    setBusy(true);
    try {
      await queueExternalIngestJob(channelId, {
        urls: input.urls,
        titlePrefix: input.titlePrefix?.trim() || undefined,
        type: input.type,
        expandPlaylists: input.expandPlaylists
      });
      input.successReset();
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "External import queue failed");
    } finally {
      setBusy(false);
    }
  }

  async function submitSingleExternal(event: FormEvent) {
    event.preventDefault();
    await queueExternalLinks({
      urls: parseExternalLinksInput(singleExternalUrl),
      titlePrefix: singleExternalTitle,
      type: singleExternalType,
      expandPlaylists: false,
      successReset: () => {
        setSingleExternalUrl("");
        setSingleExternalTitle("");
      }
    });
  }

  async function submitPlaylistExternal(event: FormEvent) {
    event.preventDefault();
    await queueExternalLinks({
      urls: parseExternalLinksInput(playlistUrlsText),
      titlePrefix: playlistTitlePrefix,
      type: playlistExternalType,
      expandPlaylists: expandPlaylistLinks,
      successReset: () => {
        setPlaylistUrlsText("");
        setPlaylistTitlePrefix("");
      }
    });
  }

  async function submitDestination(event: FormEvent) {
    event.preventDefault();
    if (!channelId || !destinationName.trim() || !destinationUrl.trim() || !destinationKey.trim()) {
      return;
    }

    setBusy(true);
    try {
      await createDestination(channelId, {
        name: destinationName.trim(),
        rtmpUrl: destinationUrl.trim(),
        streamKey: destinationKey.trim()
      });
      setDestinationName("");
      setDestinationUrl("");
      setDestinationKey("");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add destination");
    } finally {
      setBusy(false);
    }
  }

  async function toggleDestination(destinationId: string, enabled: boolean) {
    setBusy(true);
    try {
      await patchDestination(destinationId, { enabled: !enabled });
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update destination");
    } finally {
      setBusy(false);
    }
  }

  async function removeDestination(destinationId: string) {
    setBusy(true);
    try {
      await deleteDestination(destinationId);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to remove destination");
    } finally {
      setBusy(false);
    }
  }

  async function handleProvisionLivepeer() {
    if (!channelId) {
      return;
    }

    setBusy(true);
    try {
      await provisionLivepeer(channelId);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Livepeer provisioning failed");
    } finally {
      setBusy(false);
    }
  }

  async function toggleLivepeerEnabled() {
    if (!channelId) {
      return;
    }

    setBusy(true);
    try {
      await setLivepeerEnabled(channelId, !(detail?.livepeer?.enabled ?? false));
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update Livepeer state");
    } finally {
      setBusy(false);
    }
  }

  async function saveIngestItemTitle(jobId: string, itemId: string, fallbackTitle: string | undefined) {
    if (!channelId) {
      return;
    }

    const key = `${jobId}:${itemId}`;
    const draft = (ingestTitleDrafts[key] ?? fallbackTitle ?? "").trim();

    setBusy(true);
    try {
      await patchExternalIngestJobItem(channelId, jobId, itemId, {
        title: draft || undefined
      });
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update ingest item title");
    } finally {
      setBusy(false);
    }
  }

  async function cancelIngestJob(jobId: string) {
    if (!channelId) {
      return;
    }

    setBusy(true);
    try {
      await cancelExternalIngestJob(channelId, jobId);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to cancel external import");
    } finally {
      setBusy(false);
    }
  }

  async function removeIngestJob(jobId: string) {
    if (!channelId) {
      return;
    }

    setBusy(true);
    try {
      await deleteExternalIngestJob(channelId, jobId);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete external import job");
    } finally {
      setBusy(false);
    }
  }

  async function createNewFolder(event: FormEvent) {
    event.preventDefault();
    if (!channelId || !newFolderName.trim()) {
      return;
    }

    setBusy(true);
    try {
      await createFolder(channelId, {
        name: newFolderName.trim(),
        parentFolderId: newFolderParentId || null
      });
      setNewFolderName("");
      setNewFolderParentId("");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create folder");
    } finally {
      setBusy(false);
    }
  }

  async function saveSelectedFolderMeta(event: FormEvent) {
    event.preventDefault();
    if (!selectedFolder) {
      return;
    }

    setBusy(true);
    try {
      await patchFolder(selectedFolder.id, {
        name: renameFolderName.trim() || selectedFolder.name,
        parentFolderId: moveFolderParentId || null
      });
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update folder");
    } finally {
      setBusy(false);
    }
  }

  async function removeSelectedFolder() {
    if (!selectedFolder) {
      return;
    }

    setBusy(true);
    try {
      await deleteFolder(selectedFolder.id);
      setSelectedFolderId("all");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete folder");
    } finally {
      setBusy(false);
    }
  }

  async function submitSchedule(event: FormEvent) {
    event.preventDefault();
    if (!channelId) {
      return;
    }

    const startAt = parseLocalDateTimeInput(scheduleStartAt);
    const endAt = schedule24x7 ? undefined : parseLocalDateTimeInput(scheduleEndAt);
    if (!startAt) {
      setError("Pick a valid schedule start date/time.");
      return;
    }
    if (!schedule24x7 && scheduleEndAt.trim() && !endAt) {
      setError("Pick a valid schedule end date/time.");
      return;
    }
    if (endAt && Date.parse(endAt) <= Date.parse(startAt)) {
      setError("Schedule end time must be later than start time.");
      return;
    }

    setBusy(true);
    try {
      await createStreamSchedule(channelId, {
        startAt,
        endAt,
        enabled: true
      });
      setScheduleStartAt("");
      setScheduleEndAt("");
      setSchedule24x7(false);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create schedule");
    } finally {
      setBusy(false);
    }
  }

  async function toggleScheduleEnabled(scheduleId: string, enabled: boolean) {
    setBusy(true);
    try {
      await patchStreamSchedule(scheduleId, { enabled: !enabled });
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update schedule");
    } finally {
      setBusy(false);
    }
  }

  async function removeSchedule(scheduleId: string) {
    setBusy(true);
    try {
      await deleteStreamSchedule(scheduleId);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete schedule");
    } finally {
      setBusy(false);
    }
  }

  async function setAssetType(assetId: string, type: AssetType) {
    setBusy(true);
    try {
      await patchAsset(assetId, { type });
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update asset");
    } finally {
      setBusy(false);
    }
  }

  async function setAssetFolder(assetId: string, folderId: string | null) {
    setBusy(true);
    try {
      await patchAsset(assetId, {
        folderId
      });
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update asset folder");
    } finally {
      setBusy(false);
    }
  }

  async function removeAsset(assetId: string) {
    setBusy(true);
    try {
      await deleteAsset(assetId);
      setPlaylistDraft((current) => current.filter((id) => id !== assetId));
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete asset");
    } finally {
      setBusy(false);
    }
  }

  function addToPlaylist(assetId: string) {
    setPlaylistDraft((current) => [...current, assetId]);
  }

  function movePlaylistItem(index: number, direction: -1 | 1) {
    setPlaylistDraft((current) => {
      const target = index + direction;
      if (target < 0 || target >= current.length) {
        return current;
      }

      const next = [...current];
      const [picked] = next.splice(index, 1);
      next.splice(target, 0, picked);
      return next;
    });
  }

  function removePlaylistItem(index: number) {
    setPlaylistDraft((current) => current.filter((_, itemIndex) => itemIndex !== index));
  }

  async function savePlaylist() {
    if (!channelId) {
      return;
    }

    setBusy(true);
    try {
      await putPlaylist(channelId, playlistDraft);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save lineup");
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return (
      <main className="page">
        <section className="panel">
          <p className="mutedText">Loading station manager...</p>
        </section>
      </main>
    );
  }

  if (error && !detail) {
    return (
      <main className="page">
        <section className="panel">
          <p className="error">{error}</p>
          <Link className="btn secondary" to="/studio">
            Back to Dashboard
          </Link>
        </section>
      </main>
    );
  }

  if (!detail) {
    return (
      <main className="page">
        <section className="panel">
          <p className="error">Station not found.</p>
        </section>
      </main>
    );
  }

  return (
    <main className="page studioRoom">
      <section className="studioControlTop">
        <div className="studioControlTopLeft">
          <p className="eyebrow">Station Manager</p>
          <h1>{detail.channel.name}</h1>
          <p>{detail.channel.description || "No description set yet."}</p>
        </div>
        <div className="studioControlTopRight">
          <span className={detail.state.isRunning ? "statusPill live" : "statusPill offline"}>
            {detail.state.isRunning ? "LIVE" : "Stopped"}
          </span>
          <span className="metaBadge">{creator?.displayName}</span>
          <span className="metaBadge">{detail.assets.length} assets</span>
          <span className="metaBadge">{detail.destinations.length} destinations</span>
          <button type="button" className="btn ghost" onClick={() => refresh()} disabled={busy}>
            Reload
          </button>
          <Link className="btn secondary" to={`/station/${detail.channel.id}`}>
            Open Station
          </Link>
          <Link className="btn ghost" to="/studio">
            Dashboard
          </Link>
        </div>
      </section>

      <section className="studioTabBar" role="tablist" aria-label="Studio sections">
        <button
          type="button"
          className={activeTab === "background" ? "studioTab active" : "studioTab"}
          onClick={() => setActiveTab("background")}
        >
          Background
        </button>
        <button
          type="button"
          className={activeTab === "content" ? "studioTab active" : "studioTab"}
          onClick={() => setActiveTab("content")}
        >
          Content
        </button>
        <button
          type="button"
          className={activeTab === "lineup" ? "studioTab active" : "studioTab"}
          onClick={() => setActiveTab("lineup")}
        >
          Lineup
        </button>
        <button
          type="button"
          className={activeTab === "destinations" ? "studioTab active" : "studioTab"}
          onClick={() => setActiveTab("destinations")}
        >
          Live Output
        </button>
        <button
          type="button"
          className={activeTab === "activity" ? "studioTab active" : "studioTab"}
          onClick={() => setActiveTab("activity")}
        >
          Activity
        </button>
      </section>

      {error ? <p className="error">{error}</p> : null}

      {activeTab === "background" ? (
        <section className="studioDashboardGrid">
        <article className="panel">
          <div className="panelHead">
            <h2>Broadcast Controls</h2>
            <button type="button" className="btn ghost" onClick={() => refresh()} disabled={busy}>
              Reload
            </button>
          </div>

          <div className="statusGrid">
            <article className="statusCard">
              <h3>Status</h3>
              <p>{detail.state.isRunning ? "Broadcasting" : "Off-air"}</p>
            </article>
            <article className="statusCard">
              <h3>Now Playing</h3>
              <p>{detail.state.currentAssetTitle ?? "Idle"}</p>
            </article>
            <article className="statusCard">
              <h3>Queue Position</h3>
              <p>{detail.playlist.length ? detail.state.queueIndex + 1 : 0}</p>
            </article>
          </div>

          <div className="cardActions">
            <button type="button" className="btn" disabled={busy} onClick={() => handleControl("start")}>
              Go Live
            </button>
            <button type="button" className="btn secondary" disabled={busy} onClick={() => handleControl("stop")}>
              Stop
            </button>
            <button type="button" className="btn ghost" disabled={busy} onClick={() => handleControl("skip")}>
              Skip Current
            </button>
          </div>

          {skipStatusMessage ? <p className="mutedText">{skipStatusMessage}</p> : null}
          {detail.state.lastError ? <p className="error">Worker: {detail.state.lastError}</p> : null}
        </article>

        <article className="panel">
          <h2>Stream Scheduler</h2>
          <form onSubmit={submitSchedule} className="formGrid">
            <label className="field">
              <span>Start date/time</span>
              <input
                type="datetime-local"
                value={scheduleStartAt}
                onChange={(event) => setScheduleStartAt(event.target.value)}
              />
            </label>

            <label className="field inlineField">
              <span>24/7 mode (no end time)</span>
              <input
                type="checkbox"
                checked={schedule24x7}
                onChange={(event) => {
                  const checked = event.target.checked;
                  setSchedule24x7(checked);
                  if (checked) {
                    setScheduleEndAt("");
                  }
                }}
              />
            </label>

            {!schedule24x7 ? (
              <label className="field">
                <span>End date/time (optional)</span>
                <input
                  type="datetime-local"
                  value={scheduleEndAt}
                  onChange={(event) => setScheduleEndAt(event.target.value)}
                />
              </label>
            ) : null}

            <button className="btn secondary" type="submit" disabled={busy || !scheduleStartAt.trim()}>
              Add Schedule
            </button>
          </form>

          <p className="tinyMono">Scheduled starts begin at the first program in your lineup (queue position 1).</p>

          {!streamSchedules.length ? <p className="mutedText">No stream schedules yet.</p> : null}
          <ul className="assetList">
            {streamSchedules.map((schedule) => {
              const status = scheduleStatusLabel(schedule, Date.now());
              return (
                <li key={schedule.id}>
                  <div>
                    <strong>{status}</strong>
                    <p className="metaLine">Start: {formatDateTime(schedule.startAt)}</p>
                    <p className="metaLine">
                      End: {schedule.endAt ? formatDateTime(schedule.endAt) : "24/7 mode (manual stop)"}
                    </p>
                  </div>
                  <div className="cardActions compact">
                    <button
                      type="button"
                      className="btn secondary"
                      onClick={() => toggleScheduleEnabled(schedule.id, schedule.enabled)}
                      disabled={busy}
                    >
                      {schedule.enabled ? "Disable" : "Enable"}
                    </button>
                    <button
                      type="button"
                      className="btn ghost"
                      onClick={() => removeSchedule(schedule.id)}
                      disabled={busy}
                    >
                      Delete
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        </article>

        <article className="panel">
          <h2>Station Profile</h2>
          <form onSubmit={saveSettings} className="formGrid">
            <label className="field">
              <span>Station name</span>
              <input value={channelName} onChange={(event) => setChannelName(event.target.value)} />
            </label>

            <label className="field">
              <span>Description</span>
              <textarea
                value={channelDescription}
                rows={3}
                onChange={(event) => setChannelDescription(event.target.value)}
                placeholder="Describe this station"
              />
            </label>

            <div className="formRow">
              <label className="field">
                <span>Stream type</span>
                <select value={streamMode} onChange={(event) => setStreamMode(event.target.value as StreamMode)}>
                  <option value="video">24/7 Video background</option>
                  <option value="radio">24/7 Image/GIF + Audio</option>
                </select>
              </label>

              <label className="field">
                <span>Player label</span>
                <input value={playerLabel} maxLength={48} onChange={(event) => setPlayerLabel(event.target.value)} />
              </label>

              <label className="field">
                <span>Brand color</span>
                <input type="color" value={brandColor} onChange={(event) => setBrandColor(event.target.value)} />
              </label>
            </div>

            {streamMode === "radio" ? (
              <div className="panelStack">
                <p className="tinyMono">
                  Radio mode generates a video stream from your looping background plus queued audio files.
                </p>
                <div className="formGrid">
                  <label className="field">
                    <span>Background image / GIF</span>
                    <input
                      type="file"
                      accept="image/png,image/jpeg,image/webp,image/gif"
                      onChange={(event) => setRadioBackgroundFile(event.target.files?.[0] ?? null)}
                    />
                  </label>
                  <div className="cardActions compact">
                    <button
                      type="button"
                      className="btn secondary"
                      disabled={busy || !radioBackgroundFile}
                      onClick={() => submitRadioBackground()}
                    >
                      Upload background
                    </button>
                    <button
                      type="button"
                      className="btn ghost"
                      disabled={busy || !detail.channel.radioBackgroundUrl}
                      onClick={clearRadioBackground}
                    >
                      Clear background
                    </button>
                  </div>
                </div>
                {radioBackgroundPreviewUrl ? (
                  <img src={radioBackgroundPreviewUrl} alt="Radio background preview" className="radioBgPreview" />
                ) : (
                  <p className="mutedText">No radio background uploaded yet.</p>
                )}
              </div>
            ) : null}

            <div className="panelStack">
              <label className="field">
                <span>Video Inserts (Ads/Bumpers) Trigger Mode</span>
                <select
                  value={adTriggerMode}
                  onChange={(event) => setAdTriggerMode(event.target.value as AdTriggerMode)}
                >
                  <option value="disabled">Disabled</option>
                  <option value="every_n_programs">Every Nth Video</option>
                  <option value="time_interval">Time Interval</option>
                </select>
              </label>

              {adTriggerMode === "every_n_programs" ? (
                <div className="formRow">
                  <label className="field">
                    <span>Every Nth video</span>
                    <input
                      type="number"
                      min={1}
                      value={adInterval}
                      onChange={(event) => setAdInterval(Math.max(1, Number(event.target.value) || 1))}
                    />
                  </label>
                </div>
              ) : null}

              {adTriggerMode === "time_interval" ? (
                <div className="formRow">
                  <label className="field">
                    <span>Hours</span>
                    <input
                      type="number"
                      min={0}
                      value={adIntervalHours}
                      onChange={(event) => setAdIntervalHours(Math.max(0, Number(event.target.value) || 0))}
                    />
                  </label>
                  <label className="field">
                    <span>Minutes</span>
                    <input
                      type="number"
                      min={0}
                      max={59}
                      value={adIntervalMinutes}
                      onChange={(event) =>
                        setAdIntervalMinutes(Math.max(0, Math.min(59, Number(event.target.value) || 0)))
                      }
                    />
                  </label>
                  <label className="field">
                    <span>Seconds</span>
                    <input
                      type="number"
                      min={0}
                      max={59}
                      value={adIntervalSeconds}
                      onChange={(event) =>
                        setAdIntervalSeconds(Math.max(0, Math.min(59, Number(event.target.value) || 0)))
                      }
                    />
                  </label>
                </div>
              ) : null}
            </div>

            <button className="btn" type="submit" disabled={busy || !channelName.trim()}>
              Save Station Settings
            </button>
          </form>
        </article>
        </section>
      ) : null}

      {activeTab === "destinations" ? (
        <section className="studioDashboardGrid">
        <article className="panel">
          <div className="panelHead">
            <h2>Livepeer Output</h2>
          </div>

          <p className="metaLine">Configured: {detail.livepeer?.streamId ? "Yes" : "No"}</p>
          <p className="metaLine">Enabled: {detail.livepeer?.enabled ? "Yes" : "No"}</p>
          <p className="metaLine">Playback ID: {detail.livepeer?.playbackId ?? "Not provisioned"}</p>

          <div className="cardActions">
            <button type="button" className="btn" onClick={handleProvisionLivepeer} disabled={busy}>
              Provision Stream
            </button>
            <button type="button" className="btn secondary" onClick={toggleLivepeerEnabled} disabled={busy}>
              {detail.livepeer?.enabled ? "Disable Livepeer" : "Enable Livepeer"}
            </button>
            {detail.livepeer?.playbackUrl ? (
              <a className="btn ghost" href={detail.livepeer.playbackUrl} target="_blank" rel="noreferrer">
                Open Playback URL
              </a>
            ) : null}
          </div>

          {detail.livepeer?.lastError ? <p className="error">Livepeer: {detail.livepeer.lastError}</p> : null}
        </article>

        <article className="panel">
          <h2>Connected Platforms (Multistream)</h2>
          <form onSubmit={submitDestination} className="formGrid">
            <label className="field">
              <span>Destination name</span>
              <input
                value={destinationName}
                onChange={(event) => setDestinationName(event.target.value)}
                placeholder="YouTube Main"
              />
            </label>

            <label className="field">
              <span>RTMP URL</span>
              <input
                value={destinationUrl}
                onChange={(event) => setDestinationUrl(event.target.value)}
                placeholder="rtmp://a.rtmp.youtube.com/live2"
              />
            </label>

            <label className="field">
              <span>Stream key</span>
              <input
                value={destinationKey}
                onChange={(event) => setDestinationKey(event.target.value)}
                placeholder="xxxx-xxxx-xxxx"
              />
            </label>

            <button
              className="btn"
              type="submit"
              disabled={busy || !destinationName.trim() || !destinationUrl.trim() || !destinationKey.trim()}
            >
              Add Destination
            </button>
          </form>

          <ul className="platformList">
            {detail.destinations.map((destination) => (
              <li key={destination.id}>
                <div>
                  <strong>{destination.name}</strong>
                  <p className="metaLine">{destination.rtmpUrl}</p>
                </div>
                <div className="cardActions compact">
                  <button
                    type="button"
                    className="btn secondary"
                    onClick={() => toggleDestination(destination.id, destination.enabled)}
                    disabled={busy}
                  >
                    {destination.enabled ? "Disable" : "Enable"}
                  </button>
                  <button
                    type="button"
                    className="btn ghost"
                    onClick={() => removeDestination(destination.id)}
                    disabled={busy}
                  >
                    Remove
                  </button>
                </div>
              </li>
            ))}
          </ul>

          {!detail.destinations.length ? <p className="mutedText">No destinations configured.</p> : null}
        </article>
        </section>
      ) : null}

      {activeTab === "content" ? (
        <section className="studioDashboardGrid">
        <article className="panel">
          <h2>Content Ingest</h2>
          <div className="splitForms">
            <form onSubmit={submitUpload} className="formGrid">
              <h3>Upload Media</h3>
              <label className="field">
                <span>Media file (video or audio)</span>
                <input
                  type="file"
                  accept="video/*,audio/*"
                  onChange={(event) => setUploadFile(event.target.files?.[0] ?? null)}
                />
              </label>
              <label className="field">
                <span>Title</span>
                <input value={uploadTitle} onChange={(event) => setUploadTitle(event.target.value)} />
              </label>
              <label className="field">
                <span>Type</span>
                <select value={uploadType} onChange={(event) => setUploadType(event.target.value as AssetType)}>
                  <option value="program">Program</option>
                  <option value="ad">Ad</option>
                </select>
              </label>
              <button className="btn" type="submit" disabled={busy || !uploadFile}>
                Upload
              </button>
            </form>

            <form onSubmit={submitSingleExternal} className="formGrid">
              <h3>Add Single Link</h3>
              <label className="field">
                <span>Source URL</span>
                <input
                  value={singleExternalUrl}
                  onChange={(event) => setSingleExternalUrl(event.target.value)}
                  placeholder="https://..."
                />
              </label>
              <label className="field">
                <span>Title (optional)</span>
                <input
                  value={singleExternalTitle}
                  onChange={(event) => setSingleExternalTitle(event.target.value)}
                  placeholder="Episode title"
                />
              </label>
              <label className="field">
                <span>Type</span>
                <select
                  value={singleExternalType}
                  onChange={(event) => setSingleExternalType(event.target.value as AssetType)}
                >
                  <option value="program">Program</option>
                  <option value="ad">Ad</option>
                </select>
              </label>
              <button className="btn secondary" type="submit" disabled={busy || !singleExternalUrl.trim()}>
                Queue Single Import
              </button>
            </form>

            <form onSubmit={submitPlaylistExternal} className="formGrid">
              <h3>Add Playlist / Batch Links</h3>
              <label className="field inlineField">
                <span>Expand playlist links</span>
                <input
                  type="checkbox"
                  checked={expandPlaylistLinks}
                  onChange={(event) => setExpandPlaylistLinks(event.target.checked)}
                />
              </label>
              <label className="field">
                <span>Playlist URLs (one per line)</span>
                <textarea
                  value={playlistUrlsText}
                  rows={5}
                  onChange={(event) => setPlaylistUrlsText(event.target.value)}
                  placeholder={"https://playlist-link\nhttps://another-playlist-or-video"}
                />
              </label>
              <label className="field">
                <span>Title prefix (optional)</span>
                <input
                  value={playlistTitlePrefix}
                  onChange={(event) => setPlaylistTitlePrefix(event.target.value)}
                  placeholder="Season 1 Import"
                />
              </label>
              <label className="field">
                <span>Type</span>
                <select
                  value={playlistExternalType}
                  onChange={(event) => setPlaylistExternalType(event.target.value as AssetType)}
                >
                  <option value="program">Program</option>
                  <option value="ad">Ad</option>
                </select>
              </label>
              <button
                className="btn secondary"
                type="submit"
                disabled={busy || parseExternalLinksInput(playlistUrlsText).length === 0}
              >
                Queue Playlist Import
              </button>
            </form>
          </div>

          <p className="tinyMono">Only ingest content you are licensed or permitted to broadcast.</p>

          <div className="panelStack">
            <h3>Import Queue</h3>
            {!ingestJobs.length ? <p className="mutedText">No external imports yet.</p> : null}
            {!!activeIngestJobs.length ? (
              <p className="mutedText">
                {activeIngestJobs.length} job{activeIngestJobs.length === 1 ? "" : "s"} in progress
              </p>
            ) : null}

            <ul className="assetList">
              {ingestJobs.map((job) => {
                const completed = job.items.filter((item) => item.status === "completed").length;
                const failed = job.items.filter((item) => item.status === "failed").length;
                const canceled = job.items.filter((item) => item.status === "canceled").length;
                const total = job.items.length || job.expandedUrls.length || job.requestedUrls.length;
                const canCancel = job.status === "queued" || job.status === "expanding" || job.status === "running";

                return (
                  <li key={job.id}>
                    <div>
                      <strong>{ingestJobStatusLabel(job.status)}</strong>
                      <p className="metaLine">
                        {completed}/{total} imported
                        {failed ? ` • ${failed} failed` : ""}
                        {canceled ? ` • ${canceled} canceled` : ""}
                        {` • ${job.progressPct}%`}
                      </p>
                      <div className="cardActions compact">
                        {canCancel ? (
                          <button
                            type="button"
                            className="btn secondary"
                            onClick={() => cancelIngestJob(job.id)}
                            disabled={busy}
                          >
                            Cancel import
                          </button>
                        ) : null}
                        <button
                          type="button"
                          className="btn ghost"
                          onClick={() => removeIngestJob(job.id)}
                          disabled={busy}
                        >
                          Delete job
                        </button>
                      </div>
                      <progress max={100} value={job.progressPct} />
                      {job.error ? <p className="error">{job.error}</p> : null}
                      {job.items.map((item) => {
                        const draftKey = `${job.id}:${item.id}`;
                        const draftTitle = ingestTitleDrafts[draftKey] ?? item.title ?? "";
                        return (
                          <div key={item.id} className="ingestItemRow">
                            <p className="tinyMono">
                              {ingestItemStatusLabel(item.status)} • {item.sourceUrl}
                              {` • ${item.progressPct}%`}
                              {item.error ? ` • ${item.error}` : ""}
                            </p>
                            <div className="cardActions compact">
                              <input
                                value={draftTitle}
                                placeholder="Item title"
                                onChange={(event) =>
                                  setIngestTitleDrafts((current) => ({
                                    ...current,
                                    [draftKey]: event.target.value
                                  }))
                                }
                              />
                              <button
                                type="button"
                                className="btn ghost"
                                disabled={busy || draftTitle.trim() === (item.title ?? "").trim()}
                                onClick={() => saveIngestItemTitle(job.id, item.id, item.title)}
                              >
                                Save title
                              </button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        </article>

        <article className="panel">
          <h2>Content Library & Folders</h2>
          <div className="panelStack">
            <div className="segmented" role="tablist" aria-label="Asset type filter">
              <button
                type="button"
                className={assetFilter === "all" ? "segment active" : "segment"}
                onClick={() => setAssetFilter("all")}
              >
                All
              </button>
              <button
                type="button"
                className={assetFilter === "programs" ? "segment active" : "segment"}
                onClick={() => setAssetFilter("programs")}
              >
                Programs
              </button>
              <button
                type="button"
                className={assetFilter === "ads" ? "segment active" : "segment"}
                onClick={() => setAssetFilter("ads")}
              >
                Ads
              </button>
              <button
                type="button"
                className={assetFilter === "uploads" ? "segment active" : "segment"}
                onClick={() => setAssetFilter("uploads")}
              >
                Uploads
              </button>
              <button
                type="button"
                className={assetFilter === "external" ? "segment active" : "segment"}
                onClick={() => setAssetFilter("external")}
              >
                External
              </button>
              <button
                type="button"
                className={assetFilter === "audio" ? "segment active" : "segment"}
                onClick={() => setAssetFilter("audio")}
              >
                Audio
              </button>
              <button
                type="button"
                className={assetFilter === "video" ? "segment active" : "segment"}
                onClick={() => setAssetFilter("video")}
              >
                Video
              </button>
            </div>

            <div className="libraryFilterGrid">
              <label className="field">
                <span>Search library</span>
                <input
                  value={assetSearch}
                  onChange={(event) => setAssetSearch(event.target.value)}
                  placeholder="Search title or source URL"
                />
              </label>
              <label className="field">
                <span>Sort</span>
                <select value={assetSort} onChange={(event) => setAssetSort(event.target.value as typeof assetSort)}>
                  <option value="newest">Newest first</option>
                  <option value="oldest">Oldest first</option>
                  <option value="title_asc">Title A-Z</option>
                  <option value="title_desc">Title Z-A</option>
                  <option value="duration_asc">Shortest duration</option>
                  <option value="duration_desc">Longest duration</option>
                </select>
              </label>
              <label className="field">
                <span>Folder scope</span>
                <select value={selectedFolderId} onChange={(event) => setSelectedFolderId(event.target.value)}>
                  <option value="all">All folders</option>
                  <option value="ungrouped">Ungrouped only</option>
                  {flattenedFolders.map((folder) => (
                    <option key={folder.id} value={folder.id}>
                      {`${"-- ".repeat(folder.depth)}${folder.name}`}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <div className="libraryLayout">
              <div className="folderPanel">
                <h3>Folder Manager</h3>
                <ul className="folderTreeList">
                  <li>
                    <button
                      type="button"
                      className={selectedFolderId === "all" ? "folderTreeButton active" : "folderTreeButton"}
                      onClick={() => setSelectedFolderId("all")}
                    >
                      All folders
                    </button>
                  </li>
                  <li>
                    <button
                      type="button"
                      className={selectedFolderId === "ungrouped" ? "folderTreeButton active" : "folderTreeButton"}
                      onClick={() => setSelectedFolderId("ungrouped")}
                    >
                      Ungrouped
                    </button>
                  </li>
                  {flattenedFolders.map((folder) => (
                    <li key={folder.id}>
                      <button
                        type="button"
                        className={selectedFolderId === folder.id ? "folderTreeButton active" : "folderTreeButton"}
                        style={{ paddingLeft: `${0.68 + folder.depth * 0.72}rem` }}
                        onClick={() => setSelectedFolderId(folder.id)}
                      >
                        {folder.name}
                      </button>
                    </li>
                  ))}
                </ul>

                <form onSubmit={createNewFolder} className="formGrid">
                  <h4>Create folder</h4>
                  <label className="field">
                    <span>Folder name</span>
                    <input
                      value={newFolderName}
                      maxLength={80}
                      onChange={(event) => setNewFolderName(event.target.value)}
                      placeholder="e.g. Series / Campaign"
                    />
                  </label>
                  <label className="field">
                    <span>Parent folder</span>
                    <select
                      value={newFolderParentId}
                      onChange={(event) => setNewFolderParentId(event.target.value)}
                    >
                      <option value="">Root</option>
                      {flattenedFolders.map((folder) => (
                        <option key={folder.id} value={folder.id}>
                          {`${"-- ".repeat(folder.depth)}${folder.name}`}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button className="btn secondary" type="submit" disabled={busy || !newFolderName.trim()}>
                    Create folder
                  </button>
                </form>

                <form onSubmit={saveSelectedFolderMeta} className="formGrid">
                  <h4>Edit selected folder</h4>
                  <label className="field">
                    <span>Folder name</span>
                    <input
                      value={renameFolderName}
                      maxLength={80}
                      onChange={(event) => setRenameFolderName(event.target.value)}
                      placeholder="Select a folder first"
                      disabled={!selectedFolder}
                    />
                  </label>
                  <label className="field">
                    <span>Move under</span>
                    <select
                      value={moveFolderParentId}
                      onChange={(event) => setMoveFolderParentId(event.target.value)}
                      disabled={!selectedFolder}
                    >
                      <option value="">Root</option>
                      {flattenedFolders.map((folder) => (
                        <option
                          key={folder.id}
                          value={folder.id}
                          disabled={selectedFolder ? blockedMoveParentIds.has(folder.id) : false}
                        >
                          {`${"-- ".repeat(folder.depth)}${folder.name}`}
                        </option>
                      ))}
                    </select>
                  </label>
                  <div className="cardActions compact">
                    <button className="btn secondary" type="submit" disabled={busy || !selectedFolder}>
                      Save folder
                    </button>
                    <button
                      type="button"
                      className="btn ghost"
                      onClick={removeSelectedFolder}
                      disabled={busy || !selectedFolder}
                    >
                      Delete folder
                    </button>
                  </div>
                </form>
              </div>

              <div className="panelStack">
                {!filteredAssets.length ? <p className="mutedText">No assets match this filter.</p> : null}
                <ul className="assetList">
                  {filteredAssets.map((asset) => (
                    <li key={asset.id}>
                      <div>
                        <strong>{asset.title}</strong>
                        <p className="metaLine">
                          {asset.sourceType.toUpperCase()} • {asset.mediaKind.toUpperCase()} • {formatDuration(asset.durationSec)}
                          {asset.ipfsCid ? ` • IPFS: ${asset.ipfsCid}` : ""}
                        </p>
                        <p className="metaLine">Folder: {folderNameById.get(asset.folderId ?? "") ?? "Ungrouped"}</p>
                      </div>
                      <div className="cardActions compact">
                        <select
                          value={asset.type}
                          onChange={(event) => setAssetType(asset.id, event.target.value as AssetType)}
                          disabled={busy}
                        >
                          <option value="program">Program</option>
                          <option value="ad">Ad</option>
                        </select>
                        <select
                          value={asset.folderId ?? ""}
                          onChange={(event) => setAssetFolder(asset.id, event.target.value || null)}
                          disabled={busy}
                        >
                          <option value="">Ungrouped</option>
                          {flattenedFolders.map((folder) => (
                            <option key={folder.id} value={folder.id}>
                              {`${"-- ".repeat(folder.depth)}${folder.name}`}
                            </option>
                          ))}
                        </select>
                        <button
                          type="button"
                          className="btn secondary"
                          onClick={() => addToPlaylist(asset.id)}
                          disabled={busy || asset.type === "ad"}
                        >
                          {asset.type === "ad" ? "Ad pool only" : "Add to lineup"}
                        </button>
                        <button type="button" className="btn ghost" onClick={() => removeAsset(asset.id)} disabled={busy}>
                          Delete
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </div>
        </article>
        </section>
      ) : null}

      {activeTab === "lineup" ? (
        <section className="panel">
        <div className="panelHead">
          <h2>Station Lineup Editor</h2>
          <button type="button" className="btn" onClick={savePlaylist} disabled={busy}>
            Save Lineup
          </button>
        </div>

        <div className="queueEditorGrid">
          <div>
            {!playlistDraft.length ? <p className="mutedText">No items in draft lineup.</p> : null}
            <ol className="queueList">
              {playlistDraft.map((assetId, index) => {
                const asset = assetsById.get(assetId);
                if (!asset) {
                  return null;
                }

                return (
                  <li key={`${assetId}-${index}`}>
                    <strong>{asset.title}</strong>
                    <span>{asset.type === "ad" ? "Ad" : "Program"} • {asset.mediaKind === "audio" ? "Audio" : "Video"}</span>
                    <span>{formatDuration(asset.durationSec)}</span>
                    <div className="cardActions compact">
                      <button
                        type="button"
                        className="btn ghost"
                        onClick={() => movePlaylistItem(index, -1)}
                        disabled={busy || index === 0}
                      >
                        Up
                      </button>
                      <button
                        type="button"
                        className="btn ghost"
                        onClick={() => movePlaylistItem(index, 1)}
                        disabled={busy || index === playlistDraft.length - 1}
                      >
                        Down
                      </button>
                      <button
                        type="button"
                        className="btn secondary"
                        onClick={() => removePlaylistItem(index)}
                        disabled={busy}
                      >
                        Remove
                      </button>
                    </div>
                  </li>
                );
              })}
            </ol>
          </div>

          <div>
            <div className="panelHead">
              <h3>Schedule</h3>
              {showPreviewTag ? <span className="scheduleModeTag">Preview</span> : null}
            </div>
            <p className="mutedText">{scheduleBasis}</p>
            {!scheduleRows.length ? <p className="mutedText">Queue is empty.</p> : null}
            <ol className="scheduleList compact">
              {scheduleRows.map((slot, index) => (
                <li key={slot.id} className={index === 0 && detail.state.isRunning ? "current" : ""}>
                  <div className="slotTime">{index === 0 && detail.state.isRunning ? "Now" : formatClockTime(slot.startsAt)}</div>
                  <div>
                    <strong>{slot.title}</strong>
                    <p className="metaLine">
                      {slot.kind} • {formatDuration(slot.durationSec)}
                    </p>
                  </div>
                </li>
              ))}
            </ol>
          </div>
        </div>
        </section>
      ) : null}

      {activeTab === "activity" ? (
        <section className="studioDashboardGrid">
          <article className="panel">
            <h2>Import Activity</h2>
            {!ingestJobs.length ? <p className="mutedText">No import jobs yet.</p> : null}
            <ul className="assetList">
              {ingestJobs.map((job) => (
                <li key={`activity-${job.id}`}>
                  <div>
                    <strong>{ingestJobStatusLabel(job.status)}</strong>
                    <p className="metaLine">
                      {job.items.filter((item) => item.status === "completed").length}/
                      {job.items.length || job.expandedUrls.length || job.requestedUrls.length} completed
                      {` • ${job.progressPct}%`}
                    </p>
                    {job.error ? <p className="error">{job.error}</p> : null}
                  </div>
                </li>
              ))}
            </ul>
          </article>

          <article className="panel">
            <h2>Schedule Activity</h2>
            {!streamSchedules.length ? <p className="mutedText">No scheduled entries yet.</p> : null}
            <ul className="assetList">
              {streamSchedules.map((schedule) => (
                <li key={`activity-schedule-${schedule.id}`}>
                  <div>
                    <strong>{scheduleStatusLabel(schedule, Date.now())}</strong>
                    <p className="metaLine">Start: {formatDateTime(schedule.startAt)}</p>
                    <p className="metaLine">
                      End: {schedule.endAt ? formatDateTime(schedule.endAt) : "24/7 mode (manual stop)"}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          </article>
        </section>
      ) : null}
    </main>
  );
}
