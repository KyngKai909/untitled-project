import { FormEvent, useEffect, useMemo, useState } from "react";
import { Link, Navigate, useNavigate } from "react-router-dom";
import { createChannel, getChannelStatus, listChannels, listLibraryAssets, uploadLibraryAsset } from "../api";
import type { Asset, AssetInsertionCategory, ChannelSummary, PlayoutState, StreamMode } from "../types";
import { disconnectWallet, formatWalletAddress, getStoredWalletAddress } from "../wallet";

type DashboardSection = "library" | "stations" | "account";

interface StationCard {
  summary: ChannelSummary;
  state: PlayoutState | null;
}

function formatDateTime(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) {
    return "Unknown";
  }
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit"
  }).format(parsed);
}

function mapLibraryKindToApi(kind: AssetInsertionCategory): { type: "program" | "ad"; insertionCategory: AssetInsertionCategory } {
  if (kind === "program") {
    return { type: "program", insertionCategory: "program" };
  }
  return { type: "ad", insertionCategory: kind };
}

export default function CreatorDashboardPage() {
  const navigate = useNavigate();
  const [wallet, setWallet] = useState<string | null>(() => getStoredWalletAddress());
  const [section, setSection] = useState<DashboardSection>("stations");

  const [stations, setStations] = useState<StationCard[]>([]);
  const [loadingStations, setLoadingStations] = useState(false);

  const [libraryAssets, setLibraryAssets] = useState<Asset[]>([]);
  const [loadingLibrary, setLoadingLibrary] = useState(false);

  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [streamMode, setStreamMode] = useState<StreamMode>("video");
  const [creating, setCreating] = useState(false);

  const [libraryFile, setLibraryFile] = useState<File | null>(null);
  const [libraryTitle, setLibraryTitle] = useState("");
  const [libraryKind, setLibraryKind] = useState<AssetInsertionCategory>("program");
  const [uploadingLibrary, setUploadingLibrary] = useState(false);
  const [libraryUploadPercent, setLibraryUploadPercent] = useState(0);
  const [libraryUploadLoadedBytes, setLibraryUploadLoadedBytes] = useState(0);
  const [libraryUploadTotalBytes, setLibraryUploadTotalBytes] = useState(0);

  if (!wallet) {
    return <Navigate to="/" replace />;
  }

  const ownerWallet = wallet;

  async function refreshStations() {
    setLoadingStations(true);
    setError(null);

    try {
      const channels = await listChannels(ownerWallet);
      const stateResults = await Promise.allSettled(
        channels.map(async (entry) => {
          const status = await getChannelStatus(entry.channel.id);
          return status.state;
        })
      );

      const merged = channels
        .map((summary, index) => ({
          summary,
          state: stateResults[index].status === "fulfilled" ? stateResults[index].value : null
        }))
        .sort((left, right) => {
          const leftLive = left.state?.isRunning ?? false;
          const rightLive = right.state?.isRunning ?? false;
          if (leftLive !== rightLive) {
            return leftLive ? -1 : 1;
          }
          return right.summary.channel.createdAt.localeCompare(left.summary.channel.createdAt);
        });

      setStations(merged);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load stations");
    } finally {
      setLoadingStations(false);
    }
  }

  async function refreshLibrary() {
    setLoadingLibrary(true);
    setError(null);

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
    void refreshStations();
    void refreshLibrary();
  }, [ownerWallet]);

  const snapshot = useMemo(() => {
    return {
      stations: stations.length,
      live: stations.filter((station) => station.state?.isRunning).length,
      libraryPrograms: libraryAssets.filter((asset) => asset.type === "program").length,
      libraryAds: libraryAssets.filter((asset) => asset.type === "ad").length
    };
  }, [libraryAssets, stations]);

  function onDisconnectWallet() {
    disconnectWallet();
    setWallet(null);
    navigate("/", { replace: true });
  }

  async function onCreateStation(event: FormEvent) {
    event.preventDefault();
    if (!name.trim()) {
      return;
    }

    setCreating(true);
    setError(null);
    setInfo(null);

    try {
      const response = await createChannel({
        ownerWallet,
        name: name.trim(),
        description: description.trim(),
        streamMode,
        brandColor: streamMode === "radio" ? "#f59e0b" : "#0ea5e9"
      });
      setName("");
      setDescription("");
      setStreamMode("video");
      setInfo("Station created. Opening manager...");
      await refreshStations();
      navigate(`/stations/${response.channel.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create station");
    } finally {
      setCreating(false);
    }
  }

  async function onUploadLibraryAsset(event: FormEvent) {
    event.preventDefault();
    if (!libraryFile) {
      return;
    }

    const normalized = mapLibraryKindToApi(libraryKind);

    setUploadingLibrary(true);
    setLibraryUploadPercent(0);
    setLibraryUploadLoadedBytes(0);
    setLibraryUploadTotalBytes(0);
    setError(null);
    setInfo(null);

    try {
      const payload = await uploadLibraryAsset({
        ownerWallet,
        file: libraryFile,
        title: libraryTitle.trim() || undefined,
        type: normalized.type,
        insertionCategory: normalized.insertionCategory,
        onProgress: (progress) => {
          setLibraryUploadPercent(progress.percent);
          setLibraryUploadLoadedBytes(progress.loaded);
          setLibraryUploadTotalBytes(progress.total);
        }
      });

      setLibraryFile(null);
      setLibraryTitle("");
      setLibraryKind("program");
      setInfo(
        [
          "Library upload complete.",
          payload.compressionWarning ? `Compression warning: ${payload.compressionWarning}` : null,
          payload.ipfsWarning ? `IPFS warning: ${payload.ipfsWarning}` : null
        ]
          .filter(Boolean)
          .join(" ")
      );
      await refreshLibrary();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to upload to library");
    } finally {
      setUploadingLibrary(false);
      setLibraryUploadLoadedBytes(0);
      setLibraryUploadTotalBytes(0);
    }
  }

  return (
    <main className="page">
      <section className="pageHero">
        <div className="pageHero__meta">
          <span className="microTag" data-tone="accent">
            Creator Dashboard
          </span>
          <span className="microTag">Wallet {formatWalletAddress(ownerWallet)}</span>
        </div>
        <h1>Operate stations with strict control over media, runtime, and output.</h1>
        <p>
          Build your global asset library once, compose channel playlists with deterministic ordering, and run live output
          from a single surface.
        </p>
        <div className="pageHero__actions">
          <button className="button" type="button" onClick={() => setSection("stations")}>Stations</button>
          <button className="button" data-variant="secondary" type="button" onClick={() => setSection("library")}>
            Library
          </button>
          <button className="button" data-variant="secondary" type="button" onClick={() => setSection("account")}>
            Account
          </button>
        </div>
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

      <div className="toolbar" role="tablist" aria-label="Dashboard Sections">
        <button type="button" data-active={section === "stations"} onClick={() => setSection("stations")}>Stations</button>
        <button type="button" data-active={section === "library"} onClick={() => setSection("library")}>Library</button>
        <button type="button" data-active={section === "account"} onClick={() => setSection("account")}>Account</button>
      </div>

      <section className="statsRail" aria-label="Creator Snapshot">
        <article className="statCell">
          <p className="statCell__label">Stations</p>
          <p className="statCell__value">{snapshot.stations}</p>
        </article>
        <article className="statCell">
          <p className="statCell__label">Live</p>
          <p className="statCell__value">{snapshot.live}</p>
        </article>
        <article className="statCell">
          <p className="statCell__label">Programs</p>
          <p className="statCell__value">{snapshot.libraryPrograms}</p>
        </article>
        <article className="statCell">
          <p className="statCell__label">Ads and Sponsor Units</p>
          <p className="statCell__value">{snapshot.libraryAds}</p>
        </article>
      </section>

      {section === "library" ? (
        <div className="grid2">
          <section className="section">
            <header className="section__head">
              <div>
                <h2>Upload to Global Library</h2>
                <p>Assets uploaded here are reusable across all stations owned by this wallet.</p>
              </div>
            </header>
            <div className="section__body">
              <form className="stack" onSubmit={(event) => void onUploadLibraryAsset(event)}>
                <label className="field">
                  <span>Media File</span>
                  <input
                    type="file"
                    required
                    onChange={(event) => setLibraryFile(event.target.files?.[0] ?? null)}
                    disabled={uploadingLibrary}
                  />
                </label>

                <label className="field">
                  <span>Optional Title</span>
                  <input
                    value={libraryTitle}
                    onChange={(event) => setLibraryTitle(event.target.value)}
                    disabled={uploadingLibrary}
                    placeholder="Override detected title"
                  />
                </label>

                <label className="field">
                  <span>Insertion Category</span>
                  <select
                    value={libraryKind}
                    onChange={(event) => {
                      const value = event.target.value;
                      if (value === "ad" || value === "sponsor" || value === "bumper") {
                        setLibraryKind(value);
                        return;
                      }
                      setLibraryKind("program");
                    }}
                    disabled={uploadingLibrary}
                  >
                    <option value="program">Program</option>
                    <option value="ad">Ad</option>
                    <option value="sponsor">Sponsor Segment</option>
                    <option value="bumper">Bumper</option>
                  </select>
                </label>

                <div className="pageHero__actions">
                  <button className="button" data-variant="accent" type="submit" disabled={uploadingLibrary || !libraryFile}>
                    {uploadingLibrary ? "Uploading" : "Upload to Library"}
                  </button>
                  <button
                    className="button"
                    data-variant="secondary"
                    type="button"
                    onClick={() => void refreshLibrary()}
                    disabled={loadingLibrary}
                  >
                    {loadingLibrary ? "Refreshing" : "Refresh"}
                  </button>
                </div>
              </form>

              {uploadingLibrary ? (
                <div className="stack">
                  <p className="metaLine">
                    <span>{libraryUploadPercent < 100 ? "Uploading file" : "Processing and compressing"}</span>
                    <span>{libraryUploadPercent}%</span>
                  </p>
                  <div className="progressTrack">
                    <span style={{ width: `${libraryUploadPercent}%` }} />
                  </div>
                  {libraryUploadTotalBytes > 0 ? (
                    <p className="empty">
                      {Math.round(libraryUploadLoadedBytes / (1024 * 1024))}MB / {Math.round(libraryUploadTotalBytes / (1024 * 1024))}
                      MB
                    </p>
                  ) : null}
                </div>
              ) : null}
            </div>
          </section>

          <section className="section">
            <header className="section__head">
              <div>
                <h2>Current Library Assets</h2>
                <p>Chronological record of media available to this creator account.</p>
              </div>
            </header>
            <div className="section__body">
              {libraryAssets.length === 0 ? <p className="empty">No global library assets yet.</p> : null}
              {libraryAssets.length > 0 ? (
                <div className="list">
                  {libraryAssets.map((asset) => (
                    <article key={asset.id} className="row">
                      <div>
                        <p className="row__title">{asset.title}</p>
                        <p className="row__meta">
                          {asset.insertionCategory ?? asset.type} · {formatDateTime(asset.createdAt)}
                        </p>
                      </div>
                      <div className="row__actions">
                        <span className="badge">{asset.mediaKind}</span>
                        {asset.ipfsUrl ? (
                          <a className="button" data-variant="secondary" href={asset.ipfsUrl} target="_blank" rel="noreferrer">
                            IPFS
                          </a>
                        ) : null}
                      </div>
                    </article>
                  ))}
                </div>
              ) : null}
            </div>
          </section>
        </div>
      ) : null}

      {section === "stations" ? (
        <div className="grid2">
          <section className="section">
            <header className="section__head">
              <div>
                <h2>Create Station</h2>
                <p>Define station profile and stream mode. Brand color is derived automatically.</p>
              </div>
            </header>
            <div className="section__body">
              <form className="stack" onSubmit={(event) => void onCreateStation(event)}>
                <label className="field">
                  <span>Station Name</span>
                  <input
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    placeholder="Station name"
                    required
                    disabled={creating}
                  />
                </label>

                <label className="field">
                  <span>Description</span>
                  <textarea
                    value={description}
                    onChange={(event) => setDescription(event.target.value)}
                    placeholder="What this station is for"
                    disabled={creating}
                  />
                </label>

                <label className="field">
                  <span>Stream Mode</span>
                  <select
                    value={streamMode}
                    onChange={(event) => setStreamMode(event.target.value === "radio" ? "radio" : "video")}
                    disabled={creating}
                  >
                    <option value="video">Video</option>
                    <option value="radio">Radio</option>
                  </select>
                </label>

                <div className="pageHero__actions">
                  <button className="button" data-variant="accent" type="submit" disabled={!name.trim() || creating}>
                    {creating ? "Creating" : "Create Station"}
                  </button>
                  <button
                    className="button"
                    data-variant="secondary"
                    type="button"
                    disabled={loadingStations}
                    onClick={() => void refreshStations()}
                  >
                    {loadingStations ? "Refreshing" : "Refresh Stations"}
                  </button>
                </div>
              </form>
            </div>
          </section>

          <section className="section">
            <header className="section__head">
              <div>
                <h2>Station Roster</h2>
                <p>Live stations are pinned to the top by runtime status.</p>
              </div>
            </header>
            <div className="section__body">
              {loadingStations ? <p className="loading">Loading stations...</p> : null}
              {!loadingStations && stations.length === 0 ? (
                <p className="empty">No stations yet. Create your first station in the panel on the left.</p>
              ) : null}

              {stations.length > 0 ? (
                <div className="list">
                  {stations.map((station) => (
                    <article key={station.summary.channel.id} className="row">
                      <div>
                        <p className="row__title">{station.summary.channel.name}</p>
                        <p className="row__meta">
                          {station.summary.channel.description || "No description"} · {station.summary.playlistCount} queued
                        </p>
                      </div>
                      <div className="row__actions">
                        <span className="badge" data-tone={station.state?.isRunning ? "live" : "off"}>
                          {station.state?.isRunning ? "Live" : "Off Air"}
                        </span>
                        <Link className="button" data-variant="secondary" to={`/stations/${station.summary.channel.id}`}>
                          Manage
                        </Link>
                        <Link className="button" data-variant="secondary" to={`/stations/${station.summary.channel.id}/preview`}>
                          Preview
                        </Link>
                      </div>
                    </article>
                  ))}
                </div>
              ) : null}
            </div>
          </section>
        </div>
      ) : null}

      {section === "account" ? (
        <section className="section">
          <header className="section__head">
            <div>
              <h2>Account and Session</h2>
              <p>Wallet-scoped access control for creator operations.</p>
            </div>
          </header>
          <div className="section__body">
            <p className="metaLine">
              <span className="badge">Connected Wallet</span>
              <span>{formatWalletAddress(ownerWallet)}</span>
            </p>
            <div className="pageHero__actions">
              <button className="button" data-variant="danger" onClick={onDisconnectWallet}>
                Disconnect Wallet
              </button>
            </div>
          </div>
        </section>
      ) : null}
    </main>
  );
}
