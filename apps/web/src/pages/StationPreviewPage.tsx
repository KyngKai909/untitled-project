import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { getApiBase, getChannelDetail, getChannelStatus } from "../api";
import HlsPlayer from "../components/HlsPlayer";
import type { Asset, ChannelDetail } from "../types";

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

function formatDateTime(iso: string | undefined): string {
  if (!iso) {
    return "--";
  }
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) {
    return "--";
  }
  return new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
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
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  }
  return `${minutes}:${String(secs).padStart(2, "0")}`;
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

function areStreamUrlsEquivalent(left: string, right: string): boolean {
  try {
    const leftUrl = new URL(left, "http://localhost");
    const rightUrl = new URL(right, "http://localhost");
    return leftUrl.origin === rightUrl.origin && leftUrl.pathname === rightUrl.pathname;
  } catch {
    return left.split("?")[0] === right.split("?")[0];
  }
}

interface GuideEntry {
  asset: Asset;
  slot: number;
  isNow: boolean;
  durationSec?: number;
  startMs?: number;
  endMs?: number;
}

export default function StationPreviewPage() {
  const { channelId } = useParams();
  const [detail, setDetail] = useState<ChannelDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [initialLoading, setInitialLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [shareMessage, setShareMessage] = useState<string | null>(null);
  const [stableStreamUrl, setStableStreamUrl] = useState("");

  const load = useCallback(
    async (background: boolean) => {
      if (!channelId) {
        return;
      }

      if (background) {
        setRefreshing(true);
      } else {
        setInitialLoading(true);
      }

      try {
        const [station, status] = await Promise.all([
          getChannelDetail(channelId),
          getChannelStatus(channelId).catch(() => null)
        ]);

        setDetail({
          ...station,
          state: status?.state ?? station.state,
          livepeer: status?.livepeer ?? station.livepeer,
          streamUrl: status?.streamUrl ?? station.streamUrl
        });
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load station preview");
      } finally {
        if (background) {
          setRefreshing(false);
        } else {
          setInitialLoading(false);
        }
      }
    },
    [channelId]
  );

  useEffect(() => {
    void load(false);
  }, [load]);

  useEffect(() => {
    if (!channelId) {
      return;
    }

    const timer = setInterval(() => {
      void load(true);
    }, 10_000);

    return () => clearInterval(timer);
  }, [channelId, load]);

  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!shareMessage) {
      return;
    }
    const timer = setTimeout(() => setShareMessage(null), 2000);
    return () => clearTimeout(timer);
  }, [shareMessage]);

  const streamUrl = useMemo(() => {
    if (!channelId || !detail) {
      return "";
    }
    return resolveStreamUrl(channelId, detail);
  }, [channelId, detail]);

  useEffect(() => {
    if (!streamUrl) {
      return;
    }
    setStableStreamUrl((current) => {
      if (!current) {
        return streamUrl;
      }
      if (areStreamUrlsEquivalent(current, streamUrl)) {
        return current;
      }
      return streamUrl;
    });
  }, [streamUrl]);

  const livepeerEmbedUrl = useMemo(
    () => toLivepeerEmbedUrl(detail?.livepeer?.enabled ? detail.livepeer.playbackId : undefined),
    [detail]
  );

  const programLineup = useMemo(() => {
    return detail ? detail.playlist.map((item) => item.asset).filter((asset) => asset.type === "program") : [];
  }, [detail]);

  const currentProgramIndex = useMemo(() => {
    if (!detail || !programLineup.length) {
      return undefined;
    }
    const normalizedQueueIndex = mod(detail.state.queueIndex, programLineup.length);
    const ids = programLineup.map((asset) => asset.id);
    return findClosestIndex(ids, detail.state.currentAssetId, normalizedQueueIndex) ?? normalizedQueueIndex;
  }, [detail, programLineup]);

  const guideEntries = useMemo(() => {
    if (!detail || !programLineup.length) {
      return [] as GuideEntry[];
    }

    const startIndex = currentProgramIndex ?? mod(detail.state.queueIndex, programLineup.length);
    const rawStartedMs = toMs(detail.state.currentStartedAt);
    const currentOffsetSec = Math.max(0, Math.floor(detail.state.currentProgramOffsetSec ?? 0));
    const currentAssetStartMs = rawStartedMs !== undefined ? rawStartedMs - currentOffsetSec * 1000 : undefined;
    let cursorMs = currentAssetStartMs;

    const entries: GuideEntry[] = [];
    const count = Math.min(programLineup.length, 12);

    for (let slot = 0; slot < count; slot += 1) {
      const asset = programLineup[mod(startIndex + slot, programLineup.length)];
      const durationSec = asset.durationSec && asset.durationSec > 0 ? Math.floor(asset.durationSec) : undefined;
      const startMs = cursorMs;
      const endMs = durationSec !== undefined && cursorMs !== undefined ? cursorMs + durationSec * 1000 : undefined;

      entries.push({
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

    return entries;
  }, [currentProgramIndex, detail, programLineup]);

  const nowPlaying = guideEntries[0];
  const currentStartMs = toMs(detail?.state.currentStartedAt);

  const playbackProgress = useMemo(() => {
    if (!detail || !nowPlaying?.durationSec || !currentStartMs) {
      return { percent: 0, elapsedSec: undefined as number | undefined, remainingSec: undefined as number | undefined };
    }
    const offsetSec = Math.max(0, Math.floor(detail.state.currentProgramOffsetSec ?? 0));
    const elapsedSec = Math.max(0, Math.floor((nowMs - currentStartMs) / 1000) + offsetSec);
    const boundedElapsed = Math.min(elapsedSec, nowPlaying.durationSec);
    const remainingSec = Math.max(0, nowPlaying.durationSec - boundedElapsed);
    return {
      percent: Math.min(100, (boundedElapsed / nowPlaying.durationSec) * 100),
      elapsedSec: boundedElapsed,
      remainingSec
    };
  }, [currentStartMs, detail, nowMs, nowPlaying]);

  const guideDateLabel = useMemo(() => {
    return formatDateFromMs(nowPlaying?.startMs ?? currentStartMs);
  }, [currentStartMs, nowPlaying]);

  async function onCopyShareLink() {
    if (typeof window === "undefined") {
      return;
    }
    try {
      await navigator.clipboard.writeText(window.location.href);
      setShareMessage("Share link copied.");
    } catch {
      setShareMessage("Unable to copy link.");
    }
  }

  if (!channelId) {
    return (
      <main className="routeFrame watchPage">
        <div className="inlineAlert inlineAlert--error">Channel id is missing.</div>
      </main>
    );
  }

  return (
    <main className="routeFrame watchPage">
      <section className="watchBroadcast">
        <header className="watchBroadcast__head">
          <div>
            <div className="pageBanner__meta">
              <span className="miniTag miniTag--accent">Public Stream Viewer</span>
              {detail ? (
                <span className={`statusPill ${detail.state.isRunning ? "statusPill--live" : "statusPill--off"}`}>
                  {detail.state.isRunning ? "Live" : "Off Air"}
                </span>
              ) : (
                <span className="statusPill">Connecting</span>
              )}
              {refreshing ? <span className="miniTag">Refreshing</span> : null}
            </div>
            <h1>{detail?.channel.name ?? "Loading Broadcast"}</h1>
            <p>
              {detail?.channel.description?.trim() ||
                "Share this page for viewers to watch live playback, track what is on now, and follow the lineup guide."}
            </p>
          </div>
          <div className="watchBroadcast__actions">
            <button className="uiButton uiButton--accent" type="button" onClick={() => void onCopyShareLink()}>
              Share Stream
            </button>
            <Link className="uiButton uiButton--secondary" to={`/stations/${channelId}`}>
              Open Studio
            </Link>
            <Link className="uiButton uiButton--secondary" to="/dashboard">
              Workspace
            </Link>
          </div>
        </header>
        <div className="watchBroadcast__player">
          {initialLoading && !detail ? (
            <p className="loadingState">Loading broadcast...</p>
          ) : livepeerEmbedUrl ? (
            <div className="mediaShell">
              <iframe
                src={livepeerEmbedUrl}
                title="Livepeer Player"
                allow="autoplay; fullscreen; picture-in-picture"
              />
            </div>
          ) : stableStreamUrl || streamUrl ? (
            <HlsPlayer src={stableStreamUrl || streamUrl} muted={false} />
          ) : (
            <p className="emptyState">No stream URL available yet.</p>
          )}
        </div>
        <section className="watchNow">
          <div className="watchNow__title">
            <h2>{detail?.state.currentAssetTitle ?? nowPlaying?.asset.title ?? "No Program Live Right Now"}</h2>
            <p>
              {nowPlaying?.durationSec
                ? `${formatDuration(nowPlaying.durationSec)} total · started ${formatTimeFromMs(
                    nowPlaying.startMs ?? currentStartMs
                  )}`
                : "Program timing appears when the playlist is active."}
            </p>
          </div>
          <div className="watchNow__meter">
            <p className="metaLine">
              <span>Elapsed {formatDuration(playbackProgress.elapsedSec)}</span>
              <span>Remaining {formatDuration(playbackProgress.remainingSec)}</span>
            </p>
            <div className="progressBar">
              <span style={{ width: `${playbackProgress.percent}%` }} />
            </div>
          </div>
          {shareMessage ? <p className="watchFlash">{shareMessage}</p> : null}
        </section>
      </section>

      {error ? <div className="inlineAlert inlineAlert--error">{error}</div> : null}

      <section className="watchGrid">
        <section className="watchPanel">
          <header className="watchPanel__head">
            <div>
              <h2>Program Guide</h2>
              <p>{guideDateLabel}</p>
            </div>
          </header>
          <div className="watchPanel__body">
            {guideEntries.length === 0 ? (
              <p className="emptyState">No lineup available yet. Add programs in studio to populate this guide.</p>
            ) : (
              <div className="guideTable" role="table" aria-label="Program Guide">
                <div className="guideRow guideRow--head" role="row">
                  <p>Time</p>
                  <p>Program</p>
                  <p>Length</p>
                  <p>Status</p>
                </div>
                {guideEntries.map((entry) => (
                  <article className={`guideRow ${entry.isNow ? "guideRow--live" : ""}`} key={`${entry.asset.id}-${entry.slot}`} role="row">
                    <p>
                      {formatTimeFromMs(entry.startMs)} - {formatTimeFromMs(entry.endMs)}
                    </p>
                    <p className="guideRow__title">{entry.asset.title}</p>
                    <p>{formatDuration(entry.durationSec)}</p>
                    <p>{entry.isNow ? "Now" : "Up Next"}</p>
                  </article>
                ))}
              </div>
            )}
          </div>
        </section>

        <aside className="watchRail">
          <section className="watchPanel">
            <header className="watchPanel__head">
              <div>
                <h2>Station Info</h2>
                <p>Channel metadata and runtime snapshot.</p>
              </div>
            </header>
            <div className="watchPanel__body">
              <dl className="watchInfoList">
                <div>
                  <dt>Stream Mode</dt>
                  <dd>{detail?.channel.streamMode ?? "--"}</dd>
                </div>
                <div>
                  <dt>Output Route</dt>
                  <dd>{detail?.livepeer?.enabled ? "Livepeer" : "Direct HLS"}</dd>
                </div>
                <div>
                  <dt>Started</dt>
                  <dd>{formatDateTime(detail?.state.currentStartedAt)}</dd>
                </div>
                <div>
                  <dt>Updated</dt>
                  <dd>{formatDateTime(detail?.state.updatedAt)}</dd>
                </div>
              </dl>
            </div>
          </section>

          <section className="watchPanel">
            <header className="watchPanel__head">
              <div>
                <h2>Comments</h2>
                <p>Placeholder viewer chat feed.</p>
              </div>
            </header>
            <div className="watchPanel__body">
              <div className="watchComments">
                <article className="watchComment">
                  <p className="watchComment__author">viewer_204</p>
                  <p>Clean pacing on this segment. Audio/video sync looks good.</p>
                </article>
                <article className="watchComment">
                  <p className="watchComment__author">mediafan88</p>
                  <p>Guide timing is super helpful for following what is next.</p>
                </article>
                <article className="watchComment">
                  <p className="watchComment__author">openstream-labs</p>
                  <p>Waiting for comments auth to go live.</p>
                </article>
              </div>
              <div className="watchCommentComposer">
                <input className="uiInput" value="Sign in required to comment (placeholder)." readOnly />
                <button className="uiButton uiButton--secondary" type="button" disabled>
                  Send
                </button>
              </div>
            </div>
          </section>
        </aside>
      </section>
    </main>
  );
}
