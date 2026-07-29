import { useEffect, useRef } from 'react';
import { linkClick } from '../useLocation.js';
import { summaryPath } from '../paths.js';
import SpeakerTags from '../components/SpeakerTags.jsx';

// Desktop fallback for the share target. Web Share Target only exists on
// Android, ChromeOS and Windows — on macOS/Linux an installed PWA can never
// appear in a share menu. This bookmarklet drives the same /share route from
// any desktop browser: it prefers selected text (so you can highlight a pasted
// link anywhere) and falls back to the current tab's URL.
const bookmarkletHref = (origin) =>
  'javascript:(function(){'
  + 'var s=window.getSelection?String(window.getSelection()).trim():"";'
  + 'var u=/youtu\\.?be/i.test(s)?s:location.href;'
  + `window.open(${JSON.stringify(origin)}+"/share?url="+encodeURIComponent(u),"_blank");`
  + '})()';

// The URL entry form plus a grid of past summaries. Every piece of state here
// is owned by App.jsx: `url` survives a bounce through the /share route, and
// the model + history lists are shared with the other routes.
const Home = ({
  url,
  setUrl,
  model,
  setModel,
  modelOptions,
  modelLabel,
  loading,
  error,
  onGenerate,
  history,
  speakerFilter,
  onSpeakerSelect,
}) => {
  const bookmarkletRef = useRef(null);

  // React refuses to render a javascript: href (it sanitises them), so the
  // bookmarklet is attached to the DOM node directly once it exists.
  useEffect(() => {
    if (bookmarkletRef.current) {
      bookmarkletRef.current.setAttribute('href', bookmarkletHref(window.location.origin));
    }
  }, []);

  const onKeyDown = (e) => {
    if (e.key === 'Enter') onGenerate();
  };

  return (
    <>
      <div className="input-card">
        <select
          value={model}
          onChange={(e) => setModel(e.target.value)}
          disabled={loading}
          aria-label="Model"
        >
          {modelOptions.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <input
          type="text"
          placeholder="Paste YouTube URL..."
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <button
          className="btn btn--primary"
          onClick={onGenerate}
          disabled={loading}
        >
          {loading ? 'Analysing…' : 'Generate'}
        </button>
      </div>

      {error && <p className="error">{error}</p>}

      <details className="desktop-share">
        <summary>Summarise from your desktop browser</summary>
        <p>
          Sharing into an installed app only works on Android, ChromeOS and Windows —
          macOS and Linux have no share menu for web apps. Drag this button to your
          bookmarks bar instead, then click it on any YouTube page:
        </p>
        <a
          ref={bookmarkletRef}
          className="bookmarklet"
          href="/"
          draggable="true"
          onClick={(e) => e.preventDefault()}
          title="Drag me to your bookmarks bar"
        >
          ▸ Summarise this
        </a>
        <p className="desktop-share-note">
          Clicking it here does nothing — it only works from the bookmarks bar. Highlight a
          link first and it uses that instead of the current page.
        </p>
      </details>

      {history.length > 0 ? (
        <section className="history-section">
          <h2>Past Summaries</h2>
          <div className="history-grid">
            {history.map((item) => {
              const href = summaryPath(item);
              return (
                <a
                  key={item.url}
                  href={href}
                  className="history-card"
                  onClick={(e) => linkClick(e, href)}
                >
                  <div className="history-date">{item.date}</div>
                  <span className="history-title">{item.title || item.url}</span>
                  {item.channelTitle && <span className="channel-name">{item.channelTitle}</span>}
                  <span className="history-url">{item.url}</span>
                  <SpeakerTags
                    item={item}
                    activeSpeaker={speakerFilter}
                    onSelect={onSpeakerSelect}
                  />
                  {item.model && <span className="model-tag">{modelLabel(item.model)}</span>}
                </a>
              );
            })}
          </div>
        </section>
      ) : (
        <div className="empty-state">
          No summaries yet. Paste a YouTube URL above to generate one.
        </div>
      )}
    </>
  );
};

export default Home;
