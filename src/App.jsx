import React, { useState, useEffect } from 'react';
import ReactMarkdown from 'react-markdown';

const LAMBDA_URL = import.meta.env.VITE_LAMBDA_URL;

const BrightBlogApp = () => {
  const [url, setUrl] = useState('');
  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(false);
  const [history, setHistory] = useState([]);

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
        body: JSON.stringify({ url }),
      });
      if (!res.ok) throw new Error(await res.text());
      const { markdown, title, date } = await res.json();
      setContent(markdown);
      setHistory(prev => [{ url, title, date }, ...prev]);
    } catch (error) {
      alert('Error generating summary. Check the URL and try again.');
      console.error(error);
    } finally {
      setLoading(false);
    }
  };

  const downloadMarkdown = () => {
    const blob = new Blob([content], { type: 'text/markdown' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `summary-${Date.now()}.md`;
    link.click();
  };

  const onKeyDown = (e) => {
    if (e.key === 'Enter') generatePost();
  };

  return (
    <div className="page-shell">
      <div className="container">
        <header className="site-header">
          <h1>yt2txt</h1>
          <p>Converting visual noise into structured wisdom.</p>
        </header>

        <div className="input-card">
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
              <button className="btn btn--secondary" onClick={downloadMarkdown}>
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
                <div key={i} className="history-card">
                  <div className="history-date">{item.date}</div>
                  <span className="history-title">{item.title || item.url}</span>
                  <a
                    className="history-url"
                    href={item.url}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {item.url}
                  </a>
                </div>
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  );
};

export default BrightBlogApp;
