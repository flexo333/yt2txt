import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';

const EMBED_ORIGIN = 'https://www.youtube-nocookie.com';

// Facade-first YouTube embed for /summary/<videoId>. Nothing loads from
// YouTube until the user opts in (click, or a timestamp link) — a page full
// of unwatched summaries never pays iframe weight for it.
//
// Exposes `seek(seconds)` via ref so the summary markdown's timestamp links
// (rendered by a sibling <Markdown>) can drive this player instead of
// spawning a tab. The imperative-handle shape is deliberately tiny: `Summary`
// doesn't need to know whether the player is active yet, just that seeking
// works either way (a seek before activation mounts the iframe with `start=`
// baked in, so the very first click needs no postMessage round-trip).
const VideoPlayer = forwardRef(({ videoId, title }, ref) => {
  const [activated, setActivated] = useState(false);
  const [mini, setMini] = useState(false);
  const [dismissedMini, setDismissedMini] = useState(false);
  // Seconds to open the iframe at — set only when activation itself came
  // from a timestamp click (`seek()` before the iframe exists).
  const [startAt, setStartAt] = useState(null);

  const iframeRef = useRef(null);
  const sentinelRef = useRef(null);
  const readyRef = useRef(false);
  const pendingSeekRef = useRef(null);

  const postToPlayer = (payload) => {
    iframeRef.current?.contentWindow?.postMessage(JSON.stringify(payload), EMBED_ORIGIN);
  };

  const runSeek = (seconds) => {
    postToPlayer({ event: 'command', func: 'seekTo', args: [seconds, true] });
    postToPlayer({ event: 'command', func: 'playVideo', args: [] });
  };

  useImperativeHandle(ref, () => ({
    seek(seconds) {
      if (!activated) {
        // No iframe yet — mount it already positioned, so the first click
        // costs no postMessage round-trip.
        setStartAt(seconds);
        setActivated(true);
        return;
      }
      if (readyRef.current) {
        runSeek(seconds);
      } else {
        // Player embedded but hasn't sent `onReady` yet — queue it, the
        // `onReady` handler below flushes this.
        pendingSeekRef.current = seconds;
      }
    },
  }));

  // Listen for the embed's postMessage events once activated. YouTube only
  // starts emitting them after it receives a `{"event":"listening"}`
  // handshake, which the iframe's onLoad sends.
  useEffect(() => {
    if (!activated) return undefined;

    const onMessage = (event) => {
      if (event.origin !== EMBED_ORIGIN) return;
      if (!iframeRef.current || event.source !== iframeRef.current.contentWindow) return;
      let data;
      try {
        data = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
      } catch {
        return;
      }
      if (data && data.event === 'onReady') {
        readyRef.current = true;
        if (pendingSeekRef.current !== null) {
          runSeek(pendingSeekRef.current);
          pendingSeekRef.current = null;
        }
      }
    };

    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [activated]);

  // Sticky mini-player: observe a zero-height sentinel placed just above the
  // player. Only wired up once activated — an inactive facade has nothing
  // worth keeping visible while scrolling past it.
  useEffect(() => {
    if (!activated || !sentinelRef.current) return undefined;
    const observer = new IntersectionObserver(
      ([entry]) => setMini(!entry.isIntersecting),
      { threshold: 0 },
    );
    observer.observe(sentinelRef.current);
    return () => observer.disconnect();
  }, [activated]);

  // Re-arm the dismiss button: scrolling the player back into view clears a
  // previous dismissal, so the mini player returns next time you scroll past.
  // Lives above the `videoId` guard below — every hook must run on every
  // render, guard or not.
  useEffect(() => {
    if (!mini) setDismissedMini(false);
  }, [mini]);

  if (!videoId) return null;

  const showMini = mini && !dismissedMini;

  const handleIframeLoad = () => {
    postToPlayer({ event: 'listening' });
  };

  const activate = () => {
    setStartAt(null);
    setActivated(true);
  };

  // Dismissing the mini player just hides it until the sentinel scrolls back
  // into view (the simplest coherent behaviour — no scroll-jacking back up
  // to the player). Re-entering the sentinel's viewport naturally flips
  // `mini` back to false via the observer, which re-arms this for next time.
  const dismissMini = () => setDismissedMini(true);

  return (
    <div className="video-player-block">
      <div ref={sentinelRef} style={{ height: 0 }} aria-hidden="true" />
      {activated && showMini && <div className="video-mini-placeholder" />}
      <div className={`video-wrapper${showMini ? ' video--mini' : ''}`}>
        {showMini && (
          <button
            type="button"
            className="video-mini-close"
            aria-label="Close mini player"
            onClick={dismissMini}
          >
            ×
          </button>
        )}
        {activated ? (
          <iframe
            ref={iframeRef}
            className="video-iframe"
            src={`${EMBED_ORIGIN}/embed/${videoId}?enablejsapi=1&autoplay=1&rel=0&origin=${encodeURIComponent(window.location.origin)}${startAt !== null ? `&start=${startAt}` : ''}`}
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; picture-in-picture; web-share"
            allowFullScreen
            title={title || 'YouTube video'}
            frameBorder="0"
            onLoad={handleIframeLoad}
          />
        ) : (
          <button type="button" className="video-facade" aria-label="Play video" onClick={activate}>
            <img src={`https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`} alt="" loading="lazy" />
            <span className="video-facade-play" aria-hidden="true" />
          </button>
        )}
      </div>
    </div>
  );
});

export default VideoPlayer;
