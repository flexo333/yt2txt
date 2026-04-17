import React, { useState, useEffect } from 'react';
import ReactMarkdown from 'react-markdown';

const LAMBDA_URL = import.meta.env.VITE_LAMBDA_URL;

const MODEL_OPTIONS = [
  { label: 'Gemma 4 26B', value: 'gemma-4-26b-a4b-it' },
  { label: 'Gemma 4 31B', value: 'gemma-4-31b-a4b-it' },
  { label: 'Gemini 2.5 Flash', value: 'gemini-2.5-flash' },
  { label: 'Gemini 3 Flash', value: 'gemini-3-flash-preview' },
  { label: 'Gemini 3.1 Flash Lite', value: 'gemini-3.1-flash-lite' },
  { label: 'Gemini 2.5 Flash Lite', value: 'gemini-2.5-flash-lite' },
];

const BrightBlogApp = () => {
  const [url, setUrl] = useState('');
  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(false);
  const [history, setHistory] = useState([]);
  const [page, setPage] = useState('home');
  const [detailItem, setDetailItem] = useState(null);
  const [model, setModel] = useState('gemini-3-flash-preview');

  useEffect(() => {
    if (!LAMBDA_URL) return;
    fetch(LAMBDA_URL)
      .then(r => r.json())
      .then(({ summaries }) => setHistory(summaries || []))
      .catch(console.error);
  }, []);

  const generatePost = async () => {
    if (!url) return;
    setLoading(true);
    try {
      const res = await fetch(LAMBDA_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, model }),
      });
      if (!res.ok) throw new Error(await res.text());
      const { markdown, title, date } = await res.json();
      setContent(markdown);
      setHistory(prev => [{ url, title, date, summary: markdown.slice(0, 8000) }, ...prev]);
      setPage('home');
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

  const openDetail = (item) => {
    setDetailItem(item);
  };

  const closeDetail = () => {
    setDetailItem(null);
  };

  const Header = () => (
    <header className="site-header">
      <h1>yt2txt</h1>
      <p>Converting visual noise into structured wisdom.</p>
      <nav className="site-nav">
        <button
          className={`nav-link ${page === 'home' ? 'nav-link--active' : ''}`}
          onClick={() => { setPage('home'); setDetailItem(null); }}
        >
          Home
        </button>
        <button
          className={`nav-link ${page === 'history' ? 'nav-link--active' : ''}`}
          onClick={() => { setPage('history'); setDetailItem(null); }}
        >
          History {history.length > 0 && <span className="nav-badge">{history.length}</span>}
        </button>
      </nav>
    </header>
  );

  if (detailItem) {
    return (
      <div className="page-shell">
        <div className="container">
          <Header />
          <div className="article-actions">
            <button className="btn btn--secondary" onClick={closeDetail}>
              ← Back to History
            </button>
            <button className="btn btn--secondary" onClick={() => downloadMarkdown(detailItem.summary)}>
              Download .md
            </button>
          </div>
          <article className="prose">
            <ReactMarkdown>{detailItem.summary}</ReactMarkdown>
          </article>
        </div>
      </div>
    );
  }

  if (page === 'history') {
    return (
      <div className="page-shell">
        <div className="container">
          <Header />
          {history.length === 0 ? (
            <div className="empty-state">No summaries yet. Generate one from the Home page.</div>
          ) : (
            <div className="history-list">
              {history.map((item, i) => (
                <button
                  key={i}
                  className="history-list-card"
                  onClick={() => openDetail(item)}
                >
                  <div className="history-list-meta">
                    <span className="history-date">{item.date}</span>
                  </div>
                  <h3 className="history-list-title">{item.title || item.url}</h3>
                  {item.summary && (
                    <p className="history-list-snippet">
                      {item.summary.replace(/^#+\s.+\n?/gm, '').replace(/[*_`#]/g, '').trim().slice(0, 200)}…
                    </p>
                  )}
                  <span className="history-list-url">{item.url}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  }

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
            {MODEL_OPTIONS.map((option) => (
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

        {content ? (
          <>
            <div className="article-actions">
              <button className="btn btn--secondary" onClick={() => downloadMarkdown(content)}>
                Download .md
              </button>
            </div>
            <article className="prose">
              <ReactMarkdown>{content}</ReactMarkdown>
            </article>
          </>
        ) : (
          <div className="empty-state">
            Your summary will appear here.
          </div>
        )}

        {history.length > 0 && (
          <section className="history-section">
            <h2>Past Summaries</h2>
            <div className="history-grid">
              {history.map((item, i) => (
                <button
                  key={i}
                  className="history-card"
                  onClick={() => openDetail(item)}
                >
                  <div className="history-date">{item.date}</div>
                  <span className="history-title">{item.title || item.url}</span>
                  <span className="history-url">{item.url}</span>
                </button>
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  );
};

export default BrightBlogApp;
