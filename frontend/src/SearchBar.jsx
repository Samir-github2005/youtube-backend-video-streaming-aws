// SearchBar.jsx — controlled search input
export default function SearchBar({ value, onChange }) {
  return (
    <div className="search-bar">
      <span className="search-bar__icon" aria-hidden="true">🔍</span>
      <input
        id="video-search"
        type="text"
        className="search-bar__input"
        placeholder="Search videos…"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-label="Search videos"
      />
      {value && (
        <button
          className="search-bar__clear"
          onClick={() => onChange('')}
          aria-label="Clear search"
        >
          ✕
        </button>
      )}
    </div>
  );
}
