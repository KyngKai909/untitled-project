import { promises as fs } from "node:fs";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import type { AssetMediaKind, StreamMode } from "@openchannel/shared";

export interface FfmpegSessionResult {
  code: number;
  signal: NodeJS.Signals | null;
  stderr: string;
}

export interface FfmpegSession {
  process: ChildProcess;
  finished: Promise<FfmpegSessionResult>;
}

interface HlsSegmenterOptions {
  streamMode?: StreamMode;
  assetMediaKind?: AssetMediaKind;
  radioBackgroundPath?: string;
  startOffsetSec?: number;
  maxDurationSec?: number;
}

export async function resetChannelOutput(outputDir: string): Promise<void> {
  await fs.rm(outputDir, { recursive: true, force: true });
  await fs.mkdir(outputDir, { recursive: true });
}

function sharedHlsArgs(segmentPattern: string, playlistPath: string): string[] {
  return [
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-g",
    "48",
    "-keyint_min",
    "48",
    "-sc_threshold",
    "0",
    "-c:a",
    "aac",
    "-ar",
    "48000",
    "-ac",
    "2",
    "-b:a",
    "128k",
    "-f",
    "hls",
    "-hls_time",
    "2",
    "-hls_list_size",
    "6",
    "-hls_delete_threshold",
    "1",
    "-hls_start_number_source",
    "epoch",
    "-hls_flags",
    "delete_segments+omit_endlist+independent_segments+program_date_time+temp_file",
    "-hls_segment_filename",
    segmentPattern,
    playlistPath
  ];
}

function looksAnimatedBackground(filePath: string | undefined): boolean {
  if (!filePath) {
    return false;
  }
  const ext = path.extname(filePath).toLowerCase();
  return ext === ".gif" || ext === ".webm" || ext === ".mp4" || ext === ".mov";
}

function formatFfmpegSeconds(value: number | undefined): string | undefined {
  if (!Number.isFinite(value) || (value ?? 0) <= 0) {
    return undefined;
  }
  return (value as number).toFixed(3);
}

export async function startHlsSegmenter(
  inputPath: string,
  outputDir: string,
  options: HlsSegmenterOptions = {}
): Promise<FfmpegSession> {
  await fs.mkdir(outputDir, { recursive: true });
  const playlistPath = path.join(outputDir, "index.m3u8");
  const segmentPattern = path.join(outputDir, "seg_%09d.ts");
  const shouldRenderRadioCanvas = options.streamMode === "radio" && options.assetMediaKind === "audio";
  const backgroundPath = options.radioBackgroundPath;
  const startOffsetSec = formatFfmpegSeconds(options.startOffsetSec);
  const maxDurationSec = formatFfmpegSeconds(options.maxDurationSec);

  const args = shouldRenderRadioCanvas
    ? [
        "-hide_banner",
        "-loglevel",
        "warning",
        ...(backgroundPath
          ? looksAnimatedBackground(backgroundPath)
            ? ["-stream_loop", "-1", "-i", backgroundPath]
            : ["-loop", "1", "-i", backgroundPath]
          : ["-f", "lavfi", "-i", "color=c=#111722:s=1280x720:r=30"]),
        ...(startOffsetSec ? ["-ss", startOffsetSec] : []),
        "-re",
        "-i",
        inputPath,
        ...(maxDurationSec ? ["-t", maxDurationSec] : []),
        "-map",
        "0:v:0",
        "-map",
        "1:a:0",
        "-shortest",
        "-vf",
        "scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,format=yuv420p,fps=30",
        "-tune",
        "stillimage",
        ...sharedHlsArgs(segmentPattern, playlistPath)
      ]
    : [
        "-hide_banner",
        "-loglevel",
        "warning",
        ...(startOffsetSec ? ["-ss", startOffsetSec] : []),
        "-re",
        "-i",
        inputPath,
        ...(maxDurationSec ? ["-t", maxDurationSec] : []),
        "-tune",
        "zerolatency",
        ...sharedHlsArgs(segmentPattern, playlistPath)
      ];

  const process = spawn("ffmpeg", args, {
    stdio: ["ignore", "ignore", "pipe"]
  });

  let stderr = "";
  process.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
    if (stderr.length > 4000) {
      stderr = stderr.slice(-4000);
    }
  });

  const finished = new Promise<FfmpegSessionResult>((resolve) => {
    process.on("close", (code, signal) => {
      resolve({ code: code ?? 1, signal, stderr });
    });

    process.on("error", (error) => {
      resolve({ code: 1, signal: null, stderr: String(error) });
    });
  });

  return { process, finished };
}

export async function startRtmpForwarder(inputManifestPath: string, outputRtmpUrl: string): Promise<FfmpegSession> {
  const args = [
    "-hide_banner",
    "-loglevel",
    "warning",
    "-re",
    "-fflags",
    "+genpts",
    "-i",
    inputManifestPath,
    "-c",
    "copy",
    "-f",
    "flv",
    outputRtmpUrl
  ];

  const process = spawn("ffmpeg", args, {
    stdio: ["ignore", "ignore", "pipe"]
  });

  let stderr = "";
  process.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
    if (stderr.length > 4000) {
      stderr = stderr.slice(-4000);
    }
  });

  const finished = new Promise<FfmpegSessionResult>((resolve) => {
    process.on("close", (code, signal) => {
      resolve({ code: code ?? 1, signal, stderr });
    });

    process.on("error", (error) => {
      resolve({ code: 1, signal: null, stderr: String(error) });
    });
  });

  return { process, finished };
}
