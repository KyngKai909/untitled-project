import { FormEvent, useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { createChannel, getChannelDetail, getChannelStatus, listChannels } from "../api";
import { deriveCreatorProfile, estimateViewerCount, formatCalendarDate } from "../presentation";
import type { ChannelDetail, ChannelSummary } from "../types";

interface DashboardStation extends ChannelSummary {
  detail: ChannelDetail | null;
  isLive: boolean;
  viewers: number;
  statusNote: string;
}

export default function StudioDashboardPage() {
  const navigate = useNavigate();
  const [stations, setStations] = useState<DashboardStation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshTick, setRefreshTick] = useState<Date | null>(null);

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [creating, setCreating] = useState(false);

  async function refresh() {
    setLoading(true);
    setError(null);

    try {
      const channels = await listChannels();
      const [detailResults, statusResults] = await Promise.all([
        Promise.allSettled(channels.map((item) => getChannelDetail(item.channel.id))),
        Promise.allSettled(channels.map((item) => getChannelStatus(item.channel.id)))
      ]);

      const nextStations: DashboardStation[] = channels.map((entry, index) => {
        const detailResult = detailResults[index];
        const statusResult = statusResults[index];

        const detail = detailResult.status === "fulfilled" ? detailResult.value : null;
        const statusState = statusResult.status === "fulfilled" ? statusResult.value.state : null;
        const isLive = statusState?.isRunning ?? detail?.state.isRunning ?? false;

        return {
          ...entry,
          detail,
          isLive,
          viewers: estimateViewerCount(entry.channel.id, isLive),
          statusNote:
            statusState?.currentAssetTitle ?? detail?.state.currentAssetTitle ?? (isLive ? "Live playout active" : "Off-air")
        };
      });

      setStations(nextStations);
      setRefreshTick(new Date());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load creator dashboard");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  async function onCreateStation(event: FormEvent) {
    event.preventDefault();
    if (!name.trim()) {
      return;
    }

    setCreating(true);
    setError(null);

    try {
      const response = await createChannel({
        name: name.trim(),
        description: description.trim(),
        adInterval: 2
      });

      setName("");
      setDescription("");
      await refresh();
      navigate(`/studio/${response.channel.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create station");
    } finally {
      setCreating(false);
    }
  }

  const portfolio = useMemo(() => {
    return stations.reduce(
      (acc, station) => {
        const detail = station.detail;

        acc.stationCount += 1;
        acc.liveCount += station.isLive ? 1 : 0;
        acc.totalViewers += station.viewers;
        acc.assetCount += detail?.assets.length ?? station.assetCount;
        acc.playlistItems += detail?.playlist.length ?? station.playlistCount;

        if (detail) {
          detail.assets.forEach((asset) => {
            if (asset.type === "program") {
              acc.programCount += 1;
            } else {
              acc.adCount += 1;
            }

            if (asset.sourceType === "upload") {
              acc.uploadCount += 1;
            } else {
              acc.externalCount += 1;
            }
          });

          detail.destinations.forEach((destination) => {
            acc.destinationCount += 1;
            if (destination.enabled) {
              acc.enabledDestinationCount += 1;
            }
          });

          if (detail.livepeer?.playbackUrl) {
            acc.destinationCount += 1;
            if (detail.livepeer.enabled) {
              acc.enabledDestinationCount += 1;
            }
          }
        }

        return acc;
      },
      {
        stationCount: 0,
        liveCount: 0,
        totalViewers: 0,
        assetCount: 0,
        playlistItems: 0,
        programCount: 0,
        adCount: 0,
        uploadCount: 0,
        externalCount: 0,
        destinationCount: 0,
        enabledDestinationCount: 0
      }
    );
  }, [stations]);

  const connectedPlatforms = useMemo(() => {
    const rows: Array<{
      id: string;
      platform: string;
      stationName: string;
      endpoint: string;
      enabled: boolean;
      watchable: boolean;
    }> = [];

    stations.forEach((station) => {
      const detail = station.detail;
      if (!detail) {
        return;
      }

      detail.destinations.forEach((destination) => {
        rows.push({
          id: destination.id,
          platform: destination.name,
          stationName: station.channel.name,
          endpoint: destination.rtmpUrl,
          enabled: destination.enabled,
          watchable: destination.rtmpUrl.startsWith("http")
        });
      });

      if (detail.livepeer?.playbackUrl) {
        rows.push({
          id: `livepeer-${detail.channel.id}`,
          platform: "Livepeer Playback",
          stationName: station.channel.name,
          endpoint: detail.livepeer.playbackUrl,
          enabled: detail.livepeer.enabled,
          watchable: true
        });
      }
    });

    return rows;
  }, [stations]);

  const contentFolders = [
    {
      name: "Programs",
      count: portfolio.programCount,
      note: "Primary shows and long-form content"
    },
    {
      name: "Ads",
      count: portfolio.adCount,
      note: "Ad break pool clips"
    },
    {
      name: "Uploads",
      count: portfolio.uploadCount,
      note: "Files uploaded directly"
    },
    {
      name: "External Imports",
      count: portfolio.externalCount,
      note: "Assets pulled from external URLs"
    },
    {
      name: "Queued Items",
      count: portfolio.playlistItems,
      note: "Total lineup entries across stations"
    }
  ];

  return (
    <main className="page">
      <section className="heroBand studioHero">
        <p className="eyebrow">Creator Studio</p>
        <h1>Run stations, multistream platforms, and content operations from one dashboard.</h1>
        <p>
          Track every channel in your portfolio, inspect connected destinations, and jump straight into station manager
          editors.
        </p>

        <div className="heroMetaRow">
          <div className="statChip">
            <strong>{portfolio.stationCount}</strong>
            <span>Stations</span>
          </div>
          <div className="statChip">
            <strong>{portfolio.liveCount}</strong>
            <span>Live now</span>
          </div>
          <div className="statChip">
            <strong>{portfolio.totalViewers.toLocaleString()}</strong>
            <span>Estimated live viewers</span>
          </div>
          <button type="button" className="btn secondary" onClick={() => refresh()} disabled={loading}>
            Refresh Dashboard
          </button>
          <Link className="btn ghost" to="/">
            Open Explore
          </Link>
        </div>
      </section>

      {error ? <p className="error">{error}</p> : null}

      <section className="studioDashboardGrid">
        <article className="panel">
          <h2>Create New Station</h2>
          <form onSubmit={onCreateStation} className="formGrid">
            <label className="field">
              <span>Station name</span>
              <input value={name} onChange={(event) => setName(event.target.value)} placeholder="Nightwave TV" />
            </label>

            <label className="field">
              <span>Description</span>
              <textarea
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                rows={3}
                placeholder="What this station broadcasts"
              />
            </label>

            <button className="btn" type="submit" disabled={creating || !name.trim()}>
              {creating ? "Creating..." : "Create Station"}
            </button>
          </form>
        </article>

        <article className="panel">
          <h2>Portfolio Snapshot</h2>
          <div className="statsMosaic">
            <div>
              <strong>{portfolio.assetCount}</strong>
              <span>Total assets</span>
            </div>
            <div>
              <strong>{portfolio.destinationCount}</strong>
              <span>Connected platforms</span>
            </div>
            <div>
              <strong>{portfolio.enabledDestinationCount}</strong>
              <span>Platforms enabled</span>
            </div>
            <div>
              <strong>{portfolio.playlistItems}</strong>
              <span>Queued broadcasts</span>
            </div>
          </div>
          <p className="mutedText">Last sync: {refreshTick ? refreshTick.toLocaleTimeString() : "Not synced"}</p>
        </article>
      </section>

      <section className="panel">
        <div className="panelHead">
          <h2>Your Channels / Stations</h2>
        </div>

        {loading ? <p className="mutedText">Loading stations...</p> : null}
        {!loading && stations.length === 0 ? <p className="mutedText">Create your first station to start broadcasting.</p> : null}

        <div className="stationGrid">
          {stations.map((station) => {
            const creator = deriveCreatorProfile(station.channel);
            return (
              <article key={station.channel.id} className="stationTile">
                <div
                  className="stationPoster"
                  style={{ "--poster-accent": station.channel.brandColor || "#0a7c86" } as React.CSSProperties}
                >
                  <span className={station.isLive ? "statusPill live" : "statusPill offline"}>
                    {station.isLive ? "LIVE" : "OFF AIR"}
                  </span>
                  <span className="viewerPill">
                    {station.isLive ? `${station.viewers.toLocaleString()} watching` : "Ready for next broadcast"}
                  </span>
                </div>

                <div className="stationTileBody">
                  <h3>{station.channel.name}</h3>
                  <p className="mutedText">{creator.handle}</p>
                  <p className="metaLine">{station.statusNote}</p>
                  <p className="metaLine">
                    Assets: {station.detail?.assets.length ?? station.assetCount} • Queue: {station.detail?.playlist.length ?? station.playlistCount}
                  </p>
                  <p className="metaLine">Updated: {formatCalendarDate(station.channel.updatedAt)}</p>

                  <div className="cardActions">
                    <Link className="btn" to={`/studio/${station.channel.id}`}>
                      Open Station Manager
                    </Link>
                    <Link className="btn secondary" to={`/station/${station.channel.id}`}>
                      View Station Page
                    </Link>
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      </section>

      <section className="studioDashboardGrid">
        <article className="panel">
          <h2>Connected Platforms</h2>
          {!connectedPlatforms.length ? <p className="mutedText">No platforms connected yet.</p> : null}
          <ul className="platformList">
            {connectedPlatforms.map((platform) => (
              <li key={platform.id}>
                <div>
                  <strong>{platform.platform}</strong>
                  <p className="metaLine">
                    {platform.stationName} • {platform.enabled ? "Enabled" : "Disabled"}
                  </p>
                </div>
                {platform.watchable ? (
                  <a href={platform.endpoint} className="btn secondary" target="_blank" rel="noreferrer">
                    Open
                  </a>
                ) : (
                  <code className="endpointCode">{platform.endpoint}</code>
                )}
              </li>
            ))}
          </ul>
        </article>

        <article className="panel">
          <h2>Content Library & Folders</h2>
          <div className="folderGrid">
            {contentFolders.map((folder) => (
              <article key={folder.name} className="folderCard">
                <h3>{folder.name}</h3>
                <p className="folderCount">{folder.count}</p>
                <p className="mutedText">{folder.note}</p>
              </article>
            ))}
          </div>

          <ul className="channelFolderList">
            {stations.map((station) => (
              <li key={`folder-${station.channel.id}`}>
                <div>
                  <strong>{station.channel.name}</strong>
                  <p className="metaLine">
                    {station.detail?.assets.length ?? station.assetCount} assets • {station.detail?.playlist.length ?? station.playlistCount} queued
                  </p>
                </div>
                <Link className="btn ghost" to={`/studio/${station.channel.id}`}>
                  Manage
                </Link>
              </li>
            ))}
          </ul>
        </article>
      </section>
    </main>
  );
}
