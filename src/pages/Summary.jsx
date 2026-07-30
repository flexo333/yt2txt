import { useEffect, useState } from 'react';
import { navigate, linkClick } from '../useLocation.js';
import { hasBackend, getSummary } from '../api.js';
import Markdown from '../components/Markdown.jsx';
import SpeakerTags from '../components/SpeakerTags.jsx';

const downloadMarkdown = (text) => {
  const blob = new Blob([text], { type: 'text/markdown' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `summary-${Date.now()}.md`;
  link.click();
};

// One summary, addressed by /summary/<videoId>.
//
// The history list App.jsx holds is the fast path but never the whole answer:
// it covers only the newest 50 summaries, and every row in it carries a
// truncated snippet rather than the real markdown. So unless we already hold a
// full row — which is the case straight after generating one — the summary is
// fetched from GET ?video=<id>. A snippet we do have renders immediately
// underneath that request, so the page is never blank when it could be useful.
const Summary = ({ id, item, historyLoaded, modelLabel, speakerFilter, onSpeakerSelect }) => {
  // { id, row } — row is null when the fetch found nothing. Keyed by id so a
  // route change can never render the previous video's summary.
  const [fetched, setFetched] = useState(null);

  const needsFull = Boolean(hasBackend && id && !(item && !item.truncated));

  useEffect(() => {
    if (!needsFull) return;
    let cancelled = false;
    getSummary(id)
      .then((row) => { if (!cancelled) setFetched({ id, row }); })
      .catch(() => { if (!cancelled) setFetched({ id, row: null }); });
    return () => { cancelled = true; };
  }, [id, needsFull]);

  const resolved = fetched && fetched.id === id ? fetched : null;
  const loading = needsFull && !resolved;
  const shown = (resolved && resolved.row) || item;

  if (!shown) {
    if (loading || !historyLoaded) return <div className="empty-state">Loading…</div>;
    return (
      <div className="empty-state">
        Summary not found.{' '}
        <a href="/history" onClick={(e) => linkClick(e, '/history')}>Back to History</a>
      </div>
    );
  }

  // True only while the best row we have is a list snippet: the fetch is still
  // running, or it failed / hit an older Lambda without the endpoint.
  const partial = Boolean(shown.truncated);

  return (
    <>
      <div className="article-actions">
        <button className="btn btn--secondary" onClick={() => navigate('/history')}>
          ← Back to History
        </button>
        {/* Never hand a download the snippet — it would look like a complete
            file and silently be a few hundred characters of it. */}
        <button
          className="btn btn--secondary"
          onClick={() => downloadMarkdown(shown.summary)}
          disabled={partial}
          title={partial ? 'Waiting for the full summary' : undefined}
        >
          Download .md
        </button>
      </div>
      {(shown.channelTitle || shown.model) && (
        <div className="summary-meta">
          {shown.channelTitle && (
            <span className="channel-name">{shown.channelTitle}</span>
          )}
          {shown.model && <span className="model-tag">{modelLabel(shown.model)}</span>}
        </div>
      )}
      {shown.videoTitle && (
        <p className="video-title">{shown.videoTitle}</p>
      )}
      <SpeakerTags item={shown} activeSpeaker={speakerFilter} onSelect={onSpeakerSelect} />
      <article className="prose">
        <Markdown>{shown.summary}</Markdown>
      </article>
      {partial && (
        <p className="error">
          {loading
            ? 'Loading the full summary…'
            : 'Only a preview is available — the full summary could not be loaded.'}
        </p>
      )}
    </>
  );
};

export default Summary;
