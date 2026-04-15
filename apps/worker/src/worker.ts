import { promises as fs } from "node:fs";
import path from "node:path";
import type {
  Asset,
  Channel,
  DatabaseSchema,
  LivepeerConfig,
  PlayoutCommand,
  PlayoutState
} from "@openchannel/shared";
import { HLS_ROOT, POLL_INTERVAL_MS, UPLOAD_ROOT } from "./config.js";
import { getChannel, getOrCreatePlayoutState, readDb, transaction } from "./db.js";
import {
  resetChannelOutput,
  startHlsSegmenter,
  startRtmpForwarder,
  type FfmpegSession
} from "./ffmpeg.js";

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
}

function orderedPlaylistAssets(db: DatabaseSchema, channelId: string): Asset[] {
  const byId = new Map(db.assets.filter((asset) => asset.channelId === channelId).map((asset) => [asset.id, asset]));

  return db.playlistItems
    .filter((item) => item.channelId === channelId)
    .sort((a, b) => a.position - b.position)
    .map((item) => byId.get(item.assetId))
    .filter((asset): asset is Asset => Boolean(asset));
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
    return { asset: adPool[adIndex], mode: "ad", advanceQueueIndex: true };
  }

  const shouldInsertAd = (() => {
    if (adPool.length === 0) {
      return false;
    }

    if (channel.adTriggerMode === "disabled") {
      return false;
    }

    if (channel.adTriggerMode === "time_interval") {
      const lastAdMs = state.lastAdAt ? Date.parse(state.lastAdAt) : Date.parse(state.updatedAt);
      const intervalMs = Math.max(30, channel.adTimeIntervalSec || 0) * 1000;
      return !Number.isNaN(lastAdMs) && Date.now() - lastAdMs >= intervalMs;
    }

    return channel.adInterval > 0 && state.programCountSinceAd >= channel.adInterval;
  })();

  if (shouldInsertAd) {
    const adIndex = Math.abs(state.queueIndex) % adPool.length;
    return { asset: adPool[adIndex], mode: "ad", advanceQueueIndex: false };
  }

  const index = Math.abs(state.queueIndex) % programQueue.length;
  return { asset: programQueue[index], mode: "program", advanceQueueIndex: true };
}

function getLivepeerConfig(db: DatabaseSchema, channelId: string): LivepeerConfig | undefined {
  return db.livepeerConfigs.find((entry) => entry.channelId === channelId);
}

async function manifestHasSegments(manifestPath: string): Promise<boolean> {
  try {
    const content = await fs.readFile(manifestPath, "utf8");
    return content.includes(".ts");
  } catch {
    return false;
  }
}

async function resolveRadioBackgroundPath(backgroundUrl: string | undefined): Promise<string | undefined> {
  if (!backgroundUrl) {
    return undefined;
  }

  const relative = backgroundUrl.startsWith("/uploads/")
    ? backgroundUrl.slice("/uploads/".length)
    : backgroundUrl.replace(/^\/+/, "");
  if (!relative) {
    return undefined;
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
  private livepeerSession?: FfmpegSession;
  private livepeerLoopPromise?: Promise<void>;
  private livepeerStopRequested = false;
  private livepeerIngestUrl?: string;
  private outputDir?: string;
  private stopRequested = false;
  private skipRequested = false;

  constructor(private readonly channelId: string) {}

  isActive() {
    return Boolean(this.loopPromise);
  }

  start() {
    if (this.loopPromise) {
      return;
    }

    this.stopRequested = false;
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
    this.stopLivepeerForwarder();
  }

  skip() {
    if (!this.currentSession) {
      return;
    }

    this.skipRequested = true;
    this.currentSession.process.kill("SIGTERM");
  }

  syncLivepeer(config: LivepeerConfig | undefined) {
    if (!this.loopPromise || !this.outputDir) {
      return;
    }

    if (config?.enabled && config.ingestUrl) {
      this.startLivepeerForwarder(this.outputDir, config.ingestUrl);
      return;
    }

    this.stopLivepeerForwarder();
  }

  async waitForStop(timeoutMs = 5000) {
    if (!this.loopPromise) {
      return;
    }

    await Promise.race([this.loopPromise, sleep(timeoutMs)]);
  }

  private stopLivepeerForwarder() {
    this.livepeerStopRequested = true;
    this.livepeerSession?.process.kill("SIGTERM");
  }

  private startLivepeerForwarder(outputDir: string, ingestUrl: string) {
    if (this.livepeerLoopPromise && this.livepeerIngestUrl === ingestUrl) {
      return;
    }

    this.stopLivepeerForwarder();
    this.livepeerStopRequested = false;
    this.livepeerIngestUrl = ingestUrl;
    console.log(`[worker] channel ${this.channelId} livepeer forwarder start -> ${ingestUrl}`);
    this.livepeerLoopPromise = this.runLivepeerForwarderLoop(outputDir, ingestUrl)
      .catch((error) => {
        console.error(`[worker] channel ${this.channelId} livepeer forwarder failed`, error);
      })
      .finally(() => {
        this.livepeerLoopPromise = undefined;
        this.livepeerIngestUrl = undefined;
      });
  }

  private async runLivepeerForwarderLoop(outputDir: string, ingestUrl: string) {
    const manifestPath = path.join(outputDir, "index.m3u8");

    while (!this.stopRequested && !this.livepeerStopRequested) {
      const hasSegments = await manifestHasSegments(manifestPath);
      if (!hasSegments) {
        await sleep(300);
        continue;
      }

      this.livepeerSession = await startRtmpForwarder(manifestPath, ingestUrl);
      const result = await this.livepeerSession.finished;
      this.livepeerSession = undefined;

      if (this.stopRequested || this.livepeerStopRequested) {
        break;
      }

      const failed = result.code !== 0 && result.signal !== "SIGTERM";
      if (failed) {
        await transaction((db) => {
          const state = getOrCreatePlayoutState(db, this.channelId);
          state.lastError = `Livepeer forwarder failed (${result.code}). ${result.stderr.slice(-200)}`;
          state.updatedAt = nowIso();
        });
      }

      await sleep(400);
    }
  }

  private async run() {
    const outputDir = path.join(HLS_ROOT, this.channelId);
    await resetChannelOutput(outputDir);
    this.outputDir = outputDir;
    console.log(`[worker] channel ${this.channelId} playout loop started`);

    while (!this.stopRequested) {
      const db = await readDb();
      const channel = getChannel(db, this.channelId);
      const state = db.playoutStates.find((entry) => entry.channelId === this.channelId);
      if (!channel || !state || !state.isRunning) {
        break;
      }
      const livepeerConfig = getLivepeerConfig(db, this.channelId);
      if (livepeerConfig?.enabled && livepeerConfig.ingestUrl) {
        this.startLivepeerForwarder(outputDir, livepeerConfig.ingestUrl);
      } else {
        this.stopLivepeerForwarder();
      }

      const next = chooseNextAsset(channel, state, db);
      if (!next) {
        await transaction((editable) => {
          const liveState = getOrCreatePlayoutState(editable, this.channelId);
          liveState.currentAssetId = undefined;
          liveState.currentAssetTitle = undefined;
          liveState.currentStartedAt = undefined;
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
        liveState.lastError = undefined;
        liveState.updatedAt = nowIso();
      });

      const radioBackgroundPath =
        channel.streamMode === "radio" ? await resolveRadioBackgroundPath(channel.radioBackgroundUrl) : undefined;
      this.currentSession = await startHlsSegmenter(next.asset.localPath, outputDir, {
        streamMode: channel.streamMode,
        assetMediaKind: next.asset.mediaKind,
        radioBackgroundPath
      });
      const result = await this.currentSession.finished;
      this.currentSession = undefined;

      const skipped = this.skipRequested;
      this.skipRequested = false;

      const postState = await transaction((editable) => {
        const liveState = getOrCreatePlayoutState(editable, this.channelId);
        const stillRunning = liveState.isRunning && !this.stopRequested;

        const expectedTermination = skipped || !stillRunning;
        const ffmpegFailed = result.code !== 0 && result.signal !== "SIGTERM";

        if (stillRunning) {
          if (next.mode === "program") {
            liveState.queueIndex += 1;
            liveState.programCountSinceAd += 1;
          } else {
            if (next.advanceQueueIndex) {
              liveState.queueIndex += 1;
            }
            liveState.programCountSinceAd = 0;
            liveState.lastAdAt = nowIso();
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
        this.stopLivepeerForwarder();
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
      liveState.updatedAt = nowIso();
    });

    this.stopLivepeerForwarder();
    await this.livepeerLoopPromise;

    this.stopRequested = false;
    this.skipRequested = false;
    this.outputDir = undefined;
    console.log(`[worker] channel ${this.channelId} playout loop stopped`);
  }
}

const runtimes = new Map<string, ChannelRuntime>();

function runtimeFor(channelId: string): ChannelRuntime {
  const existing = runtimes.get(channelId);
  if (existing) {
    return existing;
  }

  const runtime = new ChannelRuntime(channelId);
  runtimes.set(channelId, runtime);
  return runtime;
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

      state.isRunning = true;
      state.lastError = undefined;
      state.lastAdAt = nowIso();
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
      state.updatedAt = nowIso();
    });

    runtimeFor(command.channelId).stop();
    return;
  }

  if (command.action === "skip" || command.action === "previous") {
    runtimeFor(command.channelId).skip();
  }
}

let pollInFlight = false;

async function poll() {
  if (pollInFlight) {
    return;
  }
  pollInFlight = true;

  try {
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
      runtime.syncLivepeer(getLivepeerConfig(db, channelId));
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

  const activeRuntimes = [...runtimes.values()];
  for (const runtime of activeRuntimes) {
    runtime.stop();
  }
  await Promise.all(activeRuntimes.map((runtime) => runtime.waitForStop()));
  process.exit(0);
}

process.once("SIGINT", () => {
  void shutdown("SIGINT");
});

process.once("SIGTERM", () => {
  void shutdown("SIGTERM");
});
