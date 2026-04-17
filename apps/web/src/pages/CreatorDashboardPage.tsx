import { FormEvent, useEffect, useMemo, useState } from "react";
import { Link, Navigate, useNavigate } from "react-router-dom";
import { createChannel, getChannelStatus, listChannels, listLibraryAssets, uploadLibraryAsset } from "../api";
import AppIcon from "../components/AppIcon";
import OverlayPanel from "../components/OverlayPanel";
import type { Asset, AssetInsertionCategory, ChannelSummary, PlayoutState, StreamMode } from "../types";
import { disconnectWallet, formatWalletAddress, getStoredWalletAddress } from "../wallet";

type DashboardSection = "stations" | "library" | "account";

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
  const [railOpen, setRailOpen] = useState(false);
  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [uploadModalOpen, setUploadModalOpen] = useState(false);

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
      setCreateModalOpen(false);
      setInfo(
        [
          "Station created. Opening manager...",
          response.livepeerWarning ? `Livepeer warning: ${response.livepeerWarning}` : null
        ]
          .filter(Boolean)
          .join(" ")
      );
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

  const rail = (
    <>
      <section className="railBlock">
        <div className="railBlock__head">
          <h3>Workspace</h3>
          <p>Choose your active operating lane.</p>
        </div>
        <div className="railNav">
          <button
            type="button"
            data-active={section === "stations"}
            onClick={() => {
              setSection("stations");
              setRailOpen(false);
            }}
          >
            <span className="uiInline">
              <AppIcon name="monitor" />
              Stations
            </span>
          </button>
          <button
            type="button"
            data-active={section === "library"}
            onClick={() => {
              setSection("library");
              setRailOpen(false);
            }}
          >
            <span className="uiInline">
              <AppIcon name="library" />
              Library
            </span>
          </button>
          <button
            type="button"
            data-active={section === "account"}
            onClick={() => {
              setSection("account");
              setRailOpen(false);
            }}
          >
            <span className="uiInline">
              <AppIcon name="user" />
              Account
            </span>
          </button>
        </div>
      </section>

      <section className="railBlock">
        <div className="railBlock__head">
          <h3>Session</h3>
          <p>{formatWalletAddress(ownerWallet)}</p>
        </div>
        <p className="emptyState">Session controls are available in the Account section.</p>
      </section>
    </>
  );

  return (
    <main className="routeFrame routeFrame--workspace">
      {error ? <div className="inlineAlert inlineAlert--error">{error}</div> : null}
      {info ? <div className="inlineAlert inlineAlert--info">{info}</div> : null}

      <section className="workspaceShell">
        <aside className="workspaceRail">{rail}</aside>

        <section className="workspaceMain">
          <header className="workspaceHead">
            <div>
              <h1>Creator Workspace</h1>
              <p>
                Single-canvas operations flow for station management, media ingestion, and account administration.
              </p>
            </div>
            <div className="workspaceHead__actions">
              {section === "stations" ? (
                <button className="uiButton uiButton--accent" type="button" onClick={() => setCreateModalOpen(true)}>
                  <AppIcon name="plus" />
                  New Station
                </button>
              ) : null}
              {section === "library" ? (
                <button className="uiButton uiButton--accent" type="button" onClick={() => setUploadModalOpen(true)}>
                  <AppIcon name="upload" />
                  Upload Media
                </button>
              ) : null}
              <button className="uiButton uiButton--ghost mobileOnly" type="button" onClick={() => setRailOpen(true)}>
                <AppIcon name="menu" />
                Open Navigation
              </button>
            </div>
          </header>

          <section className="summaryStrip" aria-label="Workspace Metrics">
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

          <section className="workspaceContent">
            {section === "stations" ? (
              <section className="workspaceSection">
                <header className="workspaceSection__head">
                  <div>
                    <h2>Station Roster</h2>
                    <p>Live channels are prioritized, then sorted by creation time.</p>
                  </div>
                  <button className="uiButton uiButton--secondary" type="button" onClick={() => void refreshStations()} disabled={loadingStations}>
                    <AppIcon name="refresh" />
                    {loadingStations ? "Refreshing" : "Refresh"}
                  </button>
                </header>
                <div className="workspaceSection__body">
                  {loadingStations ? <p className="loadingState">Loading stations...</p> : null}
                  {!loadingStations && stations.length === 0 ? (
                    <p className="emptyState">No stations yet. Create the first station to start your stream flow.</p>
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
                              <AppIcon name="monitor" />
                              Manage
                            </Link>
                            <Link className="uiButton uiButton--secondary" to={`/stations/${station.summary.channel.id}/preview`}>
                              <AppIcon name="eye" />
                              Preview
                            </Link>
                          </div>
                        </article>
                      ))}
                    </div>
                  ) : null}
                </div>
              </section>
            ) : null}

            {section === "library" ? (
              <section className="workspaceSection">
                <header className="workspaceSection__head">
                  <div>
                    <h2>Global Media Library</h2>
                    <p>Wallet-scoped assets ready for import across all stations.</p>
                  </div>
                  <button className="uiButton uiButton--secondary" type="button" onClick={() => void refreshLibrary()} disabled={loadingLibrary}>
                    <AppIcon name="refresh" />
                    {loadingLibrary ? "Refreshing" : "Refresh"}
                  </button>
                </header>
                <div className="workspaceSection__body">
                  {libraryAssets.length === 0 ? <p className="emptyState">No assets uploaded yet.</p> : null}

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
                                <AppIcon name="eye" />
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
            ) : null}

            {section === "account" ? (
              <section className="workspaceSection">
                <header className="workspaceSection__head">
                  <div>
                    <h2>Account</h2>
                    <p>Wallet identity and session controls.</p>
                  </div>
                </header>
                <div className="workspaceSection__body">
                  <p className="metaLine">Connected wallet: {ownerWallet}</p>
                  <button className="uiButton uiButton--danger" type="button" onClick={onDisconnectWallet}>
                    <AppIcon name="close" />
                    Disconnect Wallet
                  </button>
                </div>
              </section>
            ) : null}
          </section>
        </section>
      </section>

      <OverlayPanel open={railOpen} onClose={() => setRailOpen(false)} title="Workspace Navigation" mode="left">
        {rail}
      </OverlayPanel>

      <OverlayPanel
        open={createModalOpen}
        onClose={() => setCreateModalOpen(false)}
        title="Create Station"
        subtitle="Set station identity and output mode for this channel."
        mode="center"
      >
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
          <div className="modalActions">
            <button className="uiButton uiButton--accent" type="submit" disabled={creating || !name.trim()}>
              <AppIcon name="plus" />
              {creating ? "Creating" : "Create Station"}
            </button>
            <button className="uiButton uiButton--secondary" type="button" onClick={() => setCreateModalOpen(false)}>
              <AppIcon name="close" />
              Cancel
            </button>
          </div>
        </form>
      </OverlayPanel>

      <OverlayPanel
        open={uploadModalOpen}
        onClose={() => setUploadModalOpen(false)}
        title="Upload Library Asset"
        subtitle="Upload once, then import into any station workflow."
        mode="center"
      >
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
            <input className="uiInput" value={libraryTitle} onChange={(event) => setLibraryTitle(event.target.value)} disabled={uploadingLibrary} />
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

          <div className="modalActions">
            <button className="uiButton uiButton--accent" type="submit" disabled={uploadingLibrary || !libraryFile}>
              <AppIcon name="upload" />
              {uploadingLibrary ? "Uploading" : "Upload"}
            </button>
            <button className="uiButton uiButton--secondary" type="button" onClick={() => setUploadModalOpen(false)}>
              <AppIcon name="close" />
              Cancel
            </button>
          </div>
        </form>
      </OverlayPanel>
    </main>
  );
}
