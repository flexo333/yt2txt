import { navigate, linkClick } from '../useLocation.js';
import Markdown from '../components/Markdown.jsx';
import SpeakerTags from '../components/SpeakerTags.jsx';

const downloadMarkdown = (text) => {
  const blob = new Blob([text], { type: 'text/markdown' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `summary-${Date.now()}.md`;
  link.click();
};

// One summary, addressed by /summary/<videoId>. The item is resolved from the
// history list App.jsx already holds, so a deep link renders "Loading…" until
// that list arrives and "not found" only once it has (`historyLoaded`).
const Summary = ({ item, historyLoaded, modelLabel, speakerFilter, onSpeakerSelect }) => {
  if (!historyLoaded) return <div className="empty-state">Loading…</div>;

  if (!item) {
    return (
      <div className="empty-state">
        Summary not found.{' '}
        <a href="/history" onClick={(e) => linkClick(e, '/history')}>Back to History</a>
      </div>
    );
  }

  return (
    <>
      <div className="article-actions">
        <button className="btn btn--secondary" onClick={() => navigate('/history')}>
          ← Back to History
        </button>
        <button className="btn btn--secondary" onClick={() => downloadMarkdown(item.summary)}>
          Download .md
        </button>
      </div>
      {(item.channelTitle || item.model) && (
        <div className="summary-meta">
          {item.channelTitle && (
            <span className="channel-name">{item.channelTitle}</span>
          )}
          {item.model && <span className="model-tag">{modelLabel(item.model)}</span>}
        </div>
      )}
      {item.videoTitle && (
        <p className="video-title">{item.videoTitle}</p>
      )}
      <SpeakerTags item={item} activeSpeaker={speakerFilter} onSelect={onSpeakerSelect} />
      <article className="prose">
        <Markdown>{item.summary}</Markdown>
      </article>
    </>
  );
};

export default Summary;
