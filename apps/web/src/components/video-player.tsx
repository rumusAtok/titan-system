'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * Plays an HLS stream (.m3u8) in the browser: natively where supported, otherwise with hls.js
 * (Media Source Extensions). TITAN does not relay or record the stream; the browser fetches it
 * from the camera's video server directly, inside a logged viewing session.
 */
export function VideoPlayer({ src, label }: { src: string; label: string }) {
  const ref = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    let destroy: (() => void) | undefined;
    setError(null);
    if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = src;
    } else {
      void import('hls.js').then(({ default: Hls }) => {
        if (!Hls.isSupported()) {
          setError('This browser cannot play HLS video.');
          return;
        }
        const hls = new Hls({ lowLatencyMode: false, maxBufferLength: 10 });
        hls.on(Hls.Events.ERROR, (_e, data) => {
          if (data.fatal) setError(`The stream could not be played (${data.details}).`);
        });
        hls.loadSource(src);
        hls.attachMedia(video);
        destroy = () => hls.destroy();
      });
    }
    return () => destroy?.();
  }, [src]);

  return (
    <div>
      <video ref={ref} data-testid="camera-video" className="aspect-video w-full rounded bg-black" muted autoPlay playsInline controls aria-label={label} />
      {error && <p role="alert" className="mt-1 text-sm text-red-700">{error}</p>}
    </div>
  );
}
