import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { getApiBase, getChannelDetail, getChannelStatus } from "../api";
import HlsPlayer from "../components/HlsPlayer";
import {
  buildBroadcastSchedule,
  deriveCreatorProfile,
  formatCalendarDate,
  formatClockTime,
  formatDuration
} from "../presentation";
import type { ChannelDetail } from "../types";

type StreamSource = "livepeer" | "local";

function pickPreferredStream(input: { streamUrl: string; livepeer?: ChannelDetail["livepeer"] }): {
  streamPath: string;
  source: StreamSource;
} {
  if (input.livepeer?.enabled && input.livepeer.playbackUrl) {
    return { streamPath: input.livepeer.playbackUrl, source: "livepeer" };
  }
  return { streamPath: input.streamUrl, source: "local" };
}

export default function WatchPage() {
  const { channelId } = useParams();
  const [detail, setDetail] = useState<ChannelDetail | null>(null);
  const [state, setState] = useState<ChannelDetail["state"] | null>(null);
  const [streamPath, setStreamPath] = useState<string>("");
  const [streamSource, setStreamSource] = useState<StreamSource>("local");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastStatusSync, setLastStatusSync] = useState<Date | null>(null);

  async function loadStation() {
    if (!channelId) {
      return;
    }

    try {
      const station = await getChannelDetail(channelId);
      setDetail(station);
      setState(station.state);

      const preferred = pickPreferredStream(station);
      setStreamPath(preferred.streamPath);
      setStreamSource(preferred.source);
      setLastStatusSync(new Date());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load station");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    setLoading(true);
    setStreamPath("");
    setState(null);
    loadStation();
  }, [channelId]);

  useEffect(() => {
    if (!channelId) {
      return;
    }

    const interval = setInterval(async () => {
      try {
        const status = await getChannelStatus(channelId);
        setState(status.state);

        const preferred = pickPreferredStream(status);
        setStreamPath(preferred.streamPath);
        setStreamSource(preferred.source);
        setLastStatusSync(new Date());
      } catch {
        // Keep showing the last known status if polling fails.
      }
    }, 3000);

    return () => clearInterval(interval);
  }, [channelId]);

  const streamSrc = channelId
    ? (streamPath || `/hls/${channelId}/index.m3u8`).startsWith("http")
      ? streamPath || `/hls/${channelId}/index.m3u8`
      : `${getApiBase()}${streamPath || `/hls/${channelId}/index.m3u8`}`
    : "";

  const liveState = state ?? detail?.state;
  const creator = detail ? deriveCreatorProfile(detail.channel) : null;

  const schedule = useMemo(() => {
    if (!detail) {
      return [];
    }

    return buildBroadcastSchedule({
      playlist: detail.playlist,
      queueIndex: liveState?.queueIndex ?? detail.state.queueIndex,
      limit: 10
    });
  }, [detail, liveState?.queueIndex]);

  const distributionPoints = useMemo(() => {
    if (!detail) {
      return [];
    }

    const points: Array<{
      id: string;
      name: string;
      type: "Public stream" | "Simulcast target";
      endpoint: string;
      enabled: boolean;
      watchable: boolean;
    }> = [];

    if (detail.livepeer?.playbackUrl) {
      points.push({
        id: "livepeer-playback",
        name: "Livepeer Playback",
        type: "Public stream",
        endpoint: detail.livepeer.playbackUrl,
        enabled: detail.livepeer.enabled,
        watchable: true
      });
    }

    detail.destinations.forEach((destination) => {
      points.push({
        id: destination.id,
        name: destination.name,
        type: "Simulcast target",
        endpoint: destination.rtmpUrl,
        enabled: destination.enabled,
        watchable: destination.rtmpUrl.startsWith("http")
      });
    });

    return points;
  }, [detail]);

  const adCadenceLabel = useMemo(() => {
    if (!detail) {
      return "Video inserts";
    }

    if (detail.channel.adTriggerMode === "disabled") {
      return "Video inserts: disabled";
    }

    if (detail.channel.adTriggerMode === "time_interval") {
      const minutes = Math.max(1, Math.round(detail.channel.adTimeIntervalSec / 60));
      return `Video inserts: every ${minutes} minute${minutes === 1 ? "" : "s"}`;
    }

    return `Video inserts: every ${detail.channel.adInterval} video${detail.channel.adInterval === 1 ? "" : "s"}`;
  }, [detail]);

  if (loading) {
    return (
      <main className="page">
        <section className="panel">
          <p className="mutedText">Loading station...</p>
        </section>
      </main>
    );
  }

  if (error || !detail) {
    return (
      <main className="page">
        <section className="panel">
          <p className="error">{error ?? "Station not found"}</p>
          <Link className="btn secondary" to="/">
            Back to Explore
          </Link>
        </section>
      </main>
    );
  }

  return (
    <main className="page">
      <section className="heroBand stationHero">
        <p className="eyebrow">Station</p>
        <h1>{detail.channel.name}</h1>
        <p>{detail.channel.description || "This station has not published a description yet."}</p>
        <div className="heroMetaRow">
          <span className={liveState?.isRunning ? "statusPill live" : "statusPill offline"}>
            {liveState?.isRunning ? "LIVE" : "OFF AIR"}
          </span>
          <span className="metaBadge">{adCadenceLabel}</span>
          <span className="metaBadge">Created: {formatCalendarDate(detail.channel.createdAt)}</span>
          <Link className="btn secondary" to={`/studio/${detail.channel.id}`}>
            Open Station Manager
          </Link>
        </div>
      </section>

      <section className="stationLayout">
        <div className="panel playerPanel">
          <h2>Live Stream</h2>
          <HlsPlayer
            src={streamSrc}
            muted
            brandLabel={detail.channel.playerLabel || detail.channel.name}
            accentColor={detail.channel.brandColor || "#0a7c86"}
          />

          <div className="statusGrid">
            <article className="statusCard">
              <h3>Broadcast Status</h3>
              <p>{liveState?.isRunning ? "Broadcasting" : "Off-air"}</p>
            </article>
            <article className="statusCard">
              <h3>Now Playing</h3>
              <p>{liveState?.currentAssetTitle ?? "Waiting for playout"}</p>
            </article>
            <article className="statusCard">
              <h3>Delivery Source</h3>
              <p>{streamSource === "livepeer" ? "Livepeer" : "Local HLS fallback"}</p>
            </article>
          </div>

          <p className="tinyMono">
            Last status sync: {lastStatusSync ? formatClockTime(lastStatusSync) : "Unknown"}
            {liveState?.lastError ? ` • Worker alert: ${liveState.lastError}` : ""}
          </p>
          {streamSource === "livepeer" ? (
            <p className="mutedText">Public playback can trail skip/queue updates by roughly 8-20 seconds.</p>
          ) : null}
        </div>

        <aside className="panel stationInfoPanel">
          <h2>Station Info</h2>
          <dl className="detailList">
            <div>
              <dt>Station slug</dt>
              <dd>{detail.channel.slug}</dd>
            </div>
            <div>
              <dt>Queued items</dt>
              <dd>{detail.playlist.length}</dd>
            </div>
            <div>
              <dt>Content library size</dt>
              <dd>{detail.assets.length} assets</dd>
            </div>
            <div>
              <dt>Last updated</dt>
              <dd>{formatCalendarDate(detail.channel.updatedAt)}</dd>
            </div>
          </dl>

          <article className="creatorCard">
            <h3>Owner / Creator</h3>
            <p className="creatorName">{creator?.displayName}</p>
            <p className="mutedText">{creator?.handle}</p>
            <p>{creator?.bio}</p>
            <p className="metaLine">{creator?.followers.toLocaleString()} followers</p>
          </article>
        </aside>
      </section>

      <section className="stationLayout secondary">
        <article className="panel">
          <h2>Broadcast Schedule</h2>
          <p className="mutedText">
            Upcoming loop based on queue order. Playout automatically inserts ad breaks every {detail.channel.adInterval}
            programs.
          </p>

          {!schedule.length ? <p className="mutedText">No queue configured yet.</p> : null}

          <ol className="scheduleList">
            {schedule.map((slot, index) => (
              <li key={slot.id} className={index === 0 && liveState?.isRunning ? "current" : ""}>
                <div className="slotTime">{index === 0 && liveState?.isRunning ? "Now" : formatClockTime(slot.startsAt)}</div>
                <div>
                  <strong>{slot.title}</strong>
                  <p className="metaLine">
                    {slot.kind} • {formatDuration(slot.durationSec)}
                  </p>
                </div>
              </li>
            ))}
          </ol>
        </article>

        <article className="panel">
          <h2>Watch Outside This App</h2>
          <p className="mutedText">Configured public playback links and multistream destination endpoints.</p>

          {!distributionPoints.length ? <p className="mutedText">No external destinations are configured yet.</p> : null}

          <ul className="externalList">
            {distributionPoints.map((point) => (
              <li key={point.id}>
                <div>
                  <strong>{point.name}</strong>
                  <p className="metaLine">
                    {point.type} • {point.enabled ? "Enabled" : "Disabled"}
                  </p>
                </div>
                <div>
                  {point.watchable ? (
                    <a className="btn secondary" href={point.endpoint} target="_blank" rel="noreferrer">
                      Open
                    </a>
                  ) : (
                    <code className="endpointCode">{point.endpoint}</code>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </article>
      </section>

      <section className="panel">
        <h2>Current Rotation</h2>
        {!detail.playlist.length ? <p className="mutedText">No items in rotation.</p> : null}
        <ol className="queueList">
          {detail.playlist.map((item) => (
            <li key={item.id}>
              <strong>{item.asset.title}</strong>
              <span>{item.asset.type === "ad" ? "Ad" : "Program"}</span>
              <span>{formatDuration(item.asset.durationSec)}</span>
            </li>
          ))}
        </ol>
      </section>
    </main>
  );
}
