import React, { useState, useEffect, useRef } from 'react';
import { useLocation, navigate } from './useLocation.js';
import { canonicalYoutubeUrl, shareTargetUrl } from './share.js';
import { summaryPath, summaryIdFor, decodeId } from './paths.js';
import { hasBackend, listSummaries, listModels, createSummary } from './api.js';
import Header from './components/Header.jsx';
import Home from './pages/Home.jsx';
import History from './pages/History.jsx';
import People from './pages/People.jsx';
import Share from './pages/Share.jsx';
import Summary from './pages/Summary.jsx';

const PREFERRED_DEFAULT = 'models/gemini-flash-latest';

// Rendered while the ?models=1 fetch is pending or if it fails.
const FALLBACK_MODEL_OPTIONS = [
  { label: 'Gemini Flash Latest', value: 'models/gemini-flash-latest' },
  { label: 'Gemini 3 Flash', value: 'models/gemini-3-flash-preview' },
  { label: 'Gemini 3.1 Flash Lite', value: 'models/gemini-flash-lite-latest' },
  { label: 'Gemini 2.5 Flash', value: 'models/gemini-2.5-flash' },
  { label: 'Gemini 2.5 Flash Lite', value: 'models/gemini-2.5-flash-lite' },
];

// Model used for links arriving via the PWA share target — that flow has no UI
// to pick one, and Flash Latest is the fast, cheap default.
const SHARE_MODEL = PREFERRED_DEFAULT;

const KNOWN_PATHS = ['/', '/history', '/people', '/share'];

// Router, shared state and page chrome. Each route's markup lives in
// ./pages/*; anything that outlives a route change (the history list, the
// model dropdown, the speaker filter, the pending share) is owned here and
// handed down as props.
const BrightBlogApp = () => {
  const [url, setUrl] = useState('');
  const [loading, setLoading] = useState(false);
  // Inline failure message for the Generate button (rendered by the Home page).
  const [generateError, setGenerateError] = useState(null);
  const [history, setHistory] = useState([]);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [model, setModel] = useState(PREFERRED_DEFAULT);
  const [modelOptions, setModelOptions] = useState(FALLBACK_MODEL_OPTIONS);
  // Share-target flow: { status: 'working' | 'invalid' | 'error', url, message }
  const [share, setShare] = useState(null);
  // Speaker tag currently filtering the History page, or null for everything.
  const [speakerFilter, setSpeakerFilter] = useState(null);
  const shareStarted = useRef(false);

  const path = useLocation();
  const normalized = path.replace(/\/+$/, '') || '/';
  const summaryId = normalized.startsWith('/summary/')
    ? decodeId(normalized.slice('/summary/'.length))
    : null;
  const page = summaryId ? 'history'
             : normalized === '/people' ? 'people'
             : normalized === '/history' ? 'history'
             : normalized === '/share' ? 'share'
             : 'home';

  const detailItem = summaryId
    ? history.find((h) => summaryIdFor(h.url) === summaryId) || null
    : null;

  useEffect(() => {
    if (!hasBackend) { setHistoryLoaded(true); return; }
    listSummaries()
      .then(setHistory)
      .catch(console.error)
      .finally(() => setHistoryLoaded(true));
  }, []);

  useEffect(() => {
    if (!hasBackend) return;
    listModels()
      .then((models) => {
        if (models.length === 0) return;
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

  // Single path to the Lambda, shared by the Generate button and the share
  // target. Returns the new history item; throws on any non-2xx.
  const requestSummary = async (targetUrl, targetModel) => {
    const item = await createSummary(targetUrl, targetModel);
    // The Lambda dedupes on url, so an already-summarised video comes back
    // cached — replace the existing row rather than adding a duplicate.
    setHistory(prev => [item, ...prev.filter(h => h.url !== targetUrl)]);
    return item;
  };

  const generatePost = async () => {
    if (!url) return;
    // Convenience only — the Lambda canonicalises with this very function
    // before it reads or writes anything. Doing it here keeps the url we file
    // the history row under identical to the one the backend stores, and leaves
    // anything unrecognised alone so the backend still owns the rejection.
    const target = canonicalYoutubeUrl(url) || url;
    setLoading(true);
    setGenerateError(null);
    try {
      const item = await requestSummary(target, model);
      navigate(summaryPath(item));
    } catch (error) {
      console.error(error);
      setGenerateError('Error generating summary. Check the URL and try again.');
    } finally {
      setLoading(false);
    }
  };

  // ── Share target (/share?url=…&text=…&title=…) ────────────────────────────
  // Registered in public/manifest.json. Android hands the shared link over as
  // a GET navigation; summarise it with Flash Latest and land on the result.
  const runShare = React.useCallback(async (targetUrl) => {
    setShare({ status: 'working', url: targetUrl });
    try {
      const item = await requestSummary(targetUrl, SHARE_MODEL);
      setShare(null);
      // replace: Back from the summary should not re-run the share.
      navigate(summaryPath(item), { replace: true });
    } catch (error) {
      console.error(error);
      setShare({
        status: 'error',
        url: targetUrl,
        message: navigator.onLine === false
          ? 'You appear to be offline. Reconnect and try again.'
          : 'Could not generate a summary for that link.',
      });
    }
  }, []);

  useEffect(() => {
    if (page !== 'share' || shareStarted.current) return;
    shareStarted.current = true;

    const params = new URLSearchParams(window.location.search);
    const shared = shareTargetUrl(params);
    if (!shared) {
      setShare({
        status: 'invalid',
        message: 'That share did not contain a YouTube link.',
        raw: params.get('url') || params.get('text') || params.get('title') || '',
      });
      return;
    }
    if (!hasBackend) {
      setShare({ status: 'error', url: shared, message: 'Backend URL is not configured.' });
      return;
    }
    runShare(shared);
  }, [page, runShare]);

  const modelLabel = (value) => {
    if (!value) return '';
    const found = modelOptions.find((o) => o.value === value);
    return found ? found.label : value.replace(/^models\//, '');
  };

  // Tags live inside a card that is itself a link, so a tag click has to stop
  // the card navigation before applying the filter. The path is what decides
  // whether to navigate, not `page` — a /summary/ route reports page
  // 'history' but is not the list the filter applies to.
  const filterBySpeaker = (e, name) => {
    e.preventDefault();
    e.stopPropagation();
    setSpeakerFilter(name);
    if (normalized !== '/history') navigate('/history');
  };

  const route = summaryId ? (
    <Summary
      id={summaryId}
      item={detailItem}
      historyLoaded={historyLoaded}
      modelLabel={modelLabel}
      speakerFilter={speakerFilter}
      onSpeakerSelect={filterBySpeaker}
    />
  ) : page === 'share' ? (
    <Share
      share={share}
      shareModel={SHARE_MODEL}
      modelLabel={modelLabel}
      onRetry={runShare}
      setUrl={setUrl}
    />
  ) : page === 'people' ? (
    <People />
  ) : page === 'history' ? (
    <History
      history={history}
      speakerFilter={speakerFilter}
      onClearFilter={() => setSpeakerFilter(null)}
      onSpeakerSelect={filterBySpeaker}
      modelLabel={modelLabel}
    />
  ) : (
    <Home
      url={url}
      setUrl={setUrl}
      model={model}
      setModel={setModel}
      modelOptions={modelOptions}
      modelLabel={modelLabel}
      loading={loading}
      error={generateError}
      onGenerate={generatePost}
      history={history}
      speakerFilter={speakerFilter}
      onSpeakerSelect={filterBySpeaker}
    />
  );

  return (
    <div className="page-shell">
      <div className="container">
        <Header page={page} historyCount={history.length} />
        {route}
      </div>
    </div>
  );
};

export default BrightBlogApp;
