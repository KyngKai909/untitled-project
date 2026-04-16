import { FormEvent, useEffect, useMemo, useState } from "react";
import { Link, Navigate, useNavigate } from "react-router-dom";
import { createChannel, getChannelStatus, listChannels, listLibraryAssets, uploadLibraryAsset } from "../api";
import OverlayPanel from "../components/OverlayPanel";
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

  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [uploadModalOpen, setUploadModalOpen] = useState(false);
  const [leftDrawerOpen, setLeftDrawerOpen] = useState(false);
  const [rightDrawerOpen, setRightDrawerOpen] = useState(false);

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
      setCreateModalOpen(false);
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
      setUploadModalOpen(false);

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

  const leftRail = (
    <>
      <header className="paneHead">
        <div>
          <h3>Workspace Navigation</h3>
          <p>Switch operating context.</p>
        </div>
      </header>
      <div className="paneBody paneBody--dense">
        <div className="navStack">
          <button
            type="button"
            data-active={section === "stations"}
            onClick={() => {
              setSection("stations");
              setLeftDrawerOpen(false);
            }}
          >
            Stations
          </button>
          <button
            type="button"
            data-active={section === "library"}
            onClick={() => {
              setSection("library");
              setLeftDrawerOpen(false);
            }}
          >
            Library
          </button>
          <button
            type="button"
            data-active={section === "account"}
            onClick={() => {
              setSection("account");
              setLeftDrawerOpen(false);
            }}
          >
            Account
          </button>
        </div>

        <div className="stageSection">
          <div className="stageSection__head">
            <div>
              <h3>Quick Actions</h3>
              <p>Primary creator operations.</p>
            </div>
          </div>
          <div className="stageSection__body">
            <button
              className="uiButton uiButton--accent"
              type="button"
              onClick={() => {
                setCreateModalOpen(true);
                setLeftDrawerOpen(false);
              }}
            >
              Create Station
            </button>
            <button
              className="uiButton uiButton--secondary"
              type="button"
              onClick={() => {
                setUploadModalOpen(true);
                setLeftDrawerOpen(false);
              }}
            >
              Upload Asset
            </button>
            <button className="uiButton uiButton--secondary" type="button" onClick={() => void refreshStations()} disabled={loadingStations}>
              {loadingStations ? "Refreshing" : "Refresh Stations"}
            </button>
          </div>
        </div>
      </div>
    </>
  );

  const rightRail = (
    <>
      <header className="paneHead">
        <div>
          <h3>Account Snapshot</h3>
          <p>Wallet scoped totals and shortcuts.</p>
        </div>
      </header>
      <div className="paneBody">
        <section className="kpiRail">
          <article>
            <h4>Stations</h4>
            <p>{snapshot.stations}</p>
          </article>
          <article>
            <h4>Live</h4>
            <p>{snapshot.live}</p>
          </article>
          <article>
            <h4>Programs</h4>
            <p>{snapshot.libraryPrograms}</p>
          </article>
          <article>
            <h4>Ads / Sponsors</h4>
            <p>{snapshot.libraryAds}</p>
          </article>
        </section>

        <section className="stageSection">
          <div className="stageSection__head">
            <div>
              <h3>Identity</h3>
              <p>Current wallet session.</p>
            </div>
          </div>
          <div className="stageSection__body">
            <p className="metaLine">
              <span className="statusPill statusPill--live">Connected</span>
              <span>{formatWalletAddress(ownerWallet)}</span>
            </p>
            <button className="uiButton uiButton--danger" type="button" onClick={onDisconnectWallet}>
              Disconnect Wallet
            </button>
          </div>
        </section>
      </div>
    </>
  );

  return (
    <main className="routeFrame">
      <section className="pageBanner">
        <div className="pageBanner__meta">
          <span className="miniTag miniTag--accent">Creator Workspace</span>
          <span className="miniTag">Wallet {formatWalletAddress(ownerWallet)}</span>
        </div>
        <h1>Command center for media operations, station control, and live readiness.</h1>
        <p>
          Multi-pane interface with modal workflows for creation and upload, optimized for daily operation across desktop and mobile.
        </p>
        <div className="pageBanner__actions">
          <button className="uiButton uiButton--accent" type="button" onClick={() => setCreateModalOpen(true)}>
            New Station
          </button>
          <button className="uiButton uiButton--secondary" type="button" onClick={() => setUploadModalOpen(true)}>
            Upload Media
          </button>
          <button className="uiButton uiButton--ghost mobileOnly" type="button" onClick={() => setLeftDrawerOpen(true)}>
            Open Navigation
          </button>
          <button className="uiButton uiButton--ghost mobileOnly" type="button" onClick={() => setRightDrawerOpen(true)}>
            Open Snapshot
          </button>
        </div>
      </section>

      {error ? <div className="inlineAlert inlineAlert--error">{error}</div> : null}
      {info ? <div className="inlineAlert inlineAlert--info">{info}</div> : null}

      <section className="workspaceGrid">
        <aside className="workspacePane workspacePane--rail">{leftRail}</aside>

        <section className="workspacePane">
          {section === "stations" ? (
            <>
              <header className="paneHead">
                <div>
                  <h2>Station Roster</h2>
                  <p>Live stations are pinned first, then sorted by creation date.</p>
                </div>
                <button className="uiButton uiButton--secondary" type="button" onClick={() => void refreshStations()} disabled={loadingStations}>
                  {loadingStations ? "Refreshing" : "Refresh"}
                </button>
              </header>
              <div className="paneBody">
                {loadingStations ? <p className="loadingState">Loading stations...</p> : null}
                {!loadingStations && stations.length === 0 ? (
                  <p className="emptyState">No stations yet. Create your first station.</p>
                ) : null}

                {stations.length > 0 ? (
                  <div className="dataTable">
                    {stations.map((station) => (
                      <article className="dataRow" key={station.summary.channel.id}>
                        <div>
                          <p className="dataRow__title">{station.summary.channel.name}</p>
                          <p className="dataRow__meta">
                            {station.summary.channel.description || "No description"} · {station.summary.playlistCount} queued
                          </p>
                        </div>
                        <div className="dataRow__actions">
                          <span className={`statusPill ${station.state?.isRunning ? "statusPill--live" : "statusPill--off"}`}>
                            {station.state?.isRunning ? "Live" : "Off Air"}
                          </span>
                          <Link className="uiButton uiButton--secondary" to={`/stations/${station.summary.channel.id}`}>
                            Manage
                          </Link>
                          <Link className="uiButton uiButton--secondary" to={`/stations/${station.summary.channel.id}/preview`}>
                            Preview
                          </Link>
                        </div>
                      </article>
                    ))}
                  </div>
                ) : null}
              </div>
            </>
          ) : null}

          {section === "library" ? (
            <>
              <header className="paneHead">
                <div>
                  <h2>Global Library</h2>
                  <p>Wallet-level assets available for station import.</p>
                </div>
                <div className="pageBanner__actions">
                  <button className="uiButton uiButton--accent" type="button" onClick={() => setUploadModalOpen(true)}>
                    Upload
                  </button>
                  <button className="uiButton uiButton--secondary" type="button" onClick={() => void refreshLibrary()} disabled={loadingLibrary}>
                    {loadingLibrary ? "Refreshing" : "Refresh"}
                  </button>
                </div>
              </header>
              <div className="paneBody">
                {libraryAssets.length === 0 ? <p className="emptyState">No global library assets yet.</p> : null}

                {libraryAssets.length > 0 ? (
                  <div className="dataTable">
                    {libraryAssets.map((asset) => (
                      <article className="dataRow" key={asset.id}>
                        <div>
                          <p className="dataRow__title">{asset.title}</p>
                          <p className="dataRow__meta">
                            {asset.insertionCategory ?? asset.type} · {formatDateTime(asset.createdAt)}
                          </p>
                        </div>
                        <div className="dataRow__actions">
                          <span className="miniTag">{asset.mediaKind}</span>
                          {asset.ipfsUrl ? (
                            <a className="uiButton uiButton--secondary" href={asset.ipfsUrl} target="_blank" rel="noreferrer">
                              IPFS
                            </a>
                          ) : null}
                        </div>
                      </article>
                    ))}
                  </div>
                ) : null}
              </div>
            </>
          ) : null}

          {section === "account" ? (
            <>
              <header className="paneHead">
                <div>
                  <h2>Account Controls</h2>
                  <p>Session settings and identity details.</p>
                </div>
              </header>
              <div className="paneBody">
                <section className="stageSection">
                  <div className="stageSection__head">
                    <div>
                      <h3>Connected Wallet</h3>
                      <p>Primary creator identity for this workspace.</p>
                    </div>
                  </div>
                  <div className="stageSection__body">
                    <p className="metaLine">{formatWalletAddress(ownerWallet)}</p>
                    <button className="uiButton uiButton--danger" type="button" onClick={onDisconnectWallet}>
                      Disconnect Wallet
                    </button>
                  </div>
                </section>
              </div>
            </>
          ) : null}
        </section>

        <aside className="workspacePane workspacePane--rail">{rightRail}</aside>
      </section>

      <OverlayPanel open={createModalOpen} onClose={() => setCreateModalOpen(false)} title="Create Station" mode="center">
        <form className="fieldGrid" onSubmit={(event) => void onCreateStation(event)}>
          <label className="field">
            <span>Station Name</span>
            <input className="uiInput" value={name} onChange={(event) => setName(event.target.value)} required disabled={creating} />
          </label>
          <label className="field">
            <span>Description</span>
            <textarea className="uiTextarea" value={description} onChange={(event) => setDescription(event.target.value)} disabled={creating} />
          </label>
          <label className="field">
            <span>Stream Mode</span>
            <select
              className="uiSelect"
              value={streamMode}
              onChange={(event) => setStreamMode(event.target.value === "radio" ? "radio" : "video")}
              disabled={creating}
            >
              <option value="video">Video</option>
              <option value="radio">Radio</option>
            </select>
          </label>
          <div className="pageBanner__actions">
            <button className="uiButton uiButton--accent" type="submit" disabled={creating || !name.trim()}>
              {creating ? "Creating" : "Create Station"}
            </button>
            <button className="uiButton uiButton--secondary" type="button" onClick={() => setCreateModalOpen(false)}>
              Cancel
            </button>
          </div>
        </form>
      </OverlayPanel>

      <OverlayPanel open={uploadModalOpen} onClose={() => setUploadModalOpen(false)} title="Upload Library Asset" mode="center">
        <form className="fieldGrid" onSubmit={(event) => void onUploadLibraryAsset(event)}>
          <label className="field">
            <span>Media File</span>
            <input
              className="uiFile"
              type="file"
              required
              onChange={(event) => setLibraryFile(event.target.files?.[0] ?? null)}
              disabled={uploadingLibrary}
            />
          </label>
          <label className="field">
            <span>Optional Title</span>
            <input
              className="uiInput"
              value={libraryTitle}
              onChange={(event) => setLibraryTitle(event.target.value)}
              disabled={uploadingLibrary}
            />
          </label>
          <label className="field">
            <span>Insertion Category</span>
            <select
              className="uiSelect"
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

          {uploadingLibrary ? (
            <>
              <p className="metaLine">
                <span>{libraryUploadPercent < 100 ? "Uploading file" : "Processing and compressing"}</span>
                <span>{libraryUploadPercent}%</span>
              </p>
              <div className="progressBar">
                <span style={{ width: `${libraryUploadPercent}%` }} />
              </div>
              {libraryUploadTotalBytes > 0 ? (
                <p className="emptyState">
                  {Math.round(libraryUploadLoadedBytes / (1024 * 1024))}MB / {Math.round(libraryUploadTotalBytes / (1024 * 1024))}MB
                </p>
              ) : null}
            </>
          ) : null}

          <div className="pageBanner__actions">
            <button className="uiButton uiButton--accent" type="submit" disabled={uploadingLibrary || !libraryFile}>
              {uploadingLibrary ? "Uploading" : "Upload"}
            </button>
            <button className="uiButton uiButton--secondary" type="button" onClick={() => setUploadModalOpen(false)}>
              Cancel
            </button>
          </div>
        </form>
      </OverlayPanel>

      <OverlayPanel open={leftDrawerOpen} onClose={() => setLeftDrawerOpen(false)} title="Workspace Navigation" mode="left">
        {leftRail}
      </OverlayPanel>

      <OverlayPanel open={rightDrawerOpen} onClose={() => setRightDrawerOpen(false)} title="Account Snapshot" mode="right">
        {rightRail}
      </OverlayPanel>
    </main>
  );
}
