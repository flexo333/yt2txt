import { linkClick } from '../useLocation.js';
import { summaryPath } from '../paths.js';
import SpeakerTags from '../components/SpeakerTags.jsx';
import { plainSnippet } from '../../backend/summarise/snippet.js';

// The full list of summaries, optionally narrowed to one speaker. The filter
// itself lives in App.jsx because it is set from speaker tags on other routes.
const History = ({ history, speakerFilter, onClearFilter, onSpeakerSelect, modelLabel }) => {
  const visibleHistory = speakerFilter
    ? history.filter((h) => (h.speakers || []).includes(speakerFilter))
    : history;

  return (
    <>
      {speakerFilter && (
        <div className="filter-bar">
          <span>Featuring <strong>{speakerFilter}</strong></span>
          <button className="btn btn--secondary" onClick={onClearFilter}>
            Clear filter
          </button>
        </div>
      )}
      {visibleHistory.length === 0 ? (
        <div className="empty-state">
          {speakerFilter
            ? `No summaries featuring ${speakerFilter}.`
            : 'No summaries yet. Generate one from the Home page.'}
        </div>
      ) : (
        <div className="history-list">
          {visibleHistory.map((item) => {
            const href = summaryPath(item);
            return (
              <a
                key={item.url}
                href={href}
                className="history-list-card"
                onClick={(e) => linkClick(e, href)}
              >
                <div className="history-list-meta">
                  <span className="history-date">{item.date}</span>
                  {item.channelTitle && <span className="channel-name">{item.channelTitle}</span>}
                  {item.model && <span className="model-tag">{modelLabel(item.model)}</span>}
                </div>
                <h3 className="history-list-title">{item.title || item.url}</h3>
                {item.videoTitle && <p className="video-title">{item.videoTitle}</p>}
                {/* The server already snippets list rows, but a row that
                    came straight from a POST (just generated, or regenerated)
                    carries the FULL markdown so Summary.jsx can render and
                    download it. plainSnippet is idempotent, so applying it here
                    bounds that case without touching the common one — and it
                    keeps the card correct if an older Lambda is still serving
                    300 raw markdown characters mid-deploy. */}
                {item.summary && (
                  <p className="history-list-snippet">
                    {plainSnippet(item.summary)}…
                  </p>
                )}
                <SpeakerTags
                  item={item}
                  activeSpeaker={speakerFilter}
                  onSelect={onSpeakerSelect}
                />
                <span className="history-list-url">{item.url}</span>
              </a>
            );
          })}
        </div>
      )}
    </>
  );
};

export default History;
