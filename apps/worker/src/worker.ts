import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type {
  Asset,
  Channel,
  DatabaseSchema,
  LivepeerConfig,
  PlayoutCommand,
  PlayoutState
} from "@openchannel/shared";
import { HLS_ROOT, MEDIA_BASE_URL, POLL_INTERVAL_MS, UPLOAD_ROOT } from "./config.js";
import { getChannel, getOrCreatePlayoutState, readDb, transaction } from "./db.js";
import { resetChannelOutput, startHlsSegmenter, type FfmpegSession } from "./ffmpeg.js";
import { closeRedis, refreshLeadershipLease, releaseLeadershipLease } from "./redis.js";

function nowIso(): string {
  return new Date().toISOString();
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface NextAsset {
  asset: Asset;
  mode: "program" | "ad";
  advanceQueueIndex: boolean;
  programCompleted: boolean;
  playbackOffsetSec?: number;
  playbackDurationSec?: number;
}

function ensureProgramPlaylist(db: DatabaseSchema, channelId: string): number {
  const existing = db.playlistItems
    .filter((item) => item.channelId === channelId)
    .sort((a, b) => a.position - b.position);
  if (existing.length > 0) {
    return existing.length;
  }

  const programs = db.assets
    .filter((asset) => asset.channelId === channelId && asset.type === "program")
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  if (programs.length === 0) {
    return 0;
  }

  programs.forEach((asset, position) => {
    db.playlistItems.push({
      id: randomUUID(),
      channelId,
      assetId: asset.id,
      position,
      createdAt: nowIso()
    });
  });

  return programs.length;
}

function orderedPlaylistAssets(db: DatabaseSchema, channelId: string): Asset[] {
  const byId = new Map(db.assets.filter((asset) => asset.channelId === channelId).map((asset) => [asset.id, asset]));

  return db.playlistItems
    .filter((item) => item.channelId === channelId)
    .sort((a, b) => a.position - b.position)
    .map((item) => byId.get(item.assetId))
    .filter((asset): asset is Asset => Boolean(asset));
}

function normalizedProgramOffset(state: PlayoutState): number {
  if (!Number.isFinite(state.currentProgramOffsetSec)) {
    return 0;
  }
  return Math.max(0, Math.floor(state.currentProgramOffsetSec ?? 0));
}

function shouldInsertAd(channel: Channel, state: PlayoutState, hasAds: boolean): boolean {
  if (!hasAds || channel.adTriggerMode === "disabled") {
    return false;
  }

  if (channel.adTriggerMode === "time_interval") {
    const lastAdMs = state.lastAdAt ? Date.parse(state.lastAdAt) : Date.parse(state.updatedAt);
    const intervalMs = Math.max(30, channel.adTimeIntervalSec || 0) * 1000;
    return !Number.isNaN(lastAdMs) && Date.now() - lastAdMs >= intervalMs;
  }

  return channel.adInterval > 0 && state.programCountSinceAd >= channel.adInterval;
}

function chooseNextAsset(channel: Channel, state: PlayoutState, db: DatabaseSchema): NextAsset | undefined {
  const playlistAssets = orderedPlaylistAssets(db, channel.id);
  const programQueue = playlistAssets.filter((asset) => asset.type === "program");
  const adPool = db.assets.filter((asset) => asset.channelId === channel.id && asset.type === "ad");

  if (programQueue.length === 0) {
    if (adPool.length === 0) {
      return undefined;
    }

    const adIndex = Math.abs(state.queueIndex) % adPool.length;
    return { asset: adPool[adIndex], mode: "ad", advanceQueueIndex: true, programCompleted: false };
  }

  if (shouldInsertAd(channel, state, adPool.length > 0)) {
    const adIndex = Math.abs(state.queueIndex) % adPool.length;
    return { asset: adPool[adIndex], mode: "ad", advanceQueueIndex: false, programCompleted: false };
  }

  const index = Math.abs(state.queueIndex) % programQueue.length;
  const asset = programQueue[index];
  const currentOffsetSec = normalizedProgramOffset(state);
  const assetDurationSec = Number.isFinite(asset.durationSec) ? Math.max(0, Math.floor(asset.durationSec ?? 0)) : 0;
  const boundedOffsetSec = Math.min(currentOffsetSec, Math.max(0, assetDurationSec - 1));

  if (channel.adTriggerMode === "time_interval" && adPool.length > 0 && assetDurationSec > 0) {
    const intervalSec = Math.max(30, Math.floor(channel.adTimeIntervalSec || 0));
    const remainingSec = Math.max(0, assetDurationSec - boundedOffsetSec);
    if (remainingSec > intervalSec) {
      return {
        asset,
        mode: "program",
        advanceQueueIndex: false,
        programCompleted: false,
        playbackOffsetSec: boundedOffsetSec,
        playbackDurationSec: intervalSec
      };
    }
  }

  return {
    asset,
    mode: "program",
    advanceQueueIndex: true,
    programCompleted: true,
    playbackOffsetSec: boundedOffsetSec > 0 ? boundedOffsetSec : undefined
  };
}

function getLivepeerConfig(db: DatabaseSchema, channelId: string): LivepeerConfig | undefined {
  return db.livepeerConfigs.find((entry) => entry.channelId === channelId);
}

function toUploadRelativePath(localPath: string): string | undefined {
  const relative = path.relative(UPLOAD_ROOT, localPath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    return undefined;
  }
  return relative.split(path.sep).join("/");
}

function encodePathSegments(value: string): string {
  return value
    .split("/")
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function toMediaUploadUrl(relativeUploadPath: string): string | undefined {
  if (!MEDIA_BASE_URL) {
    return undefined;
  }
  return `${MEDIA_BASE_URL}/uploads/${encodePathSegments(relativeUploadPath)}`;
}

function resolveAssetInputPath(asset: Asset): string {
  const relativeUploadPath = toUploadRelativePath(asset.localPath);
  const remoteUrl = relativeUploadPath ? toMediaUploadUrl(relativeUploadPath) : undefined;
  return remoteUrl ?? asset.localPath;
}

async function resolveRadioBackgroundPath(backgroundUrl: string | undefined): Promise<string | undefined> {
  if (!backgroundUrl) {
    return undefined;
  }

  if (/^https?:\/\//i.test(backgroundUrl)) {
    return backgroundUrl;
  }

  const relative = backgroundUrl.startsWith("/uploads/")
    ? backgroundUrl.slice("/uploads/".length)
    : backgroundUrl.replace(/^\/+/, "");
  if (!relative) {
    return undefined;
  }

  const remoteUrl = toMediaUploadUrl(relative);
  if (remoteUrl) {
    return remoteUrl;
  }

  const candidate = path.join(UPLOAD_ROOT, relative);
  try {
    await fs.access(candidate);
    return candidate;
  } catch {
    return undefined;
  }
}

class ChannelRuntime {
  private loopPromise?: Promise<void>;
  private currentSession?: FfmpegSession;
  private stopRequested = false;
  private skipRequested = false;
  private previousRequested = false;

  constructor(private readonly channelId: string) {}

  isActive() {
    return Boolean(this.loopPromise);
  }

  start() {
    if (this.loopPromise) {
      return;
    }

    this.stopRequested = false;
    this.previousRequested = false;
    this.loopPromise = this.run()
      .catch((error) => {
        console.error(`[worker] channel ${this.channelId} runtime failed`, error);
      })
      .finally(() => {
        this.loopPromise = undefined;
      });
  }

  stop() {
    this.stopRequested = true;
    this.currentSession?.process.kill("SIGTERM");
  }

  skip() {
    if (!this.currentSession) {
      return;
    }

    this.skipRequested = true;
    this.previousRequested = false;
    this.currentSession.process.kill("SIGTERM");
  }

  previous() {
    if (!this.currentSession) {
      return;
    }

    this.skipRequested = true;
    this.previousRequested = true;
    this.currentSession.process.kill("SIGTERM");
  }

  async waitForStop(timeoutMs = 5000) {
    if (!this.loopPromise) {
      return;
    }

    await Promise.race([this.loopPromise, sleep(timeoutMs)]);
  }

  private async run() {
    const outputDir = path.join(HLS_ROOT, this.channelId);
    await resetChannelOutput(outputDir);
    console.log(`[worker] channel ${this.channelId} playout loop started`);

    while (!this.stopRequested) {
      const db = await readDb();
      const channel = getChannel(db, this.channelId);
      const state = db.playoutStates.find((entry) => entry.channelId === this.channelId);
      if (!channel || !state || !state.isRunning) {
        break;
      }
      const livepeerConfig = getLivepeerConfig(db, this.channelId);
      const livepeerIngestUrl = livepeerConfig?.enabled ? livepeerConfig.ingestUrl : undefined;

      const next = chooseNextAsset(channel, state, db);
      if (!next) {
        await transaction((editable) => {
          const liveState = getOrCreatePlayoutState(editable, this.channelId);
          liveState.currentAssetId = undefined;
          liveState.currentAssetTitle = undefined;
          liveState.currentStartedAt = undefined;
          liveState.currentProgramOffsetSec = 0;
          liveState.lastError = "No program assets in playlist.";
          liveState.updatedAt = nowIso();
        });

        await sleep(1500);
        continue;
      }

      await transaction((editable) => {
        const liveState = getOrCreatePlayoutState(editable, this.channelId);
        liveState.currentAssetId = next.asset.id;
        liveState.currentAssetTitle = next.asset.title;
        liveState.currentStartedAt = nowIso();
        if (next.mode === "program") {
          liveState.currentProgramOffsetSec = Math.max(0, Math.floor(next.playbackOffsetSec ?? 0));
        }
        liveState.lastError = undefined;
        liveState.updatedAt = nowIso();
      });

      const radioBackgroundPath =
        channel.streamMode === "radio" ? await resolveRadioBackgroundPath(channel.radioBackgroundUrl) : undefined;
      const assetInputPath = resolveAssetInputPath(next.asset);
      this.currentSession = await startHlsSegmenter(assetInputPath, outputDir, {
        streamMode: channel.streamMode,
        assetMediaKind: next.asset.mediaKind,
        radioBackgroundPath,
        startOffsetSec: next.playbackOffsetSec,
        maxDurationSec: next.playbackDurationSec,
        livepeerIngestUrl
      });
      const result = await this.currentSession.finished;
      this.currentSession = undefined;

      const skipped = this.skipRequested;
      const movedToPrevious = this.previousRequested;
      this.skipRequested = false;
      this.previousRequested = false;

      const postState = await transaction((editable) => {
        const liveState = getOrCreatePlayoutState(editable, this.channelId);
        const stillRunning = liveState.isRunning && !this.stopRequested;

        const expectedTermination = skipped || !stillRunning;
        const ffmpegFailed = result.code !== 0 && result.signal !== "SIGTERM";
        const currentOffsetSec = Math.max(0, Math.floor(next.playbackOffsetSec ?? 0));
        const segmentDurationSec = Math.max(0, Math.floor(next.playbackDurationSec ?? 0));
        const resumeOffsetSec = currentOffsetSec + segmentDurationSec;

        if (stillRunning) {
          if (skipped) {
            if (movedToPrevious) {
              // API already decrements queueIndex for "previous".
              liveState.currentProgramOffsetSec = 0;
            } else if (next.mode === "program") {
              // Skip current program (or chunk) and move to next item.
              liveState.queueIndex += 1;
              liveState.currentProgramOffsetSec = 0;
            } else {
              // Skip current ad and resume regular program flow.
              if (next.advanceQueueIndex) {
                liveState.queueIndex += 1;
              }
              liveState.programCountSinceAd = 0;
              liveState.lastAdAt = nowIso();
            }
          } else {
            if (next.mode === "program") {
              if (next.programCompleted) {
                liveState.queueIndex += 1;
                liveState.programCountSinceAd += 1;
                liveState.currentProgramOffsetSec = 0;
              } else {
                // Time-sliced program chunk finished; resume from this offset after ad breaks.
                liveState.currentProgramOffsetSec = resumeOffsetSec;
              }
            } else {
              if (next.advanceQueueIndex) {
                liveState.queueIndex += 1;
              }
              liveState.programCountSinceAd = 0;
              liveState.lastAdAt = nowIso();
            }
          }
        }

        liveState.currentAssetId = undefined;
        liveState.currentAssetTitle = undefined;
        liveState.currentStartedAt = undefined;
        if (ffmpegFailed && !expectedTermination) {
          liveState.lastError = `ffmpeg failed (${result.code}). ${result.stderr.slice(-220)}`;
        }
        liveState.updatedAt = nowIso();

        return {
          shouldContinue: stillRunning,
          ffmpegFailed
        };
      });

      if (postState.ffmpegFailed && !skipped) {
        await sleep(1000);
      }

      if (skipped) {
        // Drop stale buffered segments so clients jump to the next item as quickly as possible.
        await resetChannelOutput(outputDir);
      }

      if (!postState.shouldContinue) {
        break;
      }
    }

    await transaction((editable) => {
      const liveState = getOrCreatePlayoutState(editable, this.channelId);
      if (this.stopRequested) {
        liveState.isRunning = false;
      }
      liveState.currentAssetId = undefined;
      liveState.currentAssetTitle = undefined;
      liveState.currentStartedAt = undefined;
      liveState.currentProgramOffsetSec = 0;
      liveState.updatedAt = nowIso();
    });

    this.stopRequested = false;
    this.skipRequested = false;
    this.previousRequested = false;
    console.log(`[worker] channel ${this.channelId} playout loop stopped`);
  }
}

const runtimes = new Map<string, ChannelRuntime>();
const workerInstanceId = `${process.env.RAILWAY_REPLICA_ID ?? process.pid}-${randomUUID()}`;
let isLeader = false;

function runtimeFor(channelId: string): ChannelRuntime {
  const existing = runtimes.get(channelId);
  if (existing) {
    return existing;
  }

  const runtime = new ChannelRuntime(channelId);
  runtimes.set(channelId, runtime);
  return runtime;
}

async function stopAllRuntimes(reason: string) {
  const activeRuntimes = [...runtimes.values()];
  if (activeRuntimes.length === 0) {
    return;
  }

  for (const runtime of activeRuntimes) {
    runtime.stop();
  }
  await Promise.all(activeRuntimes.map((runtime) => runtime.waitForStop()));
  runtimes.clear();
  console.log(`[worker] ${reason}; stopped ${activeRuntimes.length} active runtime(s).`);
}

async function transitionToFollower(reason: string) {
  if (!isLeader) {
    return;
  }

  isLeader = false;
  console.log(`[worker] leadership released: ${reason}`);
  await stopAllRuntimes("leadership change");
}

async function applyCommand(command: PlayoutCommand) {
  if (command.action === "start") {
    const payload = await transaction((db) => {
      const channel = getChannel(db, command.channelId);
      const state = getOrCreatePlayoutState(db, command.channelId);
      if (!channel) {
        state.isRunning = false;
        state.lastError = "Start ignored: channel no longer exists.";
        state.updatedAt = nowIso();
        return { shouldStart: false };
      }

      const playlistCount = ensureProgramPlaylist(db, command.channelId);
      if (playlistCount === 0) {
        state.isRunning = false;
        state.lastError = "Start blocked: add at least one program asset to this station.";
        state.updatedAt = nowIso();
        return { shouldStart: false };
      }

      state.isRunning = true;
      state.lastError = undefined;
      state.lastAdAt = nowIso();
      state.currentProgramOffsetSec = 0;
      state.updatedAt = nowIso();
      return { shouldStart: true };
    });

    if (payload.shouldStart) {
      runtimeFor(command.channelId).start();
    }
    return;
  }

  if (command.action === "stop") {
    await transaction((db) => {
      const state = getOrCreatePlayoutState(db, command.channelId);
      state.isRunning = false;
      state.currentProgramOffsetSec = 0;
      state.updatedAt = nowIso();
    });

    runtimeFor(command.channelId).stop();
    return;
  }

  if (command.action === "skip") {
    runtimeFor(command.channelId).skip();
    return;
  }

  if (command.action === "previous") {
    runtimeFor(command.channelId).previous();
    return;
  }
}

let pollInFlight = false;

async function poll() {
  if (pollInFlight) {
    return;
  }
  pollInFlight = true;

  try {
    const hasLeadership = await refreshLeadershipLease(workerInstanceId);
    if (!hasLeadership) {
      await transitionToFollower("another worker holds the lease");
      return;
    }

    if (!isLeader) {
      isLeader = true;
      console.log(`[worker] leadership acquired (${workerInstanceId})`);
    }

    const { commands } = await transaction((db) => {
      const now = nowIso();
      const nowMs = Date.parse(now);
      const knownChannels = new Set(db.channels.map((channel) => channel.id));

      for (const schedule of db.streamSchedules) {
        if (!schedule.enabled || schedule.endedAt) {
          continue;
        }

        if (!knownChannels.has(schedule.channelId)) {
          schedule.enabled = false;
          schedule.endedAt = now;
          schedule.updatedAt = now;
          continue;
        }

        const startMs = Date.parse(schedule.startAt);
        const endMs = schedule.endAt ? Date.parse(schedule.endAt) : undefined;
        const hasInvalidDates =
          Number.isNaN(startMs) || (endMs !== undefined && (Number.isNaN(endMs) || endMs <= startMs));
        if (hasInvalidDates) {
          schedule.enabled = false;
          schedule.endedAt = now;
          schedule.updatedAt = now;
          const state = getOrCreatePlayoutState(db, schedule.channelId);
          state.lastError = "Invalid stream schedule ignored.";
          state.updatedAt = now;
          continue;
        }

        const state = getOrCreatePlayoutState(db, schedule.channelId);

        if (endMs !== undefined && nowMs >= endMs) {
          schedule.endedAt = now;
          schedule.updatedAt = now;

          const hasAnotherActiveWindow = db.streamSchedules.some((other) => {
            if (!other.enabled || other.id === schedule.id) {
              return false;
            }
            const otherStartMs = Date.parse(other.startAt);
            if (Number.isNaN(otherStartMs) || otherStartMs > nowMs) {
              return false;
            }
            if (!other.endAt) {
              return true;
            }
            const otherEndMs = Date.parse(other.endAt);
            return !Number.isNaN(otherEndMs) && otherEndMs > nowMs;
          });

          if (state.isRunning && !hasAnotherActiveWindow) {
            db.commands.push({
              id: `schedule-stop-${schedule.id}-${nowMs}`,
              channelId: schedule.channelId,
              action: "stop",
              createdAt: now
            });
            state.isRunning = false;
            state.updatedAt = now;
          }
          continue;
        }

        if (!schedule.startedAt && nowMs >= startMs) {
          schedule.startedAt = now;
          schedule.updatedAt = now;

          if (!state.isRunning) {
            state.queueIndex = 0;
            state.programCountSinceAd = 0;
            state.currentAssetId = undefined;
            state.currentAssetTitle = undefined;
            state.currentStartedAt = undefined;
            state.currentProgramOffsetSec = 0;
            state.lastAdAt = now;
            state.lastError = undefined;
            state.isRunning = true;
            state.updatedAt = now;

            db.commands.push({
              id: `schedule-start-${schedule.id}-${nowMs}`,
              channelId: schedule.channelId,
              action: "start",
              createdAt: now
            });
          }
        }
      }

      const commands = [...db.commands].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      db.commands = [];

      for (const state of db.playoutStates) {
        if (!state.isRunning) {
          continue;
        }

        if (!knownChannels.has(state.channelId)) {
          state.isRunning = false;
          state.lastError = "Channel missing. Playout halted.";
          state.updatedAt = nowIso();
          continue;
        }
      }
      return { commands };
    });

    for (const command of commands) {
      await applyCommand(command);
    }

    const db = await readDb();
    const activeChannels = Array.from(
      new Set(
        db.playoutStates.filter((state) => state.isRunning).map((state) => state.channelId)
      )
    );

    for (const channelId of activeChannels) {
      const runtime = runtimeFor(channelId);
      runtime.start();
    }

    for (const [channelId, runtime] of runtimes.entries()) {
      if (!activeChannels.includes(channelId) && !runtime.isActive()) {
        runtimes.delete(channelId);
      }
    }
  } catch (error) {
    console.error("[worker] poll error", error);
  } finally {
    pollInFlight = false;
  }
}

console.log(`[worker] OpenChannel playout worker started (poll interval ${POLL_INTERVAL_MS}ms)`);
poll();
const pollInterval = setInterval(poll, POLL_INTERVAL_MS);

let shuttingDown = false;

async function shutdown(signal: NodeJS.Signals) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  clearInterval(pollInterval);
  console.log(`[worker] ${signal} received, stopping active channels...`);

  await stopAllRuntimes("shutdown");
  await releaseLeadershipLease(workerInstanceId);
  await closeRedis();
  process.exit(0);
}

process.once("SIGINT", () => {
  void shutdown("SIGINT");
});

process.once("SIGTERM", () => {
  void shutdown("SIGTERM");
});
