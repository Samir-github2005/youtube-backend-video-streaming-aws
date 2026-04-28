// Navbar.jsx — navigation bar, no logic
export default function Navbar({ page, setPage }) {
  return (
    <nav className="navbar">
      {/* Brand */}
      <a href="#" className="navbar__brand" onClick={(e) => { e.preventDefault(); setPage('library'); }}>
        <span className="navbar__brand-icon">▶</span>
        StreamVault
      </a>

      {/* Nav links */}
      <div className="navbar__links">
        <button
          id="nav-library"
          className={`navbar__link${page === 'library' ? ' navbar__link--active' : ''}`}
          onClick={() => setPage('library')}
        >
          📂 Library
        </button>
        <button
          id="nav-upload"
          className={`navbar__link${page === 'upload' ? ' navbar__link--active' : ''}`}
          onClick={() => setPage('upload')}
        >
          ＋ Upload
        </button>
      </div>
    </nav>
  );
}
