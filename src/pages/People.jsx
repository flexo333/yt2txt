import { useState, useEffect, useRef } from 'react';
import { listPeople, getPerson, researchPerson } from '../api.js';
import Markdown from '../components/Markdown.jsx';

// Person research: kick off a job, then poll it to completion. The job runs
// server-side across several Lambda invocations, so the only way to follow it
// is to re-read its status every few seconds until it reaches a terminal one.
const People = () => {
  const [people, setPeople] = useState([]);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState(null);
  const [detail, setDetail] = useState(null);
  // Inline failure message for the Research / Retry buttons.
  const [error, setError] = useState(null);
  const pollRef = useRef(null);

  const loadPeople = async () => {
    try {
      setPeople(await listPeople());
    } catch (e) { console.error(e); }
  };

  const loadDetail = async (person) => {
    try {
      setDetail(await getPerson(person));
    } catch (e) { console.error(e); }
  };

  useEffect(() => { loadPeople(); }, []);

  useEffect(() => {
    if (!selected) return;
    loadDetail(selected);
    pollRef.current = setInterval(() => loadDetail(selected), 3000);
    return () => clearInterval(pollRef.current);
  }, [selected]);

  useEffect(() => {
    if (!selected || !detail) return;
    const terminal = detail.status === 'done' || detail.status === 'error';
    if (terminal) {
      clearInterval(pollRef.current);
      pollRef.current = null;
      loadPeople();
    } else if (!pollRef.current) {
      pollRef.current = setInterval(() => loadDetail(selected), 3000);
    }
  }, [detail?.status, selected]);

  const startResearch = async () => {
    if (!name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const { person } = await researchPerson(name.trim());
      setSelected(person);
      setName('');
      loadPeople();
    } catch (e) {
      setError('Failed to start research: ' + e.message);
    } finally {
      setBusy(false);
    }
  };

  const retryResearch = async (personName) => {
    if (!personName) return;
    setBusy(true);
    setError(null);
    try {
      await researchPerson(personName, { force: true });
      await loadDetail(selected);
      loadPeople();
    } catch (e) {
      setError('Failed to retry: ' + e.message);
    } finally {
      setBusy(false);
    }
  };

  if (selected && detail) {
    const { displayName, status, progress, meta, videos = [], errorMessage } = detail;
    const bestId = meta?.bestVideoId;
    return (
      <div>
        <div className="article-actions">
          <button
            className="btn btn--secondary"
            onClick={() => { setSelected(null); setDetail(null); setError(null); }}
          >
            ← Back to People
          </button>
          <button
            className="btn btn--secondary"
            onClick={() => retryResearch(displayName)}
            disabled={busy}
          >
            {busy ? 'Retrying…' : 'Retry'}
          </button>
        </div>
        <h2>{displayName}</h2>
        <p className="person-status">
          Status: <strong>{status}</strong>
          {progress && progress.total > 0 && status === 'running' && (
            <> — {progress.phase} {progress.current}/{progress.total}
              {progress.currentTitle && <> — "{progress.currentTitle}"</>}
            </>
          )}
        </p>
        {error && <p className="error">{error}</p>}
        {errorMessage && <p className="error">{errorMessage}</p>}

        {meta?.markdown && (
          <article className="prose">
            <Markdown>{meta.markdown}</Markdown>
            {meta.bestVideoReason && <p><em>Best-video reason: {meta.bestVideoReason}</em></p>}
          </article>
        )}

        <h3>Videos ({videos.length})</h3>
        <div className="history-grid">
          {videos.map(v => (
            <div key={v.videoId} className={`history-card ${v.videoId === bestId ? 'history-card--best' : ''}`}>
              {v.videoId === bestId && <div className="best-badge">★ Best pick</div>}
              <div className="history-date">{(v.publishedAt || '').slice(0, 10)}</div>
              <a href={v.url} target="_blank" rel="noopener noreferrer" className="history-title">{v.title}</a>
              <span className="history-url">{v.channelTitle}</span>
              {v.markdown && (
                <details>
                  <summary>Summary</summary>
                  <Markdown>{v.markdown}</Markdown>
                </details>
              )}
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="input-card">
        <input
          type="text"
          placeholder="Person's name (e.g. Andrej Karpathy)"
          value={name}
          onChange={e => setName(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && startResearch()}
          disabled={busy}
        />
        <button className="btn btn--primary" onClick={startResearch} disabled={busy}>
          {busy ? 'Starting…' : 'Research'}
        </button>
      </div>

      {error && <p className="error">{error}</p>}

      {people.length === 0 ? (
        <div className="empty-state">No people tracked yet. Add one above.</div>
      ) : (
        <div className="history-list">
          {people.map(p => (
            <button
              key={p.person}
              className="history-list-card"
              onClick={() => { setError(null); setSelected(p.person); }}
            >
              <div className="history-list-meta">
                <span className="history-date">{p.lastRunAt ? new Date(p.lastRunAt).toISOString().slice(0, 10) : '—'}</span>
                <span className="history-date">{p.status}</span>
              </div>
              <h3 className="history-list-title">{p.displayName}</h3>
              {p.status === 'running' && p.progress?.total > 0 && (
                <p className="history-list-snippet">{p.progress.phase} {p.progress.current}/{p.progress.total}</p>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

export default People;
