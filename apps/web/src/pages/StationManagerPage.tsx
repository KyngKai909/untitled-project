import { FormEvent, useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  createStreamSchedule,
  deleteAsset,
  deleteStreamSchedule,
  getApiBase,
  getChannelDetail,
  getChannelStatus,
  importLibraryAssetsToChannel,
  listLibraryAssets,
  patchChannel,
  provisionLivepeer,
  putPlaylist,
  sendChannelControl,
  setLivepeerEnabled
} from "../api";
import HlsPlayer from "../components/HlsPlayer";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Progress } from "../components/ui/progress";
import { Textarea } from "../components/ui/textarea";
import type { Asset, ChannelDetail, StreamMode } from "../types";
import { getStoredWalletAddress } from "../wallet";

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

function formatDuration(seconds: number | undefined): string {
  if (!seconds || seconds <= 0) {
    return "--:--";
  }
  const total = Math.floor(seconds);
  const mins = Math.floor(total / 60);
  const rem = total % 60;
  return `${mins}:${String(rem).padStart(2, "0")}`;
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
        previous: [] as Asset[],
        next: [] as Asset[],
        current: undefined as Asset | undefined,
        remainingSec: undefined as number | undefined,
        progressPct: 0
      };
    }

    const playlist = detail.playlist.map((item) => item.asset).filter((asset) => asset.type === "program");
    const playlistIds = playlist.map((asset) => asset.id);
    const queueLength = playlist.length;
    const normalizedQueueIndex = queueLength > 0 ? mod(detail.state.queueIndex, queueLength) : 0;

    const currentAsset = detail.assets.find((asset) => asset.id === detail.state.currentAssetId);
    const currentPlaylistIndex = findClosestIndex(playlistIds, detail.state.currentAssetId, normalizedQueueIndex);

    const previous: Asset[] = [];
    const next: Asset[] = [];

    if (queueLength > 0) {
      const previousAnchor = currentPlaylistIndex ?? normalizedQueueIndex;
      const nextAnchor = currentPlaylistIndex !== undefined ? currentPlaylistIndex + 1 : normalizedQueueIndex;

      for (let offset = 1; offset <= Math.min(3, queueLength); offset += 1) {
        previous.push(playlist[mod(previousAnchor - offset, queueLength)]);
      }
      for (let offset = 0; offset < Math.min(6, queueLength); offset += 1) {
        next.push(playlist[mod(nextAnchor + offset, queueLength)]);
      }
    }

    let remainingSec: number | undefined;
    let progressPct = 0;

    if (currentAsset?.durationSec && detail.state.currentStartedAt) {
      const startedAtMs = Date.parse(detail.state.currentStartedAt);
      if (!Number.isNaN(startedAtMs)) {
        const elapsedSec = Math.max(0, Math.floor((nowMs - startedAtMs) / 1000));
        remainingSec = Math.max(0, currentAsset.durationSec - elapsedSec);
        progressPct = Math.min(100, Math.max(0, (elapsedSec / currentAsset.durationSec) * 100));
      }
    }

    return {
      previous,
      next,
      current: currentAsset,
      remainingSec,
      progressPct
    };
  }, [detail, nowMs]);

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
        streamMode
      });
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

  async function onProvisionLivepeer() {
    if (!channelId) {
      return;
    }

    setBusy(true);
    setError(null);
    setInfo(null);

    try {
      await provisionLivepeer(channelId);
      setInfo("Livepeer stream provisioned.");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to provision Livepeer stream");
    } finally {
      setBusy(false);
    }
  }

  async function onToggleLivepeer(enabled: boolean) {
    if (!channelId) {
      return;
    }

    setBusy(true);
    setError(null);
    setInfo(null);

    try {
      await setLivepeerEnabled(channelId, enabled);
      setInfo(enabled ? "Livepeer output enabled." : "Livepeer output disabled.");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update Livepeer setting");
    } finally {
      setBusy(false);
    }
  }

  if (!channelId) {
    return (
      <main className="mx-auto w-full max-w-7xl px-4 py-6">
        <div className="rounded-md border border-rose-500/40 bg-rose-500/10 p-3 text-sm text-rose-300">Channel id is missing.</div>
      </main>
    );
  }

  return (
    <main className="mx-auto w-full max-w-7xl space-y-4 px-4 py-6">
      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-3">
          <div>
            <p className="text-xs uppercase tracking-wide text-slate-400">Station Manager</p>
            <CardTitle>{detail?.channel.name ?? "Loading..."}</CardTitle>
            <CardDescription>
              Import from global library, structure playlists, schedule windows, and control live output.
            </CardDescription>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button asChild variant="outline" size="sm">
              <Link to="/dashboard">Back to Dashboard</Link>
            </Button>
            <Button asChild variant="outline" size="sm">
              <Link to={`/stations/${channelId}/preview`}>Open Preview</Link>
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {detail ? (
            <div className="flex flex-wrap items-center gap-2 text-sm text-slate-300">
              <Badge variant={detail.state.isRunning ? "default" : "secondary"}>
                {detail.state.isRunning ? "LIVE" : "OFF AIR"}
              </Badge>
              {timeline.current ? <span>Now: {timeline.current.title}</span> : <span>Waiting for next item</span>}
              {timeline.remainingSec !== undefined ? <span>Remaining {formatDuration(timeline.remainingSec)}</span> : null}
            </div>
          ) : null}
        </CardContent>
      </Card>

      {error ? (
        <div className="rounded-md border border-rose-500/40 bg-rose-500/10 p-3 text-sm text-rose-300">{error}</div>
      ) : null}
      {info ? (
        <div className="rounded-md border border-cyan-500/40 bg-cyan-500/10 p-3 text-sm text-cyan-200">{info}</div>
      ) : null}

      {loading || !detail ? (
        <Card><CardContent className="pt-5 text-sm text-slate-400">Loading station...</CardContent></Card>
      ) : (
        <>
          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle>Station Profile</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <Input value={name} onChange={(event) => setName(event.target.value)} disabled={busy} />
                <Textarea value={description} onChange={(event) => setDescription(event.target.value)} disabled={busy} />
                <select
                  className="h-10 w-full rounded-md border border-slate-700 bg-slate-950/70 px-3 text-sm text-slate-100"
                  value={streamMode}
                  onChange={(event) => setStreamMode(event.target.value === "radio" ? "radio" : "video")}
                  disabled={busy}
                >
                  <option value="video">Video</option>
                  <option value="radio">Radio</option>
                </select>
                <Button onClick={() => void onSaveStationProfile()} disabled={busy}>Save Station</Button>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Live Output</CardTitle>
                <CardDescription className="break-all">{streamUrl || "No stream URL yet"}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex flex-wrap gap-2">
                  <Button onClick={() => void onProvisionLivepeer()} disabled={busy}>Provision Livepeer</Button>
                  <Button variant="outline" onClick={() => void onToggleLivepeer(!(detail.livepeer?.enabled ?? false))} disabled={busy}>
                    {detail.livepeer?.enabled ? "Disable Livepeer" : "Enable Livepeer"}
                  </Button>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button onClick={() => void onControl("start")} disabled={busy}>Go Live</Button>
                  <Button variant="outline" onClick={() => void onControl("previous")} disabled={busy}>Previous</Button>
                  <Button variant="outline" onClick={() => void onControl("skip")} disabled={busy}>Skip Next</Button>
                  <Button variant="outline" onClick={() => void onControl("stop")} disabled={busy}>Stop</Button>
                </div>
                {streamUrl ? <HlsPlayer src={streamUrl} muted /> : null}
              </CardContent>
            </Card>
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle>Playlist Timeline</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div>
                  <p className="mb-1 text-xs uppercase tracking-wide text-slate-400">Previously Played</p>
                  {timeline.previous.length === 0 ? <p className="text-sm text-slate-500">No history yet.</p> : null}
                  <ol className="list-decimal space-y-1 pl-5 text-sm text-slate-300">
                    {timeline.previous.map((asset, index) => (
                      <li key={`${asset.id}-prev-${index}`}>{asset.title}</li>
                    ))}
                  </ol>
                </div>

                <div className="rounded-md border border-slate-800 p-3">
                  <p className="mb-1 text-xs uppercase tracking-wide text-slate-400">Now Playing</p>
                  <p className="font-medium">{timeline.current?.title ?? "Nothing live right now"}</p>
                  <p className="text-sm text-slate-400">
                    {timeline.current
                      ? `${timeline.current.insertionCategory ?? timeline.current.type} · ${formatDuration(timeline.current.durationSec)}`
                      : "Queue a playlist and go live."}
                    {timeline.remainingSec !== undefined ? ` · ${formatDuration(timeline.remainingSec)} left` : ""}
                  </p>
                  <div className="mt-2">
                    <Progress value={timeline.progressPct} />
                  </div>
                </div>

                <div>
                  <p className="mb-1 text-xs uppercase tracking-wide text-slate-400">Up Next</p>
                  {timeline.next.length === 0 ? <p className="text-sm text-slate-500">No upcoming items.</p> : null}
                  <ol className="list-decimal space-y-1 pl-5 text-sm text-slate-300">
                    {timeline.next.map((asset, index) => (
                      <li key={`${asset.id}-next-${index}`}>{asset.title}</li>
                    ))}
                  </ol>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Playlist Builder</CardTitle>
                <CardDescription>Add station programs, reorder, then push the new order to live playout.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <p className="text-xs uppercase tracking-wide text-slate-400">Station Programs</p>
                  {stationPrograms.length === 0 ? <p className="text-sm text-slate-500">Import programs from global library first.</p> : null}
                  {stationPrograms.map((asset) => (
                    <div key={asset.id} className="flex items-center justify-between rounded-md border border-slate-800 p-2">
                      <div>
                        <p className="text-sm font-medium">{asset.title}</p>
                        <p className="text-xs text-slate-400">{formatDuration(asset.durationSec)}</p>
                      </div>
                      <Button size="sm" variant="outline" onClick={() => addProgramToDraft(asset.id)} disabled={busy}>Add</Button>
                    </div>
                  ))}
                </div>

                <div className="space-y-2">
                  <p className="text-xs uppercase tracking-wide text-slate-400">Draft Playlist</p>
                  {queuePreview.length === 0 ? <p className="text-sm text-slate-500">Draft queue is empty.</p> : null}
                  {queuePreview.map((asset, index) => (
                    <div key={`${asset.id}-${index}`} className="flex items-center justify-between rounded-md border border-slate-800 p-2">
                      <div>
                        <p className="text-sm font-medium">{index + 1}. {asset.title}</p>
                        <p className="text-xs text-slate-400">{formatDuration(asset.durationSec)}</p>
                      </div>
                      <div className="flex items-center gap-1">
                        <Button size="sm" variant="outline" disabled={busy || index === 0} onClick={() => moveDraftItem(index, -1)}>Up</Button>
                        <Button size="sm" variant="outline" disabled={busy || index === queuePreview.length - 1} onClick={() => moveDraftItem(index, 1)}>Down</Button>
                        <Button size="sm" variant="outline" disabled={busy} onClick={() => removeDraftItem(index)}>Remove</Button>
                      </div>
                    </div>
                  ))}
                </div>

                <Button onClick={() => void onSaveQueue()} disabled={busy}>Push Playlist To Stream</Button>
              </CardContent>
            </Card>
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader className="flex flex-row items-start justify-between gap-3">
                <div>
                  <CardTitle>Schedule Runtime</CardTitle>
                  <CardDescription>Create windows or run 24/7.</CardDescription>
                </div>
                <Button variant="outline" onClick={() => void onStartAlwaysOnNow()} disabled={busy}>Start 24/7 Now</Button>
              </CardHeader>
              <CardContent className="space-y-3">
                <form className="space-y-3" onSubmit={(event) => void onCreateSchedule(event)}>
                  <Input type="datetime-local" value={scheduleStart} onChange={(event) => setScheduleStart(event.target.value)} required disabled={busy} />
                  <Input type="datetime-local" value={scheduleEnd} onChange={(event) => setScheduleEnd(event.target.value)} disabled={busy} />
                  <Button type="submit" disabled={busy || !scheduleStart}>Create Schedule</Button>
                </form>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Active Schedules</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                {detail.schedules.length === 0 ? <p className="text-sm text-slate-500">No schedules yet.</p> : null}
                {[...detail.schedules]
                  .sort((left, right) => Date.parse(left.startAt) - Date.parse(right.startAt))
                  .map((schedule) => (
                    <div key={schedule.id} className="flex items-center justify-between rounded-md border border-slate-800 p-2">
                      <div>
                        <p className="text-sm font-medium">{formatDateTime(schedule.startAt)}</p>
                        <p className="text-xs text-slate-400">
                          {schedule.endAt ? `Ends ${formatDateTime(schedule.endAt)}` : "24/7 (no end)"}
                        </p>
                      </div>
                      <Button size="sm" variant="outline" onClick={() => void onDeleteSchedule(schedule.id)} disabled={busy}>Remove</Button>
                    </div>
                  ))}
              </CardContent>
            </Card>
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader className="flex flex-row items-start justify-between gap-3">
                <div>
                  <CardTitle>Import Programs</CardTitle>
                  <CardDescription>Pull programs from your global creator library.</CardDescription>
                </div>
                <Button variant="outline" onClick={() => void refreshLibrary(ownerWallet)} disabled={loadingLibrary}>
                  {loadingLibrary ? "Refreshing..." : "Refresh"}
                </Button>
              </CardHeader>
              <CardContent className="space-y-2">
                {globalProgramLibrary.length === 0 ? <p className="text-sm text-slate-500">No global programs available.</p> : null}
                {globalProgramLibrary.map((asset) => {
                  const checked = selectedLibraryPrograms.includes(asset.id);
                  return (
                    <label key={asset.id} className="flex items-center gap-3 rounded-md border border-slate-800 p-2 text-sm">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={(event) => toggleLibraryProgram(asset.id, event.target.checked)}
                        disabled={busy}
                      />
                      <span className="flex-1">{asset.title}</span>
                      <span className="text-xs text-slate-500">{formatDuration(asset.durationSec)}</span>
                    </label>
                  );
                })}
                <Button
                  onClick={() => void onImportLibraryAssets(selectedLibraryPrograms)}
                  disabled={busy || selectedLibraryPrograms.length === 0 || !ownerWallet}
                >
                  Import Selected Programs
                </Button>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Ads, Sponsors, Bumpers</CardTitle>
                <CardDescription>Configure insertion frequency and station ad pool.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <p className="text-xs uppercase tracking-wide text-slate-400">Injection Rules</p>
                  <select
                    className="h-10 w-full rounded-md border border-slate-700 bg-slate-950/70 px-3 text-sm text-slate-100"
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

                  {adTriggerMode === "every_n_programs" ? (
                    <Input
                      type="number"
                      min={1}
                      value={adInterval}
                      onChange={(event) => setAdInterval(Number(event.target.value || 1))}
                      disabled={busy}
                    />
                  ) : null}

                  {adTriggerMode === "time_interval" ? (
                    <Input
                      type="number"
                      min={30}
                      value={adTimeIntervalSec}
                      onChange={(event) => setAdTimeIntervalSec(Number(event.target.value || 30))}
                      disabled={busy}
                    />
                  ) : null}

                  <Button onClick={() => void onSaveAdRules()} disabled={busy}>Save Injection Rules</Button>
                </div>

                <div className="space-y-2">
                  <p className="text-xs uppercase tracking-wide text-slate-400">Import Global Ad Assets</p>
                  {globalAdLibrary.length === 0 ? <p className="text-sm text-slate-500">No global ads/sponsors/bumpers yet.</p> : null}
                  {globalAdLibrary.map((asset) => {
                    const checked = selectedLibraryAds.includes(asset.id);
                    return (
                      <label key={asset.id} className="flex items-center gap-3 rounded-md border border-slate-800 p-2 text-sm">
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={(event) => toggleLibraryAd(asset.id, event.target.checked)}
                          disabled={busy}
                        />
                        <span className="flex-1">{asset.title}</span>
                        <Badge variant="secondary">{asset.insertionCategory ?? "ad"}</Badge>
                      </label>
                    );
                  })}
                  <Button
                    onClick={() => void onImportLibraryAssets(selectedLibraryAds)}
                    disabled={busy || selectedLibraryAds.length === 0 || !ownerWallet}
                  >
                    Import Selected Ads
                  </Button>
                </div>

                <div className="space-y-2">
                  <p className="text-xs uppercase tracking-wide text-slate-400">Station Ad Pool</p>
                  {stationAds.length === 0 ? <p className="text-sm text-slate-500">No ad assets in this station.</p> : null}
                  {stationAds.map((asset) => (
                    <div key={asset.id} className="flex items-center justify-between rounded-md border border-slate-800 p-2">
                      <div>
                        <p className="text-sm font-medium">{asset.title}</p>
                        <p className="text-xs text-slate-400">{asset.insertionCategory ?? "ad"} · {formatDuration(asset.durationSec)}</p>
                      </div>
                      <Button size="sm" variant="outline" onClick={() => void onDeleteAsset(asset.id)} disabled={busy}>Remove</Button>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          </div>
        </>
      )}
    </main>
  );
}
