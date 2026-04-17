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
import OverlayPanel from "../components/OverlayPanel";
import type { Asset, ChannelDetail, StreamMode } from "../types";
import { getStoredWalletAddress } from "../wallet";

type ManagerTab = "monitor" | "playlist" | "runtime" | "ads";

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
  const [railOpen, setRailOpen] = useState(false);

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

  const [scheduleModalOpen, setScheduleModalOpen] = useState(false);
  const [importProgramsModalOpen, setImportProgramsModalOpen] = useState(false);
  const [importAdsModalOpen, setImportAdsModalOpen] = useState(false);

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

  const livepeerEmbedUrl = useMemo(
    () => toLivepeerEmbedUrl(detail?.livepeer?.enabled ? detail.livepeer.playbackId : undefined),
    [detail]
  );

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
        const elapsedChunkSec = Math.max(0, Math.floor((nowMs - startedAtMs) / 1000));
        const baseOffsetSec = Math.max(0, Math.floor(detail.state.currentProgramOffsetSec ?? 0));
        const elapsedSec = currentAsset.type === "program" ? baseOffsetSec + elapsedChunkSec : elapsedChunkSec;
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
      route: detail?.livepeer?.enabled ? "Livepeer" : "Direct HLS",
      schedules: detail?.schedules.length ?? 0,
      queueDepth: detail?.playlist.length ?? 0
    };
  }, [detail]);

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
      <main className="routeFrame routeFrame--workspace">
        <div className="inlineAlert inlineAlert--error">Channel id is missing.</div>
      </main>
    );
  }

  const rail = (
    <>
      <section className="railBlock">
        <div className="railBlock__head">
          <h3>Station Snapshot</h3>
          <p>{detail ? `${detail.channel.streamMode.toUpperCase()} mode` : "Loading profile"}</p>
        </div>
        <dl className="railStats">
          <div>
            <dt>Status</dt>
            <dd>{detail?.state.isRunning ? "Live" : "Off Air"}</dd>
          </div>
          <div>
            <dt>Output Route</dt>
            <dd>{monitorStats.route}</dd>
          </div>
          <div>
            <dt>Queue Depth</dt>
            <dd>{monitorStats.queueDepth}</dd>
          </div>
          <div>
            <dt>Schedules</dt>
            <dd>{monitorStats.schedules}</dd>
          </div>
        </dl>
      </section>

      <section className="railBlock">
        <div className="railBlock__head">
          <h3>Output Endpoint</h3>
          <p className="wrapAnywhere">{streamUrl || "No stream URL yet"}</p>
        </div>
        <p className="emptyState">Routing controls live in the Monitor tab.</p>
      </section>

      <section className="railBlock">
        <div className="railBlock__head">
          <h3>Now Playing</h3>
          <p className="wrapAnywhere">{timeline.current?.title ?? "No active segment"}</p>
        </div>
        <p className="metaLine">Remaining: {timeline.remainingSec !== undefined ? formatDuration(timeline.remainingSec) : "--:--"}</p>
      </section>
    </>
  );

  return (
    <main className="routeFrame routeFrame--workspace">
      {error ? <div className="inlineAlert inlineAlert--error">{error}</div> : null}
      {info ? <div className="inlineAlert inlineAlert--info">{info}</div> : null}

      <section className="workspaceShell workspaceShell--manager">
        <aside className="workspaceRail">{rail}</aside>

        <section className="workspaceMain workspaceMain--manager">
          <header className="workspaceHead">
            <div>
              <h1>{detail?.channel.name ?? "Loading station"}</h1>
              <p>
                Structured operator workflow for monitoring, playlist sequencing, runtime scheduling, and ad strategy.
              </p>
              {detail ? (
                <p className="metaLine">
                  <span className={`statusPill ${detail.state.isRunning ? "statusPill--live" : "statusPill--off"}`}>
                    {detail.state.isRunning ? "Live" : "Off Air"}
                  </span>
                  {timeline.current ? <span>Now: {timeline.current.title}</span> : <span>No active item</span>}
                  {timeline.remainingSec !== undefined ? <span>Remaining {formatDuration(timeline.remainingSec)}</span> : null}
                </p>
              ) : null}
            </div>
            <div className="workspaceHead__actions">
              <Link className="uiButton uiButton--secondary" to="/dashboard">
                Workspace
              </Link>
              <Link className="uiButton uiButton--secondary" to={`/stations/${channelId}/preview`}>
                Preview Feed
              </Link>
              <button className="uiButton uiButton--secondary" type="button" onClick={() => void refresh()} disabled={loading}>
                {loading ? "Refreshing" : "Refresh"}
              </button>
              <button
                className={`uiButton ${detail?.state.isRunning ? "uiButton--danger" : "uiButton--accent"}`}
                type="button"
                onClick={() => void onControl(detail?.state.isRunning ? "stop" : "start")}
                disabled={busy || loading || !detail}
              >
                {detail?.state.isRunning ? "Stop Stream" : "Go Live"}
              </button>
              <button className="uiButton uiButton--ghost mobileOnly" type="button" onClick={() => setRailOpen(true)}>
                Open Snapshot
              </button>
            </div>
          </header>

          <nav className="managerTabs" aria-label="Station Workspace Tabs">
            <button type="button" data-active={tab === "monitor"} onClick={() => setTab("monitor")}>Monitor</button>
            <button type="button" data-active={tab === "playlist"} onClick={() => setTab("playlist")}>Playlist</button>
            <button type="button" data-active={tab === "runtime"} onClick={() => setTab("runtime")}>Runtime</button>
            <button type="button" data-active={tab === "ads"} onClick={() => setTab("ads")}>Ads</button>
          </nav>

          <section className="workspaceContent">
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
                      <h2>Control Room Overview</h2>
                      <p>Health and routing snapshot inspired by live control-room workflows.</p>
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
                  </div>
                </section>

                <section className="workspaceSection">
                  <header className="workspaceSection__head">
                    <div>
                      <h2>Live Output Monitor</h2>
                      <p>Real-time feed view using Livepeer when enabled, otherwise HLS stream.</p>
                    </div>
                    <div className="workspaceHead__actions">
                      <button className="uiButton uiButton--secondary" type="button" onClick={() => void onProvisionLivepeer()} disabled={busy}>
                        Provision Livepeer
                      </button>
                      <button
                        className="uiButton uiButton--secondary"
                        type="button"
                        onClick={() => void onToggleLivepeer(!(detail.livepeer?.enabled ?? false))}
                        disabled={busy}
                      >
                        {detail.livepeer?.enabled ? "Disable Livepeer" : "Enable Livepeer"}
                      </button>
                    </div>
                  </header>
                  <div className="workspaceSection__body">
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
                  </div>
                </section>

                <section className="workspaceSection">
                  <header className="workspaceSection__head">
                    <div>
                      <h2>Timeline</h2>
                      <p>Current progress and sequence context for playout.</p>
                    </div>
                    <div className="workspaceHead__actions">
                      <button className="uiButton uiButton--secondary" type="button" onClick={() => void onControl("previous")} disabled={busy}>
                        Previous
                      </button>
                      <button className="uiButton uiButton--secondary" type="button" onClick={() => void onControl("skip")} disabled={busy}>
                        Skip
                      </button>
                    </div>
                  </header>
                  <div className="workspaceSection__body">
                    <section className="timelineBand">
                      <div className="timelineBand__group">
                        <h4>Previously Played</h4>
                        {timeline.previous.length === 0 ? <p className="emptyState">No history yet.</p> : null}
                        {timeline.previous.length > 0 ? (
                          <ol>
                            {timeline.previous.map((asset, index) => (
                              <li key={`${asset.id}-prev-${index}`}>{asset.title}</li>
                            ))}
                          </ol>
                        ) : null}
                      </div>

                      <div className="timelineBand__group">
                        <h4>Now Playing</h4>
                        <p className="dataRow__title">{timeline.current?.title ?? "Nothing live right now"}</p>
                        <p className="dataRow__meta">
                          {timeline.current
                            ? `${timeline.current.insertionCategory ?? timeline.current.type} · ${formatDuration(timeline.current.durationSec)}`
                            : "Queue content and go live."}
                        </p>
                        <div className="progressBar">
                          <span style={{ width: `${timeline.progressPct}%` }} />
                        </div>
                      </div>

                      <div className="timelineBand__group">
                        <h4>Up Next</h4>
                        {timeline.next.length === 0 ? <p className="emptyState">No upcoming items.</p> : null}
                        {timeline.next.length > 0 ? (
                          <ol>
                            {timeline.next.map((asset, index) => (
                              <li key={`${asset.id}-next-${index}`}>{asset.title}</li>
                            ))}
                          </ol>
                        ) : null}
                      </div>
                    </section>
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
                                    className="uiButton uiButton--secondary"
                                    type="button"
                                    disabled={busy || index === 0}
                                    onClick={() => moveDraftItem(index, -1)}
                                  >
                                    Up
                                  </button>
                                  <button
                                    className="uiButton uiButton--secondary"
                                    type="button"
                                    disabled={busy || index === queuePreview.length - 1}
                                    onClick={() => moveDraftItem(index, 1)}
                                  >
                                    Down
                                  </button>
                                  <button className="uiButton uiButton--danger" type="button" disabled={busy} onClick={() => removeDraftItem(index)}>
                                    Remove
                                  </button>
                                </div>
                              </article>
                            ))}
                          </div>
                        ) : null}
                        <button className="uiButton uiButton--accent" type="button" onClick={() => void onSaveQueue()} disabled={busy}>
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
                        Add Schedule
                      </button>
                      <button className="uiButton uiButton--accent" type="button" onClick={() => void onStartAlwaysOnNow()} disabled={busy}>
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
      </section>

      <OverlayPanel open={railOpen} onClose={() => setRailOpen(false)} title="Station Snapshot" mode="left">
        {rail}
      </OverlayPanel>

      <OverlayPanel open={scheduleModalOpen} onClose={() => setScheduleModalOpen(false)} title="Create Runtime Schedule" mode="center">
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
          <div className="pageBanner__actions">
            <button className="uiButton uiButton--accent" type="submit" disabled={busy || !scheduleStart}>
              Create Schedule
            </button>
            <button className="uiButton uiButton--secondary" type="button" onClick={() => setScheduleModalOpen(false)}>
              Cancel
            </button>
          </div>
        </form>
      </OverlayPanel>

      <OverlayPanel open={importProgramsModalOpen} onClose={() => setImportProgramsModalOpen(false)} title="Import Programs" mode="center">
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
          <div className="pageBanner__actions">
            <button
              className="uiButton uiButton--accent"
              type="button"
              onClick={() => void onImportLibraryAssets(selectedLibraryPrograms)}
              disabled={busy || selectedLibraryPrograms.length === 0 || !ownerWallet}
            >
              Import Selected Programs
            </button>
            <button className="uiButton uiButton--secondary" type="button" onClick={() => setImportProgramsModalOpen(false)}>
              Cancel
            </button>
          </div>
        </div>
      </OverlayPanel>

      <OverlayPanel open={importAdsModalOpen} onClose={() => setImportAdsModalOpen(false)} title="Import Ads / Sponsors" mode="center">
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
          <div className="pageBanner__actions">
            <button
              className="uiButton uiButton--accent"
              type="button"
              onClick={() => void onImportLibraryAssets(selectedLibraryAds)}
              disabled={busy || selectedLibraryAds.length === 0 || !ownerWallet}
            >
              Import Selected Ads
            </button>
            <button className="uiButton uiButton--secondary" type="button" onClick={() => setImportAdsModalOpen(false)}>
              Cancel
            </button>
          </div>
        </div>
      </OverlayPanel>
    </main>
  );
}
