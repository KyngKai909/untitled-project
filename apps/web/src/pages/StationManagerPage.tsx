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
      <main className="page">
        <div className="alert" data-tone="error">Channel id is missing.</div>
      </main>
    );
  }

  return (
    <main className="page">
      <section className="pageHero">
        <div className="pageHero__meta">
          <span className="microTag" data-tone="accent">Station Manager</span>
          <span className="microTag">ID {channelId.slice(0, 8)}</span>
        </div>
        <h1>{detail?.channel.name ?? "Loading station"}</h1>
        <p>Control playlists, schedules, ad logic, and output routing from one production console.</p>
        <div className="pageHero__actions">
          <Link className="button" data-variant="secondary" to="/dashboard">Back to Dashboard</Link>
          <Link className="button" data-variant="secondary" to={`/stations/${channelId}/preview`}>Open Preview</Link>
        </div>
        {detail ? (
          <p className="metaLine">
            <span className="badge" data-tone={detail.state.isRunning ? "live" : "off"}>
              {detail.state.isRunning ? "Live" : "Off Air"}
            </span>
            {timeline.current ? <span>Now: {timeline.current.title}</span> : <span>Waiting for next item</span>}
            {timeline.remainingSec !== undefined ? <span>Remaining {formatDuration(timeline.remainingSec)}</span> : null}
          </p>
        ) : null}
      </section>

      {error ? (
        <div className="alert" data-tone="error">
          {error}
        </div>
      ) : null}
      {info ? (
        <div className="alert" data-tone="info">
          {info}
        </div>
      ) : null}

      {loading || !detail ? (
        <section className="section">
          <div className="section__body">
            <p className="loading">Loading station...</p>
          </div>
        </section>
      ) : (
        <>
          <div className="grid2">
            <section className="section">
              <header className="section__head">
                <div>
                  <h2>Station Profile</h2>
                  <p>Metadata and stream mode settings for this station.</p>
                </div>
              </header>
              <div className="section__body">
                <label className="field">
                  <span>Station Name</span>
                  <input value={name} onChange={(event) => setName(event.target.value)} disabled={busy} />
                </label>

                <label className="field">
                  <span>Description</span>
                  <textarea value={description} onChange={(event) => setDescription(event.target.value)} disabled={busy} />
                </label>

                <label className="field">
                  <span>Stream Mode</span>
                  <select
                    value={streamMode}
                    onChange={(event) => setStreamMode(event.target.value === "radio" ? "radio" : "video")}
                    disabled={busy}
                  >
                    <option value="video">Video</option>
                    <option value="radio">Radio</option>
                  </select>
                </label>

                <div className="pageHero__actions">
                  <button className="button" data-variant="accent" onClick={() => void onSaveStationProfile()} disabled={busy}>
                    Save Station
                  </button>
                </div>
              </div>
            </section>

            <section className="section">
              <header className="section__head">
                <div>
                  <h2>Live Output</h2>
                  <p>{streamUrl || "No stream URL yet"}</p>
                </div>
              </header>
              <div className="section__body">
                <div className="pageHero__actions">
                  <button className="button" data-variant="secondary" onClick={() => void onProvisionLivepeer()} disabled={busy}>
                    Provision Livepeer
                  </button>
                  <button
                    className="button"
                    data-variant="secondary"
                    onClick={() => void onToggleLivepeer(!(detail.livepeer?.enabled ?? false))}
                    disabled={busy}
                  >
                    {detail.livepeer?.enabled ? "Disable Livepeer" : "Enable Livepeer"}
                  </button>
                </div>

                <div className="pageHero__actions">
                  <button className="button" data-variant="accent" onClick={() => void onControl("start")} disabled={busy}>Go Live</button>
                  <button className="button" data-variant="secondary" onClick={() => void onControl("previous")} disabled={busy}>Previous</button>
                  <button className="button" data-variant="secondary" onClick={() => void onControl("skip")} disabled={busy}>Skip</button>
                  <button className="button" data-variant="danger" onClick={() => void onControl("stop")} disabled={busy}>Stop</button>
                </div>

                {livepeerEmbedUrl ? (
                  <div className="mediaFrame">
                    <iframe
                      src={livepeerEmbedUrl}
                      title="Livepeer Player"
                      allow="autoplay; fullscreen; picture-in-picture"
                    />
                  </div>
                ) : streamUrl ? (
                  <HlsPlayer src={streamUrl} muted />
                ) : (
                  <p className="empty">Stream URL not available.</p>
                )}
              </div>
            </section>
          </div>

          <div className="grid2">
            <section className="section">
              <header className="section__head">
                <div>
                  <h2>Playlist Timeline</h2>
                  <p>Previous, current, and upcoming items from active playout state.</p>
                </div>
              </header>
              <div className="section__body">
                <div className="timelineRail">
                  <div className="timelineRail__group">
                    <h4>Previously Played</h4>
                    {timeline.previous.length === 0 ? <p className="empty">No history yet.</p> : null}
                    {timeline.previous.length > 0 ? (
                      <ol>
                        {timeline.previous.map((asset, index) => (
                          <li key={`${asset.id}-prev-${index}`}>{asset.title}</li>
                        ))}
                      </ol>
                    ) : null}
                  </div>

                  <div className="timelineRail__group">
                    <h4>Now Playing</h4>
                    <p className="row__title">{timeline.current?.title ?? "Nothing live right now"}</p>
                    <p className="row__meta">
                      {timeline.current
                        ? `${timeline.current.insertionCategory ?? timeline.current.type} · ${formatDuration(timeline.current.durationSec)}`
                        : "Queue a playlist and go live."}
                      {timeline.remainingSec !== undefined ? ` · ${formatDuration(timeline.remainingSec)} left` : ""}
                    </p>
                    <div className="progressTrack">
                      <span style={{ width: `${timeline.progressPct}%` }} />
                    </div>
                  </div>

                  <div className="timelineRail__group">
                    <h4>Up Next</h4>
                    {timeline.next.length === 0 ? <p className="empty">No upcoming items.</p> : null}
                    {timeline.next.length > 0 ? (
                      <ol>
                        {timeline.next.map((asset, index) => (
                          <li key={`${asset.id}-next-${index}`}>{asset.title}</li>
                        ))}
                      </ol>
                    ) : null}
                  </div>
                </div>
              </div>
            </section>

            <section className="section">
              <header className="section__head">
                <div>
                  <h2>Playlist Builder</h2>
                  <p>Append station programs to draft queue, reorder, then push live.</p>
                </div>
              </header>
              <div className="section__body">
                <div className="stack">
                  <p className="microTag">Station Programs</p>
                  {stationPrograms.length === 0 ? <p className="empty">Import programs from global library first.</p> : null}
                  {stationPrograms.length > 0 ? (
                    <div className="list">
                      {stationPrograms.map((asset) => (
                        <article key={asset.id} className="row">
                          <div>
                            <p className="row__title">{asset.title}</p>
                            <p className="row__meta">{formatDuration(asset.durationSec)}</p>
                          </div>
                          <div className="row__actions">
                            <button className="button" data-variant="secondary" onClick={() => addProgramToDraft(asset.id)} disabled={busy}>
                              Add
                            </button>
                          </div>
                        </article>
                      ))}
                    </div>
                  ) : null}
                </div>

                <div className="stack">
                  <p className="microTag">Draft Playlist</p>
                  {queuePreview.length === 0 ? <p className="empty">Draft queue is empty.</p> : null}
                  {queuePreview.length > 0 ? (
                    <div className="list">
                      {queuePreview.map((asset, index) => (
                        <article key={`${asset.id}-${index}`} className="row">
                          <div>
                            <p className="row__title">{index + 1}. {asset.title}</p>
                            <p className="row__meta">{formatDuration(asset.durationSec)}</p>
                          </div>
                          <div className="row__actions">
                            <button
                              className="button"
                              data-variant="secondary"
                              disabled={busy || index === 0}
                              onClick={() => moveDraftItem(index, -1)}
                            >
                              Up
                            </button>
                            <button
                              className="button"
                              data-variant="secondary"
                              disabled={busy || index === queuePreview.length - 1}
                              onClick={() => moveDraftItem(index, 1)}
                            >
                              Down
                            </button>
                            <button className="button" data-variant="danger" disabled={busy} onClick={() => removeDraftItem(index)}>
                              Remove
                            </button>
                          </div>
                        </article>
                      ))}
                    </div>
                  ) : null}
                </div>

                <div className="pageHero__actions">
                  <button className="button" data-variant="accent" onClick={() => void onSaveQueue()} disabled={busy}>
                    Push Playlist to Stream
                  </button>
                </div>
              </div>
            </section>
          </div>

          <div className="grid2">
            <section className="section">
              <header className="section__head">
                <div>
                  <h2>Schedule Runtime</h2>
                  <p>Create run windows or switch directly to always-on mode.</p>
                </div>
                <button className="button" data-variant="secondary" onClick={() => void onStartAlwaysOnNow()} disabled={busy}>
                  Start 24/7 Now
                </button>
              </header>
              <div className="section__body">
                <form className="stack" onSubmit={(event) => void onCreateSchedule(event)}>
                  <label className="field">
                    <span>Start Time</span>
                    <input
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
                      type="datetime-local"
                      value={scheduleEnd}
                      onChange={(event) => setScheduleEnd(event.target.value)}
                      disabled={busy}
                    />
                  </label>

                  <div className="pageHero__actions">
                    <button className="button" data-variant="accent" type="submit" disabled={busy || !scheduleStart}>
                      Create Schedule
                    </button>
                  </div>
                </form>
              </div>
            </section>

            <section className="section">
              <header className="section__head">
                <div>
                  <h2>Active Schedules</h2>
                  <p>Ordered by start time ascending.</p>
                </div>
              </header>
              <div className="section__body">
                {detail.schedules.length === 0 ? <p className="empty">No schedules yet.</p> : null}
                {detail.schedules.length > 0 ? (
                  <div className="list">
                    {[...detail.schedules]
                      .sort((left, right) => Date.parse(left.startAt) - Date.parse(right.startAt))
                      .map((schedule) => (
                        <article key={schedule.id} className="row">
                          <div>
                            <p className="row__title">{formatDateTime(schedule.startAt)}</p>
                            <p className="row__meta">
                              {schedule.endAt ? `Ends ${formatDateTime(schedule.endAt)}` : "24/7 (no end)"}
                            </p>
                          </div>
                          <div className="row__actions">
                            <button
                              className="button"
                              data-variant="danger"
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
          </div>

          <div className="grid2">
            <section className="section">
              <header className="section__head">
                <div>
                  <h2>Import Programs</h2>
                  <p>Select programs from creator global library and add them to this station.</p>
                </div>
                <button
                  className="button"
                  data-variant="secondary"
                  onClick={() => void refreshLibrary(ownerWallet)}
                  disabled={loadingLibrary}
                >
                  {loadingLibrary ? "Refreshing" : "Refresh"}
                </button>
              </header>
              <div className="section__body">
                {globalProgramLibrary.length === 0 ? <p className="empty">No global programs available.</p> : null}
                {globalProgramLibrary.length > 0 ? (
                  <div className="list">
                    {globalProgramLibrary.map((asset) => {
                      const checked = selectedLibraryPrograms.includes(asset.id);
                      return (
                        <label key={asset.id} className="checkboxRow">
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={(event) => toggleLibraryProgram(asset.id, event.target.checked)}
                            disabled={busy}
                          />
                          <span className="checkboxRow__title">{asset.title}</span>
                          <span className="checkboxRow__meta">{formatDuration(asset.durationSec)}</span>
                        </label>
                      );
                    })}
                  </div>
                ) : null}

                <div className="pageHero__actions">
                  <button
                    className="button"
                    data-variant="accent"
                    onClick={() => void onImportLibraryAssets(selectedLibraryPrograms)}
                    disabled={busy || selectedLibraryPrograms.length === 0 || !ownerWallet}
                  >
                    Import Selected Programs
                  </button>
                </div>
              </div>
            </section>

            <section className="section">
              <header className="section__head">
                <div>
                  <h2>Ads, Sponsors, Bumpers</h2>
                  <p>Set insertion policy and station ad pool.</p>
                </div>
              </header>
              <div className="section__body">
                <div className="stack">
                  <p className="microTag">Injection Rules</p>

                  <label className="field">
                    <span>Trigger Mode</span>
                    <select
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
                      <span>Interval (Programs)</span>
                      <input
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
                      <span>Interval (Seconds)</span>
                      <input
                        type="number"
                        min={30}
                        value={adTimeIntervalSec}
                        onChange={(event) => setAdTimeIntervalSec(Number(event.target.value || 30))}
                        disabled={busy}
                      />
                    </label>
                  ) : null}

                  <div className="pageHero__actions">
                    <button className="button" data-variant="accent" onClick={() => void onSaveAdRules()} disabled={busy}>
                      Save Injection Rules
                    </button>
                  </div>
                </div>

                <div className="stack">
                  <p className="microTag">Import Global Ad Assets</p>
                  {globalAdLibrary.length === 0 ? <p className="empty">No global ads, sponsors, or bumpers yet.</p> : null}

                  {globalAdLibrary.length > 0 ? (
                    <div className="list">
                      {globalAdLibrary.map((asset) => {
                        const checked = selectedLibraryAds.includes(asset.id);
                        return (
                          <label key={asset.id} className="checkboxRow">
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={(event) => toggleLibraryAd(asset.id, event.target.checked)}
                              disabled={busy}
                            />
                            <span className="checkboxRow__title">{asset.title}</span>
                            <span className="checkboxRow__meta">{asset.insertionCategory ?? "ad"}</span>
                          </label>
                        );
                      })}
                    </div>
                  ) : null}

                  <div className="pageHero__actions">
                    <button
                      className="button"
                      data-variant="accent"
                      onClick={() => void onImportLibraryAssets(selectedLibraryAds)}
                      disabled={busy || selectedLibraryAds.length === 0 || !ownerWallet}
                    >
                      Import Selected Ads
                    </button>
                  </div>
                </div>

                <div className="stack">
                  <p className="microTag">Station Ad Pool</p>
                  {stationAds.length === 0 ? <p className="empty">No ad assets in this station.</p> : null}
                  {stationAds.length > 0 ? (
                    <div className="list">
                      {stationAds.map((asset) => (
                        <article key={asset.id} className="row">
                          <div>
                            <p className="row__title">{asset.title}</p>
                            <p className="row__meta">
                              {asset.insertionCategory ?? "ad"} · {formatDuration(asset.durationSec)}
                            </p>
                          </div>
                          <div className="row__actions">
                            <button
                              className="button"
                              data-variant="danger"
                              onClick={() => void onDeleteAsset(asset.id)}
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
              </div>
            </section>
          </div>
        </>
      )}
    </main>
  );
}
