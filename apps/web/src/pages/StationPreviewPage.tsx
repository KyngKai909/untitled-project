import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { getApiBase, getChannelDetail, getChannelStatus } from "../api";
import HlsPlayer from "../components/HlsPlayer";
import type { ChannelDetail } from "../types";

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
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  }).format(parsed);
}

export default function StationPreviewPage() {
  const { channelId } = useParams();
  const [detail, setDetail] = useState<ChannelDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  async function load() {
    if (!channelId) {
      return;
    }

    setLoading(true);
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
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, [channelId]);

  useEffect(() => {
    if (!channelId) {
      return;
    }

    const timer = setInterval(() => {
      void load();
    }, 8_000);

    return () => clearInterval(timer);
  }, [channelId]);

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

  return (
    <main className="page">
      <section className="pageHero">
        <div className="pageHero__meta">
          <span className="microTag" data-tone="accent">Station Preview</span>
          <span className="microTag">Read-only monitoring</span>
        </div>
        <h1>{detail?.channel.name ?? "Loading station"}</h1>
        <p>Monitor stream health and current playout state without entering manager controls.</p>
        <div className="pageHero__actions">
          <Link className="button" data-variant="secondary" to={channelId ? `/stations/${channelId}` : "/dashboard"}>
            Back to Manager
          </Link>
        </div>
      </section>

      {error ? (
        <div className="alert" data-tone="error">
          {error}
        </div>
      ) : null}

      <section className="section">
        <header className="section__head">
          <div>
            <h2>Live Signal</h2>
            <p>Playback source is automatically switched to Livepeer when enabled.</p>
          </div>
        </header>
        <div className="section__body">
          {loading || !detail ? (
            <p className="loading">Loading stream...</p>
          ) : (
            <>
              <div className="metaLine">
                <span className="badge" data-tone={detail.state.isRunning ? "live" : "off"}>
                  {detail.state.isRunning ? "Live" : "Off Air"}
                </span>
                {detail.state.currentAssetTitle ? <span>{detail.state.currentAssetTitle}</span> : null}
                {detail.state.currentStartedAt ? <span>Started {formatDateTime(detail.state.currentStartedAt)}</span> : null}
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
                <HlsPlayer src={streamUrl} muted={false} />
              ) : (
                <p className="empty">No stream URL available yet.</p>
              )}
            </>
          )}
        </div>
      </section>
    </main>
  );
}
