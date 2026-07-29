import { linkClick } from '../useLocation.js';

// Site chrome, shared by every route. `page` is the router's coarse route name
// ('home' | 'history' | 'people' | 'share'); a /summary/<id> route reports
// 'history' so the History tab stays lit while reading a summary.
const Header = ({ page, historyCount }) => (
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
        History {historyCount > 0 && <span className="nav-badge">{historyCount}</span>}
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

export default Header;
