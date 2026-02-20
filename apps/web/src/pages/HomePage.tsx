import { type CSSProperties, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { getChannelStatus, listChannels } from "../api";
import { deriveCreatorProfile, estimateViewerCount } from "../presentation";
import type { ChannelSummary, LivepeerStatus, PlayoutState } from "../types";

type StatusFilter = "all" | "live" | "offline";

interface StationCard extends ChannelSummary {
  state: PlayoutState | null;
  livepeer?: LivepeerStatus;
  statusError?: string;
  viewers: number;
}

function shortText(input: string, fallback: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    return fallback;
  }
  if (trimmed.length <= 120) {
    return trimmed;
  }
  return `${trimmed.slice(0, 117)}...`;
}

function initialsFromName(name: string): string {
  const pieces = name.trim().split(/\s+/).filter(Boolean);
  if (!pieces.length) {
    return "OC";
  }
  return pieces
    .slice(0, 2)
    .map((piece) => piece[0]?.toUpperCase() ?? "")
    .join("");
}

export default function HomePage() {
  const [stations, setStations] = useState<StationCard[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<StatusFilter>("all");

  async function refresh() {
    setLoading(true);
    setError(null);

    try {
      const channels = await listChannels();
      const statusResults = await Promise.allSettled(channels.map((entry) => getChannelStatus(entry.channel.id)));

      const merged: StationCard[] = channels.map((entry, index) => {
        const statusResult = statusResults[index];

        if (statusResult.status === "fulfilled") {
          const isLive = statusResult.value.state.isRunning;
          return {
            ...entry,
            state: statusResult.value.state,
            livepeer: statusResult.value.livepeer,
            viewers: estimateViewerCount(entry.channel.id, isLive)
          };
        }

        return {
          ...entry,
          state: null,
          viewers: 0,
          statusError: statusResult.reason instanceof Error ? statusResult.reason.message : "Status unavailable"
        };
      });

      setStations(merged);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load stations");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  const normalizedQuery = query.trim().toLowerCase();

  const filteredStations = useMemo(() => {
    return stations.filter((station) => {
      const isLive = station.state?.isRunning ?? false;
      if (filter === "live" && !isLive) {
        return false;
      }
      if (filter === "offline" && isLive) {
        return false;
      }

      if (!normalizedQuery) {
        return true;
      }

      const creator = deriveCreatorProfile(station.channel);
      const searchBlob = [
        station.channel.name,
        station.channel.description,
        station.channel.playerLabel,
        creator.displayName,
        creator.handle
      ]
        .join(" ")
        .toLowerCase();

      return searchBlob.includes(normalizedQuery);
    });
  }, [stations, filter, normalizedQuery]);

  const creatorCards = useMemo(() => {
    return filteredStations.map((station) => {
      const creator = deriveCreatorProfile(station.channel);
      return {
        id: station.channel.id,
        stationId: station.channel.id,
        stationName: station.channel.name,
        isLive: station.state?.isRunning ?? false,
        ...creator
      };
    });
  }, [filteredStations]);

  const liveCount = stations.filter((station) => station.state?.isRunning).length;
  const offlineCount = Math.max(0, stations.length - liveCount);

  return (
    <main className="page">
      <section className="heroBand exploreHero">
        <p className="eyebrow">Viewer App</p>
        <h1>Explore live and off-air stations from independent creators.</h1>
        <p>
          Jump into a station page with live playback, upcoming schedule, creator profile, and where the channel is
          distributed outside the app.
        </p>
        <div className="heroMetaRow">
          <div className="statChip">
            <strong>{liveCount}</strong>
            <span>Live now</span>
          </div>
          <div className="statChip">
            <strong>{offlineCount}</strong>
            <span>Off-air</span>
          </div>
          <div className="statChip">
            <strong>{stations.length}</strong>
            <span>Total stations</span>
          </div>
          <Link className="btn secondary" to="/studio">
            Open Creator Studio
          </Link>
        </div>
      </section>

      <section className="panel">
        <div className="panelHead">
          <h2>Explore Stations</h2>
          <button type="button" className="btn ghost" onClick={() => refresh()} disabled={loading}>
            Refresh
          </button>
        </div>

        <div className="exploreToolbar">
          <label className="field">
            <span>Search</span>
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search stations, tags, and creators"
            />
          </label>

          <div className="segmented" role="tablist" aria-label="Station status filter">
            <button
              type="button"
              className={filter === "all" ? "segment active" : "segment"}
              onClick={() => setFilter("all")}
            >
              All
            </button>
            <button
              type="button"
              className={filter === "live" ? "segment active" : "segment"}
              onClick={() => setFilter("live")}
            >
              Live
            </button>
            <button
              type="button"
              className={filter === "offline" ? "segment active" : "segment"}
              onClick={() => setFilter("offline")}
            >
              Off-Air
            </button>
          </div>
        </div>

        {loading ? <p className="mutedText">Loading stations...</p> : null}
        {error ? <p className="error">{error}</p> : null}
        {!loading && !filteredStations.length ? <p className="mutedText">No stations match this filter.</p> : null}

        <div className="stationGrid">
          {filteredStations.map((station) => {
            const isLive = station.state?.isRunning ?? false;
            const posterStyle = {
              "--poster-accent": station.channel.brandColor || "#0a7c86"
            } as CSSProperties;

            return (
              <article key={station.channel.id} className="stationTile">
                <div className="stationPoster" style={posterStyle}>
                  <span className={isLive ? "statusPill live" : "statusPill offline"}>{isLive ? "LIVE" : "OFF AIR"}</span>
                  <span className="viewerPill">
                    {isLive ? `${station.viewers.toLocaleString()} watching` : "Offline archive"}
                  </span>
                </div>

                <div className="stationTileBody">
                  <div>
                    <h3>{station.channel.name}</h3>
                    <p className="mutedText">
                      {shortText(station.channel.description, "This station has not added a description yet.")}
                    </p>
                  </div>

                  <p className="metaLine">
                    {station.assetCount} assets • {station.playlistCount} queue items • ad break every {station.channel.adInterval}
                  </p>
                  <p className="metaLine">
                    {isLive
                      ? `Now playing: ${station.state?.currentAssetTitle ?? "Live playout"}`
                      : station.statusError ?? "Station is currently off-air."}
                  </p>

                  <div className="cardActions">
                    <Link className="btn" to={`/station/${station.channel.id}`}>
                      Watch Station
                    </Link>
                    <Link className="btn secondary" to={`/studio/${station.channel.id}`}>
                      Manage Station
                    </Link>
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      </section>

      <section className="panel">
        <div className="panelHead">
          <h2>Creators</h2>
        </div>

        {!creatorCards.length ? <p className="mutedText">No creators found for this filter.</p> : null}

        <div className="creatorGrid">
          {creatorCards.map((creator) => (
            <article key={creator.id} className="creatorTile">
              <div className="creatorAvatar" aria-hidden="true">
                {initialsFromName(creator.displayName)}
              </div>

              <div className="creatorCopy">
                <h3>{creator.displayName}</h3>
                <p className="mutedText">{creator.handle}</p>
                <p>{creator.bio}</p>
                <p className="metaLine">
                  {creator.followers.toLocaleString()} followers • {creator.isLive ? "Live right now" : "Off-air"}
                </p>
              </div>

              <div className="cardActions compact">
                <Link className="btn secondary" to={`/station/${creator.stationId}`}>
                  Open {creator.stationName}
                </Link>
              </div>
            </article>
          ))}
        </div>
      </section>
    </main>
  );
}
