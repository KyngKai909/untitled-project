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
    <main className="routeFrame">
      <section className="pageBanner">
        <div className="pageBanner__meta">
          <span className="miniTag miniTag--accent">Station Preview</span>
          {detail ? (
            <span className={`statusPill ${detail.state.isRunning ? "statusPill--live" : "statusPill--off"}`}>
              {detail.state.isRunning ? "Live" : "Off Air"}
            </span>
          ) : null}
        </div>
        <h1>{detail?.channel.name ?? "Loading station"}</h1>
        <p>Read-only monitoring layout with feed playback and operational metadata side rail.</p>
        <div className="pageBanner__actions">
          <Link className="uiButton uiButton--secondary" to={channelId ? `/stations/${channelId}` : "/dashboard"}>
            Back to Manager
          </Link>
          <Link className="uiButton uiButton--secondary" to="/dashboard">
            Back to Workspace
          </Link>
        </div>
      </section>

      {error ? <div className="inlineAlert inlineAlert--error">{error}</div> : null}

      <section className="previewGrid">
        <section className="previewMain">
          <header className="paneHead">
            <div>
              <h2>Live Feed</h2>
              <p>Primary playback channel selected from current output route.</p>
            </div>
          </header>
          <div className="paneBody">
            {loading || !detail ? (
              <p className="loadingState">Loading stream...</p>
            ) : livepeerEmbedUrl ? (
              <div className="mediaShell">
                <iframe
                  src={livepeerEmbedUrl}
                  title="Livepeer Player"
                  allow="autoplay; fullscreen; picture-in-picture"
                />
              </div>
            ) : streamUrl ? (
              <HlsPlayer src={streamUrl} muted={false} />
            ) : (
              <p className="emptyState">No stream URL available yet.</p>
            )}
          </div>
        </section>

        <aside className="previewRail">
          <header className="paneHead">
            <div>
              <h2>Signal State</h2>
              <p>Current track and recent playback timing.</p>
            </div>
          </header>
          <div className="paneBody">
            {loading || !detail ? (
              <p className="loadingState">Collecting status...</p>
            ) : (
              <>
                <p className="metaLine">
                  <span className={`statusPill ${detail.state.isRunning ? "statusPill--live" : "statusPill--off"}`}>
                    {detail.state.isRunning ? "Live" : "Off Air"}
                  </span>
                  {detail.state.currentAssetTitle ? <span>{detail.state.currentAssetTitle}</span> : null}
                </p>

                <section className="stageSection">
                  <div className="stageSection__head">
                    <div>
                      <h3>Playback Details</h3>
                      <p>Updated every 8 seconds.</p>
                    </div>
                  </div>
                  <div className="stageSection__body">
                    <p className="metaLine">Started {formatDateTime(detail.state.currentStartedAt)}</p>
                    <p className="metaLine">Queue Index {detail.state.queueIndex}</p>
                    <p className="metaLine">Livepeer {detail.livepeer?.enabled ? "Enabled" : "Disabled"}</p>
                  </div>
                </section>
              </>
            )}
          </div>
        </aside>
      </section>
    </main>
  );
}
