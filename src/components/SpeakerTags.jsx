// Speaker chips under a summary card. Clicking one filters the History page.
//
// Summaries written before speaker tags existed have no `speakers` — those
// cards simply render without a tag row.
//
// `onSelect(event, name)` receives the event because tags live inside a card
// that is itself a link: the handler has to stop the card's navigation before
// applying the filter.
const SpeakerTags = ({ item, activeSpeaker, onSelect }) => {
  const speakers = item.speakers || [];
  if (speakers.length === 0) return null;
  return (
    <div className="speaker-tags">
      {speakers.map((name) => (
        <span
          key={name}
          role="button"
          tabIndex={0}
          className={`speaker-tag ${activeSpeaker === name ? 'speaker-tag--active' : ''}`}
          title={`Show only summaries featuring ${name}`}
          onClick={(e) => onSelect(e, name)}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onSelect(e, name); }}
        >
          {name}
        </span>
      ))}
    </div>
  );
};

export default SpeakerTags;
