import { useEffect, useRef, useState } from "react";
import Hls from "hls.js";

interface HlsPlayerProps {
  src: string;
  autoPlay?: boolean;
  muted?: boolean;
}

export default function HlsPlayer({ src, autoPlay = true, muted = true }: HlsPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !src) {
      return;
    }

    setError(null);
    hlsRef.current?.destroy();
    hlsRef.current = null;

    video.muted = muted;

    if (video.canPlayType("application/vnd.apple.mpegurl")) {
      video.src = src;
      if (autoPlay) {
        void video.play().catch(() => undefined);
      }
      return;
    }

    if (!Hls.isSupported()) {
      setError("This browser cannot play HLS.");
      return;
    }

    const hls = new Hls({
      lowLatencyMode: true,
      maxBufferLength: 12,
      liveSyncDurationCount: 1,
      liveMaxLatencyDurationCount: 3
    });

    hlsRef.current = hls;
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
      setError("Player lost stream connection. Try reloading this page.");
      hls.destroy();
      hlsRef.current = null;
    });

    hls.loadSource(src);
    hls.attachMedia(video);

    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      if (autoPlay) {
        void video.play().catch(() => undefined);
      }
    });

    return () => {
      hls.destroy();
      if (hlsRef.current === hls) {
        hlsRef.current = null;
      }
    };
  }, [autoPlay, muted, src]);

  return (
    <div className="stack">
      <div className="mediaFrame">
        <video ref={videoRef} playsInline controls />
      </div>
      {error ? (
        <div className="alert" data-tone="error">
          {error}
        </div>
      ) : null}
    </div>
  );
}
