import { navigate } from '../useLocation.js';

// Landing page for the Web Share Target (/share?url=…&text=…&title=…),
// registered in public/manifest.json. Purely presentational: App.jsx owns the
// share state and runs the summarise request, because the result has to land
// in the shared history list and navigate with `replace` so Back does not
// re-run the share.
//
// `share` is null (or { status: 'working' }) while the request is in flight,
// then { status: 'invalid' | 'error', message, url?, raw? }.
const Share = ({ share, shareModel, modelLabel, onRetry, setUrl }) => {
  const working = !share || share.status === 'working';

  return (
    <div className="share-panel">
      {working ? (
        <>
          <div className="share-spinner" aria-hidden="true" />
          <h2>Summarising shared link…</h2>
          {share?.url && <p className="share-url">{share.url}</p>}
          <p className="share-note">
            Running through {modelLabel(shareModel)}. This usually takes half a minute.
          </p>
        </>
      ) : (
        <>
          <h2>{share.status === 'invalid' ? 'No YouTube link found' : 'Summary failed'}</h2>
          <p className="share-note">{share.message}</p>
          {share.url && <p className="share-url">{share.url}</p>}
          {share.raw && <p className="share-url">{share.raw}</p>}
          <div className="article-actions">
            {share.status === 'error' && (
              <button className="btn btn--primary" onClick={() => onRetry(share.url)}>
                Try again
              </button>
            )}
            <button
              className="btn btn--secondary"
              onClick={() => {
                if (share.status === 'invalid' && share.raw) setUrl(share.raw);
                navigate('/');
              }}
            >
              Enter a link manually
            </button>
          </div>
        </>
      )}
    </div>
  );
};

export default Share;
