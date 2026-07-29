import { linkClick } from '../useLocation.js';
import { summaryPath } from '../paths.js';
import SpeakerTags from '../components/SpeakerTags.jsx';

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
                {item.summary && (
                  <p className="history-list-snippet">
                    {item.summary.replace(/^#+\s.+\n?/gm, '').replace(/[*_`#]/g, '').trim().slice(0, 200)}…
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
