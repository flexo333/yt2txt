import React, { useState, useEffect, useRef } from 'react';
import ReactMarkdown from 'react-markdown';

const LAMBDA_URL = import.meta.env.VITE_LAMBDA_URL;
const YT2TXT_KEY = import.meta.env.VITE_YT2TXT_KEY || '';
const authHeaders = () => (YT2TXT_KEY ? { 'x-yt2txt-key': YT2TXT_KEY } : {});

const urlTransform = (url) => {
  try {
    const u = new URL(url, window.location.href);
    return ['http:', 'https:', 'mailto:'].includes(u.protocol) ? url : '';
  } catch { return ''; }
};

const mdComponents = {
  a: ({ node, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer nofollow ugc" />,
};

const People = () => {
  const [people, setPeople] = useState([]);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState(null);
  const [detail, setDetail] = useState(null);
  const pollRef = useRef(null);

  const loadPeople = async () => {
    try {
      const res = await fetch(`${LAMBDA_URL}?people=1`, { headers: authHeaders() });
      const { people } = await res.json();
      setPeople(people || []);
    } catch (e) { console.error(e); }
  };

  const loadDetail = async (person) => {
    try {
      const res = await fetch(`${LAMBDA_URL}?person=${encodeURIComponent(person)}`, { headers: authHeaders() });
      if (!res.ok) { setDetail(null); return; }
      const data = await res.json();
      setDetail(data);
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
    if (detail && (detail.status === 'done' || detail.status === 'error')) {
      clearInterval(pollRef.current);
      loadPeople();
    }
  }, [detail?.status]);

  const startResearch = async () => {
    if (!name.trim()) return;
    setBusy(true);
    try {
      const res = await fetch(LAMBDA_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ action: 'research', person: name.trim() }),
      });
      if (!res.ok) throw new Error(await res.text());
      const { person } = await res.json();
      setSelected(person);
      setName('');
      loadPeople();
    } catch (e) {
      alert('Failed to start research: ' + e.message);
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
          <button className="btn btn--secondary" onClick={() => { setSelected(null); setDetail(null); }}>
            ← Back to People
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
        {errorMessage && <p className="error">{errorMessage}</p>}

        {meta?.markdown && (
          <article className="prose">
            <ReactMarkdown urlTransform={urlTransform} components={mdComponents}>{meta.markdown}</ReactMarkdown>
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
                  <ReactMarkdown urlTransform={urlTransform} components={mdComponents}>{v.markdown}</ReactMarkdown>
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

      {people.length === 0 ? (
        <div className="empty-state">No people tracked yet. Add one above.</div>
      ) : (
        <div className="history-list">
          {people.map(p => (
            <button
              key={p.person}
              className="history-list-card"
              onClick={() => setSelected(p.person)}
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
