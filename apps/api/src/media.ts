import { promises as fs } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import {
  EXTERNAL_INGEST_DOWNLOAD_STALL_TIMEOUT_MS,
  EXTERNAL_INGEST_DOWNLOAD_TIMEOUT_MS,
  EXTERNAL_INGEST_EXPAND_STALL_TIMEOUT_MS,
  EXTERNAL_INGEST_EXPAND_TIMEOUT_MS
} from "./config.js";

interface RunCommandOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  stallTimeoutMs?: number;
}

interface RunCommandResult {
  code: number;
  stdout: string;
  stderr: string;
  spawnFailed: boolean;
  aborted: boolean;
  timedOut: boolean;
  timeoutReason?: string;
}

function guessMediaKindFromPath(filePath: string): "video" | "audio" {
  const ext = path.extname(filePath).toLowerCase();
  if ([".mp3", ".wav", ".aac", ".m4a", ".flac", ".ogg", ".opus"].includes(ext)) {
    return "audio";
  }
  return "video";
}

function runCommand(
  command: string,
  args: string[],
  options: RunCommandOptions = {}
): Promise<RunCommandResult> {
  return new Promise((resolve) => {
    const augmentedPath = [
      process.env.PATH ?? "",
      "/opt/homebrew/bin",
      "/usr/local/bin",
      "/opt/local/bin"
    ]
      .filter(Boolean)
      .join(":");

    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        PATH: augmentedPath
      }
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let wasAborted = false;
    let wasTimedOut = false;
    let timeoutReason: string | undefined;
    let lastOutputAt = Date.now();
    let killTimer: NodeJS.Timeout | undefined;
    let totalTimeoutTimer: NodeJS.Timeout | undefined;
    let stallTimer: NodeJS.Timeout | undefined;
    let terminationRequested = false;

    const requestTermination = (mode: "abort" | "timeout", reason?: string) => {
      if (settled || terminationRequested) {
        return;
      }
      terminationRequested = true;
      if (mode === "abort") {
        wasAborted = true;
      } else {
        wasTimedOut = true;
        timeoutReason = reason;
        if (reason) {
          stderr = `${stderr}${stderr ? "\n" : ""}${reason}`;
        }
      }
      try {
        child.kill("SIGTERM");
      } catch {
        // Ignore.
      }
      killTimer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // Ignore.
        }
      }, 1500);
    };

    const cleanupAbortHandler = (() => {
      const signal = options.signal;
      if (!signal) {
        return () => undefined;
      }

      const onAbort = () => {
        requestTermination("abort");
      };

      if (signal.aborted) {
        onAbort();
      } else {
        signal.addEventListener("abort", onAbort, { once: true });
      }

      return () => signal.removeEventListener("abort", onAbort);
    })();

    function done(result: RunCommandResult) {
      if (settled) {
        return;
      }
      settled = true;
      if (killTimer) {
        clearTimeout(killTimer);
      }
      if (totalTimeoutTimer) {
        clearTimeout(totalTimeoutTimer);
      }
      if (stallTimer) {
        clearInterval(stallTimer);
      }
      cleanupAbortHandler();
      resolve(result);
    }

    const timeoutMs = options.timeoutMs && options.timeoutMs > 0 ? options.timeoutMs : undefined;
    if (timeoutMs) {
      totalTimeoutTimer = setTimeout(() => {
        requestTermination(
          "timeout",
          `yt-dlp timed out after ${Math.round(timeoutMs / 1000)}s without finishing.`
        );
      }, timeoutMs);
    }

    const stallTimeoutMs = options.stallTimeoutMs && options.stallTimeoutMs > 0 ? options.stallTimeoutMs : undefined;
    if (stallTimeoutMs) {
      const checkEveryMs = Math.max(1000, Math.min(10_000, Math.floor(stallTimeoutMs / 2)));
      stallTimer = setInterval(() => {
        if (Date.now() - lastOutputAt >= stallTimeoutMs) {
          requestTermination(
            "timeout",
            `yt-dlp stalled for ${Math.round(stallTimeoutMs / 1000)}s with no output.`
          );
        }
      }, checkEveryMs);
    }

    child.stdout.on("data", (chunk: Buffer) => {
      lastOutputAt = Date.now();
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk: Buffer) => {
      lastOutputAt = Date.now();
      stderr += chunk.toString();
    });

    child.on("close", (code) =>
      done({
        code: code ?? (wasAborted || wasTimedOut ? 130 : 1),
        stdout,
        stderr,
        spawnFailed: false,
        aborted: wasAborted,
        timedOut: wasTimedOut,
        timeoutReason
      })
    );
    child.on("error", (error: NodeJS.ErrnoException) => {
      const message = error.code ? `${error.code}: ${error.message}` : error.message;
      done({
        code: 127,
        stdout,
        stderr: `Failed to run ${command}. ${message}`,
        spawnFailed: true,
        aborted: wasAborted,
        timedOut: wasTimedOut,
        timeoutReason
      });
    });
  });
}

async function runYtDlpAttempts(
  args: string[],
  options: RunCommandOptions = {}
): Promise<{
  ok: boolean;
  stdout: string;
  stderr: string;
  spawnFailed: boolean;
  detail: string;
  aborted: boolean;
  timedOut: boolean;
}> {
  const attempts = [
    { label: "yt-dlp", command: "yt-dlp", args },
    { label: "python3 -m yt_dlp", command: "python3", args: ["-m", "yt_dlp", ...args] },
    { label: "python -m yt_dlp", command: "python", args: ["-m", "yt_dlp", ...args] }
  ];

  const failureNotes: string[] = [];
  for (const attempt of attempts) {
    const result = await runCommand(attempt.command, attempt.args, options);
    if (result.code === 0) {
      return {
        ok: true,
        stdout: result.stdout,
        stderr: result.stderr,
        spawnFailed: false,
        detail: "",
        aborted: false,
        timedOut: false
      };
    }

    if (result.aborted || options.signal?.aborted) {
      return {
        ok: false,
        stdout: result.stdout,
        stderr: result.stderr,
        spawnFailed: false,
        detail: "Command canceled",
        aborted: true,
        timedOut: false
      };
    }

    if (result.timedOut) {
      return {
        ok: false,
        stdout: result.stdout,
        stderr: result.stderr,
        spawnFailed: false,
        detail: result.timeoutReason ?? "yt-dlp timed out.",
        aborted: false,
        timedOut: true
      };
    }

    const detail = (result.stderr || result.stdout || `Exit code ${result.code}`).trim().slice(0, 320);
    failureNotes.push(`${attempt.label}: ${detail}`);

    if (!result.spawnFailed) {
      return {
        ok: false,
        stdout: result.stdout,
        stderr: result.stderr,
        spawnFailed: false,
        detail,
        aborted: false,
        timedOut: false
      };
    }
  }

  return {
    ok: false,
    stdout: "",
    stderr: failureNotes.join(" | "),
    spawnFailed: true,
    detail: failureNotes.join(" | "),
    aborted: false,
    timedOut: false
  };
}

function splitLines(input: string): string[] {
  return input
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function dedupeUrls(urls: string[]): string[] {
  const set = new Set<string>();
  for (const raw of urls) {
    const trimmed = raw.trim();
    if (!trimmed) {
      continue;
    }
    set.add(trimmed);
  }
  return [...set];
}

export async function probeDurationSec(filePath: string): Promise<number | undefined> {
  const probe = await runCommand("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "default=noprint_wrappers=1:nokey=1",
    filePath
  ]);

  if (probe.code !== 0) {
    return undefined;
  }

  const numeric = Number(probe.stdout.trim());
  return Number.isFinite(numeric) ? Math.max(0, Math.round(numeric)) : undefined;
}

export async function probeMediaKind(filePath: string): Promise<"video" | "audio"> {
  const probe = await runCommand("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "stream=codec_type",
    "-of",
    "json",
    filePath
  ]);

  if (probe.code !== 0) {
    return guessMediaKindFromPath(filePath);
  }

  try {
    const parsed = JSON.parse(probe.stdout) as { streams?: Array<{ codec_type?: string }> };
    const hasVideo = parsed.streams?.some((stream) => stream.codec_type === "video");
    if (hasVideo) {
      return "video";
    }

    const hasAudio = parsed.streams?.some((stream) => stream.codec_type === "audio");
    if (hasAudio) {
      return "audio";
    }
  } catch {
    // Fall back to extension when ffprobe output is unexpected.
  }

  return guessMediaKindFromPath(filePath);
}

export async function expandExternalUrls(url: string, options: { signal?: AbortSignal } = {}): Promise<string[]> {
  const source = url.trim();
  if (!source) {
    return [];
  }

  const args = [
    "--flat-playlist",
    "--skip-download",
    "--print",
    "%(webpage_url)s",
    "--no-warnings",
    source
  ];

  const result = await runYtDlpAttempts(args, {
    signal: options.signal,
    timeoutMs: EXTERNAL_INGEST_EXPAND_TIMEOUT_MS,
    stallTimeoutMs: EXTERNAL_INGEST_EXPAND_STALL_TIMEOUT_MS
  });
  if (result.aborted || options.signal?.aborted) {
    throw new Error("External ingest canceled.");
  }
  if (!result.ok) {
    // Fallback to the raw URL if playlist introspection is unavailable.
    return [source];
  }

  const urls = dedupeUrls(splitLines(result.stdout).filter((entry) => /^https?:\/\//i.test(entry)));
  return urls.length ? urls : [source];
}

export async function ingestFromExternalUrl(
  url: string,
  outDir: string,
  baseName: string,
  options: { signal?: AbortSignal } = {}
): Promise<string> {
  await fs.mkdir(outDir, { recursive: true });
  const outputTemplate = path.join(outDir, `${baseName}.%(ext)s`);

  const args = [
    "--newline",
    "--no-playlist",
    "--merge-output-format",
    "mp4",
    "-o",
    outputTemplate,
    url
  ];

  const result = await runYtDlpAttempts(args, {
    signal: options.signal,
    timeoutMs: EXTERNAL_INGEST_DOWNLOAD_TIMEOUT_MS,
    stallTimeoutMs: EXTERNAL_INGEST_DOWNLOAD_STALL_TIMEOUT_MS
  });
  if (result.aborted || options.signal?.aborted) {
    throw new Error("External ingest canceled.");
  }
  if (result.ok) {
    const files = await fs.readdir(outDir);
    const match = files
      .filter((name) => name.startsWith(baseName))
      .sort((a, b) => b.localeCompare(a))[0];

    if (!match) {
      throw new Error("External ingest succeeded but no output media file was found.");
    }

    const fullPath = path.join(outDir, match);
    const stat = await fs.stat(fullPath);
    if (!stat.isFile()) {
      throw new Error("Downloaded output is not a file.");
    }

    return fullPath;
  }

  if (!result.spawnFailed) {
    if (result.timedOut) {
      throw new Error(
        [
          "yt-dlp timed out while downloading this URL.",
          result.detail,
          "For very large or slow sources, raise EXTERNAL_INGEST_DOWNLOAD_TIMEOUT_MS",
          "and/or EXTERNAL_INGEST_DOWNLOAD_STALL_TIMEOUT_MS in your .env."
        ].join(" ")
      );
    }
    throw new Error(`yt-dlp failed to extract this URL. Details: ${result.detail}`);
  }

  throw new Error(
    [
      "External ingest failed.",
      "Install requirements:",
      "- macOS: brew install yt-dlp ffmpeg",
      "- Linux: install yt-dlp and ffmpeg from your package manager",
      "- Python fallback: python3 -m pip install -U yt-dlp",
      `Attempt details: ${result.detail}`
    ].join(" ")
  );
}
