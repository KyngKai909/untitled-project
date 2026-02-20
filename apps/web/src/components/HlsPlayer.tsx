import { type CSSProperties, useEffect, useMemo, useRef, useState } from "react";
import Hls from "hls.js";

interface HlsPlayerProps {
  src: string;
  autoPlay?: boolean;
  muted?: boolean;
  brandLabel?: string;
  accentColor?: string;
}

function normalizeVolume(raw: number): number {
  if (!Number.isFinite(raw)) {
    return 1;
  }
  return Math.min(1, Math.max(0, raw));
}

export default function HlsPlayer({
  src,
  autoPlay = true,
  muted = true,
  brandLabel = "OpenChannel",
  accentColor = "#00a96b"
}: HlsPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isMuted, setIsMuted] = useState(muted);
  const [volume, setVolume] = useState(muted ? 0 : 1);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [playerError, setPlayerError] = useState<string | null>(null);
  const [autoplayBlocked, setAutoplayBlocked] = useState(false);

  const attemptPlay = () => {
    const video = videoRef.current;
    if (!video) {
      return;
    }

    const playPromise = video.play();
    if (!playPromise || typeof playPromise.then !== "function") {
      return;
    }

    playPromise
      .then(() => {
        setAutoplayBlocked(false);
      })
      .catch(() => {
        setAutoplayBlocked(true);
      });
  };

  const catchUpToLiveEdge = () => {
    const video = videoRef.current;
    const hls = hlsRef.current;
    if (!video || !hls) {
      return;
    }

    const liveSyncPosition = hls.liveSyncPosition;
    if (typeof liveSyncPosition !== "number" || !Number.isFinite(liveSyncPosition)) {
      return;
    }

    // If playback drifts too far behind the live edge, jump closer to "now".
    if (liveSyncPosition - video.currentTime > 3) {
      video.currentTime = Math.max(0, liveSyncPosition - 0.35);
    }
  };

  useEffect(() => {
    const onFullscreen = () => {
      setIsFullscreen(document.fullscreenElement === wrapperRef.current);
    };

    document.addEventListener("fullscreenchange", onFullscreen);
    return () => document.removeEventListener("fullscreenchange", onFullscreen);
  }, []);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) {
      return;
    }

    const onPlay = () => setIsPlaying(true);
    const onPause = () => setIsPlaying(false);
    const onVolumeChange = () => {
      setIsMuted(video.muted);
      setVolume(video.volume);
    };

    video.addEventListener("play", onPlay);
    video.addEventListener("pause", onPause);
    video.addEventListener("volumechange", onVolumeChange);

    return () => {
      video.removeEventListener("play", onPlay);
      video.removeEventListener("pause", onPause);
      video.removeEventListener("volumechange", onVolumeChange);
    };
  }, []);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) {
      return;
    }

    video.muted = muted;
    if (!muted && video.volume === 0) {
      video.volume = 0.8;
    }
    setIsMuted(video.muted);
    setVolume(video.volume);
  }, [muted]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !src) {
      return;
    }

    setPlayerError(null);
    setAutoplayBlocked(false);
    hlsRef.current?.destroy();
    hlsRef.current = null;

    if (video.canPlayType("application/vnd.apple.mpegurl")) {
      video.src = src;
      if (autoPlay) {
        attemptPlay();
      }
      return;
    }

    if (!Hls.isSupported()) {
      setPlayerError("HLS playback is not supported in this browser.");
      return;
    }

    const hls = new Hls({
      enableWorker: true,
      lowLatencyMode: true,
      maxBufferLength: 10,
      backBufferLength: 14,
      liveSyncDurationCount: 1,
      liveMaxLatencyDurationCount: 3,
      maxLiveSyncPlaybackRate: 1.15
    });
    hlsRef.current = hls;

    hls.on(Hls.Events.MEDIA_ATTACHED, () => {
      if (autoPlay) {
        attemptPlay();
      }
    });

    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      catchUpToLiveEdge();
      if (autoPlay) {
        attemptPlay();
      }
    });

    hls.on(Hls.Events.LEVEL_UPDATED, () => {
      catchUpToLiveEdge();
    });

    hls.on(Hls.Events.ERROR, (_event, data) => {
      if (!data.fatal) {
        return;
      }

      if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
        hls.startLoad();
        return;
      }

      if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
        hls.recoverMediaError();
        return;
      }

      setPlayerError("Stream connection dropped. Reloading may recover.");
      hls.destroy();
      hlsRef.current = null;
    });

    hls.loadSource(src);
    hls.attachMedia(video);

    return () => {
      hls.destroy();
      if (hlsRef.current === hls) {
        hlsRef.current = null;
      }
    };
  }, [autoPlay, src]);

  const style = useMemo(
    () =>
      ({
        "--player-accent": accentColor
      }) as CSSProperties,
    [accentColor]
  );

  const togglePlay = () => {
    const video = videoRef.current;
    if (!video) {
      return;
    }

    if (video.paused) {
      attemptPlay();
    } else {
      video.pause();
    }
  };

  const toggleMute = () => {
    const video = videoRef.current;
    if (!video) {
      return;
    }

    video.muted = !video.muted;
    if (!video.muted && video.volume === 0) {
      video.volume = 0.7;
    }
    setIsMuted(video.muted);
    setVolume(video.volume);
  };

  const changeVolume = (raw: number) => {
    const video = videoRef.current;
    if (!video) {
      return;
    }

    const next = normalizeVolume(raw);
    video.volume = next;
    video.muted = next === 0;
    setVolume(next);
    setIsMuted(video.muted);
  };

  const toggleFullscreen = async () => {
    if (!wrapperRef.current) {
      return;
    }

    if (document.fullscreenElement === wrapperRef.current) {
      await document.exitFullscreen().catch(() => undefined);
      return;
    }

    await wrapperRef.current.requestFullscreen().catch(() => undefined);
  };

  return (
    <div className="playerShell" ref={wrapperRef} style={style}>
      <video
        ref={videoRef}
        playsInline
        preload="auto"
        className="playerVideo"
        onClick={togglePlay}
      />

      <div className="playerOverlayTop">
        <span className="liveBadge">LIVE</span>
        <span className="brandBadge">{brandLabel}</span>
      </div>

      <div className="playerControls">
        <button type="button" className="playerBtn" onClick={togglePlay}>
          {isPlaying ? "Pause" : autoplayBlocked ? "Start Stream" : "Play"}
        </button>
        <button type="button" className="playerBtn" onClick={toggleMute}>
          {isMuted ? "Unmute" : "Mute"}
        </button>
        <input
          className="playerVolume"
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={volume}
          onChange={(event) => changeVolume(Number(event.target.value))}
          aria-label="Volume"
        />
        <button type="button" className="playerBtn" onClick={toggleFullscreen}>
          {isFullscreen ? "Exit Fullscreen" : "Fullscreen"}
        </button>
      </div>

      {autoplayBlocked && !isPlaying ? (
        <p className="playerHint">Autoplay was blocked by your browser. Press Start Stream.</p>
      ) : null}

      {playerError ? <p className="playerError">{playerError}</p> : null}
    </div>
  );
}
