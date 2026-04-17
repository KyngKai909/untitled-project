import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { getApiBase, getChannelDetail, getChannelStatus } from "../api";
import AppIcon from "../components/AppIcon";
import HlsPlayer from "../components/HlsPlayer";
import OverlayPanel from "../components/OverlayPanel";
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

type VoteDirection = "previous" | "next";
type MulticastStatus = "live" | "standby" | "idle";

interface MulticastDestination {
  id: string;
  name: string;
  wordmark: string;
  handle: string;
  region: string;
  viewers: number;
  active: boolean;
  status: MulticastStatus;
}

const MULTICAST_DESTINATIONS: MulticastDestination[] = [
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

export default function StationPreviewPage() {
  const { channelId } = useParams();
  const [detail, setDetail] = useState<ChannelDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [initialLoading, setInitialLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [shareMessage, setShareMessage] = useState<string | null>(null);
  const [stableStreamUrl, setStableStreamUrl] = useState("");
  const [voteModalOpen, setVoteModalOpen] = useState(false);
  const [voteDirection, setVoteDirection] = useState<VoteDirection>("next");
  const [voteSubmitted, setVoteSubmitted] = useState(false);
  const [voteTally, setVoteTally] = useState({ previous: 38, next: 67 });
  const [multicastModalOpen, setMulticastModalOpen] = useState(false);
  const [multicastDestinations, setMulticastDestinations] = useState<MulticastDestination[]>(MULTICAST_DESTINATIONS);

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

  const previousProgram = useMemo(() => {
    if (!programLineup.length) {
      return undefined;
    }
    const index = currentProgramIndex ?? 0;
    return programLineup[mod(index - 1, programLineup.length)];
  }, [currentProgramIndex, programLineup]);

  const nextProgram = guideEntries[1]?.asset;
  const voteWindowSeconds = nowPlaying?.durationSec ?? 0;
  const votePeakConcurrent = useMemo(() => {
    if (!voteWindowSeconds) {
      return 0;
    }
    const durationMinutes = voteWindowSeconds / 60;
    const queueFactor = Math.max(0, Math.min(20, programLineup.length));
    const estimate = Math.round(42 + durationMinutes * 3.6 + queueFactor);
    return Math.max(24, Math.min(500, estimate));
  }, [programLineup.length, voteWindowSeconds]);
  const voteSupermajorityRequired = votePeakConcurrent > 0 ? Math.ceil(votePeakConcurrent * 0.66) : 0;
  const voteTarget = voteDirection === "next" ? nextProgram : previousProgram;
  const voteTotal = voteTally.previous + voteTally.next;
  const previousVotePct = voteSupermajorityRequired > 0 ? Math.min(100, Math.round((voteTally.previous / voteSupermajorityRequired) * 100)) : 0;
  const nextVotePct = voteSupermajorityRequired > 0 ? Math.min(100, Math.round((voteTally.next / voteSupermajorityRequired) * 100)) : 0;
  const previousVotesNeeded = Math.max(0, voteSupermajorityRequired - voteTally.previous);
  const nextVotesNeeded = Math.max(0, voteSupermajorityRequired - voteTally.next);
  const selectedVotes = voteDirection === "next" ? voteTally.next : voteTally.previous;
  const selectedVotesNeeded = voteDirection === "next" ? nextVotesNeeded : previousVotesNeeded;
  const selectedDirectionLabel = voteDirection === "next" ? "Next" : "Previous";
  const activeMulticast = useMemo(() => multicastDestinations.filter((destination) => destination.active), [multicastDestinations]);
  const liveMulticast = useMemo(() => activeMulticast.filter((destination) => destination.status === "live"), [activeMulticast]);
  const totalMulticastViewers = useMemo(
    () => activeMulticast.reduce((total, destination) => total + destination.viewers, 0),
    [activeMulticast]
  );

  function toggleMulticastDestination(destinationId: string) {
    setMulticastDestinations((current) =>
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

  function cycleMulticastState(destinationId: string) {
    setMulticastDestinations((current) =>
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

  function multicastStatusLabel(destination: MulticastDestination): string {
    if (!destination.active) {
      return "Disabled";
    }
    if (destination.status === "live") {
      return "Live";
    }
    return "Standby";
  }

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

  function openVoteModal(direction: VoteDirection) {
    setVoteDirection(direction);
    setVoteSubmitted(false);
    setVoteModalOpen(true);
  }

  function onSubmitVote() {
    setVoteTally((current) => ({
      ...current,
      [voteDirection]: current[voteDirection] + 1
    }));
    setVoteSubmitted(true);
  }

  if (!channelId) {
    return (
      <main className="routeFrame routeFrame--workspace watchPage">
        <div className="inlineAlert inlineAlert--error">Channel id is missing.</div>
      </main>
    );
  }

  return (
    <main className="routeFrame routeFrame--workspace watchPage">
      {error ? <div className="inlineAlert inlineAlert--error">{error}</div> : null}

      <section className="watchGrid">
        <section className="watchMainColumn">
          <section className="watchBroadcast">
            <div className="watchBroadcast__player">
              <div className="watchPlayerFrame">
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
            </div>

            <section className="watchNow">
              <div className="watchNow__top">
                <div className="watchNow__identity">
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
                <div className="watchNow__actions">
                  <button className="uiButton uiButton--accent" type="button" onClick={() => void onCopyShareLink()}>
                    <AppIcon name="upload" />
                    Share Stream
                  </button>
                  <Link className="uiButton uiButton--secondary" to={`/stations/${channelId}`}>
                    <AppIcon name="monitor" />
                    Open Studio
                  </Link>
                </div>
              </div>

              <div className="watchNow__playing">
                <p className="watchNow__kicker">Now Playing</p>
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

          <section className="watchPanel watchPanel--comments">
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
                  <AppIcon name="send" />
                  Send
                </button>
              </div>
            </div>
          </section>
        </section>

        <aside className="watchRail">
          <section className="watchPanel watchPanel--vote">
            <header className="watchPanel__head">
              <div>
                <h2>Viewer Vote Controls</h2>
                <p>Supermajority skip prototype tied to peak concurrent viewers.</p>
              </div>
            </header>
            <div className="watchPanel__body">
              <div className="voteRule">
                <p className="voteRule__kicker">Skip Rule</p>
                <p className="voteRule__value">
                  {voteSupermajorityRequired > 0
                    ? `${voteSupermajorityRequired} votes required (66% of peak ${votePeakConcurrent})`
                    : "Waiting for current program to start vote window"}
                </p>
                <p className="voteRule__meta">Vote window = current program length {formatDuration(voteWindowSeconds)}</p>
              </div>

              <div className="voteTally">
                <article>
                  <p className="voteTally__label">Skip To Previous</p>
                  <p className="voteTally__value">
                    {voteTally.previous} / {voteSupermajorityRequired || "--"} · {previousVotePct}%
                  </p>
                  <p className="voteTally__meta">
                    {previousVotesNeeded > 0 ? `${previousVotesNeeded} more votes needed` : "Threshold reached"}
                  </p>
                  <div className="progressBar">
                    <span style={{ width: `${previousVotePct}%` }} />
                  </div>
                </article>
                <article>
                  <p className="voteTally__label">Skip To Next</p>
                  <p className="voteTally__value">
                    {voteTally.next} / {voteSupermajorityRequired || "--"} · {nextVotePct}%
                  </p>
                  <p className="voteTally__meta">
                    {nextVotesNeeded > 0 ? `${nextVotesNeeded} more votes needed` : "Threshold reached"}
                  </p>
                  <div className="progressBar">
                    <span style={{ width: `${nextVotePct}%` }} />
                  </div>
                </article>
              </div>

              <div className="voteActions">
                <button className="uiButton uiButton--secondary" type="button" onClick={() => openVoteModal("previous")}>
                  <AppIcon name="skip-prev" />
                  Vote Previous
                </button>
                <button className="uiButton uiButton--accent" type="button" onClick={() => openVoteModal("next")}>
                  <AppIcon name="skip-next" />
                  Vote Next
                </button>
              </div>

              <p className="emptyState">Prototype only. Skip execution can be wired after telemetry and API integration.</p>
            </div>
          </section>

          <section className="watchPanel watchPanel--multicast">
            <header className="watchPanel__head">
              <div>
                <h2>Multicasting</h2>
                <p>
                  {activeMulticast.length} active destinations · {liveMulticast.length} live right now
                </p>
              </div>
              <button className="uiButton uiButton--secondary" type="button" onClick={() => setMulticastModalOpen(true)}>
                <AppIcon name="list" />
                Manage
              </button>
            </header>
            <div className="watchPanel__body">
              <section className="multicastBoard" aria-label="Multicast Destinations">
                {multicastDestinations.map((destination) => (
                  <article className="multicastRow" key={destination.id}>
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
                        {multicastStatusLabel(destination)}
                      </span>
                      <button className="uiButton uiButton--ghost uiButton--compact" type="button" onClick={() => toggleMulticastDestination(destination.id)}>
                        {destination.active ? "Disable" : "Enable"}
                      </button>
                    </div>
                  </article>
                ))}
              </section>
              <p className="emptyState">
                Prototype only. Destination auth, stream keys, and publish health can be wired to your routing service later.
              </p>
            </div>
          </section>

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
                <section className="guideTable" aria-label="Program Guide">
                  <div className="guideTable__head">
                    <p>Time</p>
                    <p>Program</p>
                    <p>Status</p>
                  </div>
                  <div className="guideTable__body">
                    {guideEntries.map((entry) => (
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
        </aside>
      </section>

      <OverlayPanel
        open={multicastModalOpen}
        onClose={() => setMulticastModalOpen(false)}
        title="Multicast Destinations"
        subtitle="Prototype control center for outbound platform distribution."
        mode="right"
      >
        <div className="multicastModal">
          <section className="multicastOverview">
            <article>
              <h4>Active</h4>
              <p>
                {activeMulticast.length} / {multicastDestinations.length}
              </p>
            </article>
            <article>
              <h4>Live</h4>
              <p>{liveMulticast.length}</p>
            </article>
            <article>
              <h4>Concurrent Viewers</h4>
              <p>{totalMulticastViewers}</p>
            </article>
          </section>

          <section className="multicastStack">
            {multicastDestinations.map((destination) => (
              <article className="multicastCard" key={`modal-${destination.id}`}>
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
                    {multicastStatusLabel(destination)}
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
                  <button className="uiButton uiButton--secondary uiButton--compact" type="button" onClick={() => toggleMulticastDestination(destination.id)}>
                    <AppIcon name={destination.active ? "stop" : "plus"} />
                    {destination.active ? "Disable Route" : "Enable Route"}
                  </button>
                  <button
                    className="uiButton uiButton--ghost uiButton--compact"
                    type="button"
                    onClick={() => cycleMulticastState(destination.id)}
                    disabled={!destination.active}
                  >
                    <AppIcon name={destination.status === "live" ? "refresh" : "zap"} />
                    {destination.status === "live" ? "Move To Standby" : "Mark Live"}
                  </button>
                </div>
              </article>
            ))}
          </section>

          <div className="modalActions">
            <button className="uiButton uiButton--accent" type="button" onClick={() => setMulticastModalOpen(false)}>
              <AppIcon name="zap" />
              Save Prototype Layout
            </button>
            <button className="uiButton uiButton--secondary" type="button" onClick={() => setMulticastModalOpen(false)}>
              <AppIcon name="close" />
              Close
            </button>
          </div>
        </div>
      </OverlayPanel>

      <OverlayPanel
        open={voteModalOpen}
        onClose={() => setVoteModalOpen(false)}
        title="Vote To Skip Program"
        subtitle="Click-through prototype for viewer-driven queue control."
        mode="right"
      >
        <div className="voteModal">
          <p className="metaLine">
            <span>Current: {detail?.state.currentAssetTitle ?? nowPlaying?.asset.title ?? "No active item"}</span>
            <span>Peak concurrent: {votePeakConcurrent || "--"}</span>
            <span>Total votes: {voteTotal}</span>
          </p>

          <div className="voteDirectionSwitch">
            <button
              className={`voteDirection ${voteDirection === "previous" ? "isActive" : ""}`}
              type="button"
              onClick={() => {
                setVoteDirection("previous");
                setVoteSubmitted(false);
              }}
            >
              <AppIcon name="skip-prev" />
              Previous Program
            </button>
            <button
              className={`voteDirection ${voteDirection === "next" ? "isActive" : ""}`}
              type="button"
              onClick={() => {
                setVoteDirection("next");
                setVoteSubmitted(false);
              }}
            >
              <AppIcon name="skip-next" />
              Next Program
            </button>
          </div>

          <section className="voteTarget">
            <p className="voteTarget__kicker">Selected target</p>
            <h3>{voteTarget?.title ?? "No program available for this direction yet."}</h3>
            <p>{voteTarget ? `Program length ${formatDuration(voteTarget.durationSec)}` : "Queue needs more than one item."}</p>
          </section>

          <div className="voteMeta">
            <article>
              <h4>Supermajority Rule</h4>
              <p>
                {voteSupermajorityRequired > 0
                  ? `${voteSupermajorityRequired} of ${votePeakConcurrent} viewers (66%)`
                  : "Waiting for active program telemetry"}
              </p>
            </article>
            <article>
              <h4>{selectedDirectionLabel} Vote Progress</h4>
              <p>
                {selectedVotes} votes cast ·{" "}
                {selectedVotesNeeded > 0 ? `${selectedVotesNeeded} more needed` : "Threshold reached for trigger"}
              </p>
            </article>
          </div>

          {voteSubmitted ? (
            <div className="inlineAlert inlineAlert--info">
              Vote submitted for {selectedDirectionLabel}. {selectedVotesNeeded > 0 ? `${selectedVotesNeeded} additional votes needed.` : "Supermajority reached."}
            </div>
          ) : null}

          <div className="modalActions">
            <button
              className="uiButton uiButton--accent"
              type="button"
              onClick={onSubmitVote}
              disabled={voteSubmitted || !voteTarget || voteSupermajorityRequired === 0}
            >
              <AppIcon name="zap" />
              {voteSubmitted ? "Vote Submitted" : "Submit Vote"}
            </button>
            <button className="uiButton uiButton--secondary" type="button" onClick={() => setVoteModalOpen(false)}>
              <AppIcon name="close" />
              Close
            </button>
          </div>
        </div>
      </OverlayPanel>
    </main>
  );
}
