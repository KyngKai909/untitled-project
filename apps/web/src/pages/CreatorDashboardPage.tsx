import { FormEvent, useEffect, useMemo, useState } from "react";
import { Link, Navigate, useNavigate } from "react-router-dom";
import { createChannel, getChannelStatus, listChannels, listLibraryAssets, uploadLibraryAsset } from "../api";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Textarea } from "../components/ui/textarea";
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
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

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
    setError(null);
    setInfo(null);

    try {
      const payload = await uploadLibraryAsset({
        ownerWallet,
        file: libraryFile,
        title: libraryTitle.trim() || undefined,
        type: normalized.type,
        insertionCategory: normalized.insertionCategory
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
    }
  }

  return (
    <main className="mx-auto w-full max-w-7xl space-y-4 px-4 py-6">
      <Card>
        <CardHeader>
          <CardTitle>Creator Dashboard</CardTitle>
          <CardDescription>
            Upload once to your global library, then import into stations for scheduling and live playout.
          </CardDescription>
        </CardHeader>
      </Card>

      {error ? (
        <div className="rounded-md border border-rose-500/40 bg-rose-500/10 p-3 text-sm text-rose-300">{error}</div>
      ) : null}
      {info ? (
        <div className="rounded-md border border-cyan-500/40 bg-cyan-500/10 p-3 text-sm text-cyan-200">{info}</div>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-[220px_1fr]">
        <Card>
          <CardHeader className="space-y-3">
            <Button variant="outline" onClick={() => setSidebarCollapsed((value) => !value)}>
              {sidebarCollapsed ? "Expand Menu" : "Collapse Menu"}
            </Button>
            <div className="space-y-2">
              <Button
                variant={section === "library" ? "default" : "ghost"}
                className="w-full justify-start"
                onClick={() => setSection("library")}
              >
                Library
              </Button>
              <Button
                variant={section === "stations" ? "default" : "ghost"}
                className="w-full justify-start"
                onClick={() => setSection("stations")}
              >
                Stations
              </Button>
              <Button
                variant={section === "account" ? "default" : "ghost"}
                className="w-full justify-start"
                onClick={() => setSection("account")}
              >
                Account
              </Button>
            </div>
          </CardHeader>
        </Card>

        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Creator Snapshot</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <div className="rounded-md border border-slate-800 p-3">
                <p className="text-xs uppercase tracking-wide text-slate-400">Stations</p>
                <p className="text-xl font-semibold">{snapshot.stations}</p>
              </div>
              <div className="rounded-md border border-slate-800 p-3">
                <p className="text-xs uppercase tracking-wide text-slate-400">Live</p>
                <p className="text-xl font-semibold">{snapshot.live}</p>
              </div>
              <div className="rounded-md border border-slate-800 p-3">
                <p className="text-xs uppercase tracking-wide text-slate-400">Programs</p>
                <p className="text-xl font-semibold">{snapshot.libraryPrograms}</p>
              </div>
              <div className="rounded-md border border-slate-800 p-3">
                <p className="text-xs uppercase tracking-wide text-slate-400">Ads / Sponsors</p>
                <p className="text-xl font-semibold">{snapshot.libraryAds}</p>
              </div>
            </CardContent>
          </Card>

          {section === "library" ? (
            <Card>
              <CardHeader className="flex flex-row items-start justify-between gap-3">
                <div>
                  <CardTitle>User Library</CardTitle>
                  <CardDescription>Global asset library for this creator wallet.</CardDescription>
                </div>
                <Button variant="outline" onClick={() => void refreshLibrary()} disabled={loadingLibrary}>
                  {loadingLibrary ? "Refreshing..." : "Refresh"}
                </Button>
              </CardHeader>
              <CardContent className="space-y-4">
                <form className="grid gap-3" onSubmit={(event) => void onUploadLibraryAsset(event)}>
                  <Input
                    type="file"
                    required
                    onChange={(event) => setLibraryFile(event.target.files?.[0] ?? null)}
                    disabled={uploadingLibrary}
                  />
                  <Input
                    value={libraryTitle}
                    onChange={(event) => setLibraryTitle(event.target.value)}
                    disabled={uploadingLibrary}
                    placeholder="Optional title"
                  />
                  <select
                    className="h-10 w-full rounded-md border border-slate-700 bg-slate-950/70 px-3 text-sm text-slate-100"
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
                  <Button type="submit" disabled={uploadingLibrary || !libraryFile}>
                    {uploadingLibrary ? "Uploading..." : "Upload To Global Library"}
                  </Button>
                </form>

                <div className="space-y-2">
                  {libraryAssets.length === 0 ? <p className="text-sm text-slate-400">No global library assets yet.</p> : null}
                  {libraryAssets.map((asset) => (
                    <div key={asset.id} className="flex items-center justify-between rounded-md border border-slate-800 p-3">
                      <div>
                        <p className="font-medium text-slate-100">{asset.title}</p>
                        <p className="text-sm text-slate-400">{asset.insertionCategory ?? asset.type} · {formatDateTime(asset.createdAt)}</p>
                      </div>
                      <div className="flex items-center gap-2">
                        <Badge variant="secondary">{asset.mediaKind}</Badge>
                        {asset.ipfsUrl ? (
                          <Button asChild size="sm" variant="outline">
                            <a href={asset.ipfsUrl} target="_blank" rel="noreferrer">IPFS</a>
                          </Button>
                        ) : null}
                      </div>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          ) : null}

          {section === "stations" ? (
            <Card>
              <CardHeader>
                <CardTitle>Stations</CardTitle>
                <CardDescription>Create stations and open station manager.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <form className="grid gap-3" onSubmit={(event) => void onCreateStation(event)}>
                  <Input
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    placeholder="Station name"
                    required
                    disabled={creating}
                  />
                  <Textarea
                    value={description}
                    onChange={(event) => setDescription(event.target.value)}
                    placeholder="Description"
                    disabled={creating}
                  />
                  <select
                    className="h-10 w-full rounded-md border border-slate-700 bg-slate-950/70 px-3 text-sm text-slate-100"
                    value={streamMode}
                    onChange={(event) => setStreamMode(event.target.value === "radio" ? "radio" : "video")}
                    disabled={creating}
                  >
                    <option value="video">Video</option>
                    <option value="radio">Radio</option>
                  </select>
                  <div className="flex flex-wrap gap-2">
                    <Button type="submit" disabled={!name.trim() || creating}>{creating ? "Creating..." : "Create Station"}</Button>
                    <Button variant="outline" type="button" disabled={loadingStations} onClick={() => void refreshStations()}>
                      {loadingStations ? "Refreshing..." : "Refresh Stations"}
                    </Button>
                  </div>
                </form>

                <div className="space-y-2">
                  {loadingStations ? <p className="text-sm text-slate-400">Loading stations...</p> : null}
                  {!loadingStations && stations.length === 0 ? (
                    <p className="text-sm text-slate-400">No stations yet. Create your first station above.</p>
                  ) : null}
                  {stations.map((station) => (
                    <div key={station.summary.channel.id} className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-slate-800 p-3">
                      <div>
                        <p className="font-medium">{station.summary.channel.name}</p>
                        <p className="text-sm text-slate-400">
                          {station.summary.channel.description || "No description"} · {station.summary.playlistCount} queued
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        <Badge variant={station.state?.isRunning ? "default" : "secondary"}>
                          {station.state?.isRunning ? "LIVE" : "OFF AIR"}
                        </Badge>
                        <Button asChild variant="outline" size="sm">
                          <Link to={`/stations/${station.summary.channel.id}`}>Manage</Link>
                        </Button>
                        <Button asChild variant="outline" size="sm">
                          <Link to={`/stations/${station.summary.channel.id}/preview`}>Preview</Link>
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          ) : null}

          {section === "account" ? (
            <Card>
              <CardHeader>
                <CardTitle>Account / Profile</CardTitle>
                <CardDescription>Wallet-scoped creator settings.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <p className="text-sm text-slate-400">Connected wallet</p>
                <p className="text-base font-medium">{formatWalletAddress(ownerWallet)}</p>
                <Button variant="outline" onClick={onDisconnectWallet}>Disconnect Wallet</Button>
              </CardContent>
            </Card>
          ) : null}
        </div>
      </div>
    </main>
  );
}
