import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { getApiBase, getChannelDetail, getChannelStatus } from "../api";
import HlsPlayer from "../components/HlsPlayer";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
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

  return (
    <main className="mx-auto w-full max-w-7xl space-y-4 px-4 py-6">
      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-3">
          <div>
            <p className="text-xs uppercase tracking-wide text-slate-400">Station Preview</p>
            <CardTitle>{detail?.channel.name ?? "Loading..."}</CardTitle>
          </div>
          <Button asChild variant="outline" size="sm">
            <Link to={channelId ? `/stations/${channelId}` : "/dashboard"}>Back to Manager</Link>
          </Button>
        </CardHeader>
        <CardContent className="space-y-3">
          {error ? (
            <div className="rounded-md border border-rose-500/40 bg-rose-500/10 p-3 text-sm text-rose-300">{error}</div>
          ) : null}

          {loading || !detail ? (
            <p className="text-sm text-slate-400">Loading stream...</p>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-2 text-sm text-slate-300">
                <Badge variant={detail.state.isRunning ? "default" : "secondary"}>
                  {detail.state.isRunning ? "LIVE" : "OFF AIR"}
                </Badge>
                {detail.state.currentAssetTitle ? <span>{detail.state.currentAssetTitle}</span> : null}
                {detail.state.currentStartedAt ? <span>started {formatDateTime(detail.state.currentStartedAt)}</span> : null}
              </div>

              {streamUrl ? (
                <HlsPlayer src={streamUrl} muted={false} />
              ) : (
                <p className="text-sm text-slate-400">No stream URL available yet.</p>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </main>
  );
}
