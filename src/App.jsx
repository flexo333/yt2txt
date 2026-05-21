import React, { useState, useEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import People from './pages/People.jsx';
import { useLocation, navigate } from './useLocation.js';

const LAMBDA_URL = import.meta.env.VITE_LAMBDA_URL;
const YT2TXT_KEY = import.meta.env.VITE_YT2TXT_KEY || '';

const authHeaders = () => (YT2TXT_KEY ? { 'x-yt2txt-key': YT2TXT_KEY } : {});

const MARKDOWN_URL_TRANSFORM = (url) => {
  try {
    const u = new URL(url, window.location.href);
    return ['http:', 'https:', 'mailto:'].includes(u.protocol) ? url : '';
  } catch {
    return '';
  }
};

const MARKDOWN_COMPONENTS = {
  a: ({ node, ...props }) => (
    <a {...props} target="_blank" rel="noopener noreferrer nofollow ugc" />
  ),
};

const PREFERRED_DEFAULT = 'models/gemini-3-flash-preview';

// Rendered while the ?models=1 fetch is pending or if it fails.
const FALLBACK_MODEL_OPTIONS = [
  { label: 'Gemini 3 Flash', value: 'models/gemini-3-flash-preview' },
  { label: 'Gemini 3.1 Flash Lite', value: 'models/gemini-flash-lite-latest' },
  { label: 'Gemini 2.5 Flash', value: 'models/gemini-2.5-flash' },
  { label: 'Gemini 2.5 Flash Lite', value: 'models/gemini-2.5-flash-lite' },
  { label: 'Gemma 4 31B', value: 'models/gemma-4-31b-it' },
  { label: 'Gemma 4 26B', value: 'models/gemma-4-26b-a4b-it' },
];

const KNOWN_PATHS = ['/', '/history', '/people'];

// Extract a stable id from a stored YouTube URL (DynamoDB hash key is the full
// url). Falls back to the raw url for unrecognised forms, so building a summary
// path and resolving it always use the same value.
const videoIdFromUrl = (raw) => {
  try {
    const u = new URL(raw);
    if (u.hostname.endsWith('youtu.be')) return u.pathname.slice(1) || raw;
    const v = u.searchParams.get('v');
    if (v) return v;
    const m = u.pathname.match(/\/(shorts|live|embed)\/([^/]+)/);
    if (m) return m[2];
    return raw;
  } catch {
    return raw;
  }
};

const summaryPath = (item) => `/summary/${encodeURIComponent(videoIdFromUrl(item.url))}`;

// decodeURIComponent throws on a malformed % sequence — never crash the render.
const decodeId = (s) => {
  try { return decodeURIComponent(s); } catch { return s; }
};

const BrightBlogApp = () => {
  const [url, setUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [history, setHistory] = useState([]);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [model, setModel] = useState(PREFERRED_DEFAULT);
  const [modelOptions, setModelOptions] = useState(FALLBACK_MODEL_OPTIONS);

  const path = useLocation();
  const normalized = path.replace(/\/+$/, '') || '/';
  const summaryId = normalized.startsWith('/summary/')
    ? decodeId(normalized.slice('/summary/'.length))
    : null;
  const page = summaryId ? 'history'
             : normalized === '/people' ? 'people'
             : normalized === '/history' ? 'history'
             : 'home';

  const detailItem = summaryId
    ? history.find((h) => videoIdFromUrl(h.url) === summaryId) || null
    : null;

  useEffect(() => {
    if (!LAMBDA_URL) { setHistoryLoaded(true); return; }
    fetch(LAMBDA_URL, { headers: authHeaders() })
      .then(r => r.json())
      .then(({ summaries }) => setHistory(summaries || []))
      .catch(console.error)
      .finally(() => setHistoryLoaded(true));
  }, []);

  useEffect(() => {
    if (!LAMBDA_URL) return;
    fetch(`${LAMBDA_URL}?models=1`, { headers: authHeaders() })
      .then(r => r.json())
      .then(({ models }) => {
        if (!Array.isArray(models) || models.length === 0) return;
        setModelOptions(models);
        setModel(prev => (models.some(m => m.value === prev) ? prev : models[0].value));
      })
      .catch(console.error);
  }, []);

  // Reset scroll position whenever the route changes.
  useEffect(() => { window.scrollTo(0, 0); }, [path]);

  // Send unknown top-level paths back to Home.
  useEffect(() => {
    if (!summaryId && !KNOWN_PATHS.includes(normalized)) {
      navigate('/', { replace: true });
    }
  }, [normalized, summaryId]);

  const generatePost = async () => {
    if (!url) return;
    setLoading(true);
    try {
      const res = await fetch(LAMBDA_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ url, model }),
      });
      if (!res.ok) throw new Error(await res.text());
      const { markdown, title, date, model: usedModel } = await res.json();
      const item = { url, title, date, summary: markdown, model: usedModel };
      setHistory(prev => [item, ...prev]);
      navigate(summaryPath(item));
    } catch (error) {
      alert('Error generating summary. Check the URL and try again.');
      console.error(error);
    } finally {
      setLoading(false);
    }
  };

  const downloadMarkdown = (text) => {
    const blob = new Blob([text], { type: 'text/markdown' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `summary-${Date.now()}.md`;
    link.click();
  };

  const onKeyDown = (e) => {
    if (e.key === 'Enter') generatePost();
  };

  // Intercept plain left-clicks on in-app links; let modified clicks
  // (new tab, etc.) fall through to native browser handling.
  const linkClick = (e, href) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    navigate(href);
  };

  const modelLabel = (value) => {
    if (!value) return '';
    const found = modelOptions.find((o) => o.value === value);
    return found ? found.label : value.replace(/^models\//, '');
  };

  const Header = () => (
    <header className="site-header">
      <div className="site-brand">
        <img src="/yt2txt.svg" alt="" className="site-logo" width="40" height="40" />
        <h1>yt2txt</h1>
      </div>
      <p>Converting visual noise into structured wisdom.</p>
      <nav className="site-nav">
        <a
          href="/"
          className={`nav-link ${page === 'home' ? 'nav-link--active' : ''}`}
          onClick={(e) => linkClick(e, '/')}
        >
          Home
        </a>
        <a
          href="/history"
          className={`nav-link ${page === 'history' ? 'nav-link--active' : ''}`}
          onClick={(e) => linkClick(e, '/history')}
        >
          History {history.length > 0 && <span className="nav-badge">{history.length}</span>}
        </a>
        <a
          href="/people"
          className={`nav-link ${page === 'people' ? 'nav-link--active' : ''}`}
          onClick={(e) => linkClick(e, '/people')}
        >
          People
        </a>
      </nav>
    </header>
  );

  // ── Summary detail (derived from /summary/<videoId>) ──────────────────────
  if (summaryId) {
    return (
      <div className="page-shell">
        <div className="container">
          <Header />
          {!historyLoaded ? (
            <div className="empty-state">Loading…</div>
          ) : detailItem ? (
            <>
              <div className="article-actions">
                <button className="btn btn--secondary" onClick={() => navigate('/history')}>
                  ← Back to History
                </button>
                <button className="btn btn--secondary" onClick={() => downloadMarkdown(detailItem.summary)}>
                  Download .md
                </button>
              </div>
              {detailItem.model && (
                <div className="summary-meta">
                  <span className="model-tag">{modelLabel(detailItem.model)}</span>
                </div>
              )}
              <article className="prose">
                <ReactMarkdown urlTransform={MARKDOWN_URL_TRANSFORM} components={MARKDOWN_COMPONENTS}>{detailItem.summary}</ReactMarkdown>
              </article>
            </>
          ) : (
            <div className="empty-state">
              Summary not found.{' '}
              <a href="/history" onClick={(e) => linkClick(e, '/history')}>Back to History</a>
            </div>
          )}
        </div>
      </div>
    );
  }

  // ── People ────────────────────────────────────────────────────────────────
  if (page === 'people') {
    return (
      <div className="page-shell">
        <div className="container">
          <Header />
          <People />
        </div>
      </div>
    );
  }

  // ── History list ──────────────────────────────────────────────────────────
  if (page === 'history') {
    return (
      <div className="page-shell">
        <div className="container">
          <Header />
          {history.length === 0 ? (
            <div className="empty-state">No summaries yet. Generate one from the Home page.</div>
          ) : (
            <div className="history-list">
              {history.map((item, i) => {
                const href = summaryPath(item);
                return (
                  <a
                    key={i}
                    href={href}
                    className="history-list-card"
                    onClick={(e) => linkClick(e, href)}
                  >
                    <div className="history-list-meta">
                      <span className="history-date">{item.date}</span>
                      {item.model && <span className="model-tag">{modelLabel(item.model)}</span>}
                    </div>
                    <h3 className="history-list-title">{item.title || item.url}</h3>
                    {item.summary && (
                      <p className="history-list-snippet">
                        {item.summary.replace(/^#+\s.+\n?/gm, '').replace(/[*_`#]/g, '').trim().slice(0, 200)}…
                      </p>
                    )}
                    <span className="history-list-url">{item.url}</span>
                  </a>
                );
              })}
            </div>
          )}
        </div>
      </div>
    );
  }

  // ── Home ──────────────────────────────────────────────────────────────────
  return (
    <div className="page-shell">
      <div className="container">
        <Header />

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
            onClick={generatePost}
            disabled={loading}
          >
            {loading ? 'Analysing…' : 'Generate'}
          </button>
        </div>

        {history.length > 0 ? (
          <section className="history-section">
            <h2>Past Summaries</h2>
            <div className="history-grid">
              {history.map((item, i) => {
                const href = summaryPath(item);
                return (
                  <a
                    key={i}
                    href={href}
                    className="history-card"
                    onClick={(e) => linkClick(e, href)}
                  >
                    <div className="history-date">{item.date}</div>
                    <span className="history-title">{item.title || item.url}</span>
                    <span className="history-url">{item.url}</span>
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
      </div>
    </div>
  );
};

export default BrightBlogApp;
