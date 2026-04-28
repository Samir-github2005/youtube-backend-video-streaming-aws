// VideoLibrary.jsx — Library page: polls /videos, renders SearchBar + VideoGrid + VideoPlayer
import { useState, useEffect } from 'react';
import SearchBar from './SearchBar';
import VideoGrid from './VideoGrid';
import VideoPlayer from './VideoPlayer';

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3000';
const CF_URL      = import.meta.env.VITE_CLOUDFRONT_URL;

export default function VideoLibrary({ videos, onVideosUpdate, onNavigate }) {
  const [query, setQuery]               = useState('');
  const [selectedVideo, setSelectedVideo] = useState(null);

  /* ── Poll every 10 s to catch newly processed videos ── */
  useEffect(() => {
    const id = setInterval(() => {
      fetch(`${BACKEND_URL}/videos`)
        .then((r) => r.json())
        .then((data) => onVideosUpdate(data))
        .catch(() => {});
    }, 10_000);
    return () => clearInterval(id);
  }, [onVideosUpdate]);

  /* ── Filter videos by search query ─────────────────── */
  const filtered = videos.filter((v) =>
    (v.title ?? '').toLowerCase().includes(query.toLowerCase())
  );

  /* ── HLS URL for selected video ─────────────────────── */
  const hlsUrl = selectedVideo
    ? `${CF_URL}/hls/${selectedVideo.videoId}/master.m3u8`
    : null;

  return (
    <main className="page">
      <div className="library-layout">
        {/* ── Player area ─────────────────────────────── */}
        <div className="library-player-wrap">
          {selectedVideo && hlsUrl ? (
            <>
              <div className="library-player-header">
                <span className="library-player-title">▶ {selectedVideo.title}</span>
                <button
                  id="player-close-btn"
                  className="btn btn-ghost"
                  style={{ padding: '4px 10px', fontSize: 12 }}
                  onClick={() => setSelectedVideo(null)}
                >
                  ✕ Close
                </button>
              </div>
              {/* key={hlsUrl} forces VideoPlayer to fully remount on new video */}
              <VideoPlayer key={hlsUrl} src={hlsUrl} />
            </>
          ) : (
            <div className="library-player-placeholder">
              <span className="placeholder-icon">🎬</span>
              <p className="text-muted">Select a video below to start watching</p>
            </div>
          )}
        </div>

        {/* ── Controls bar ─────────────────────────────── */}
        <div className="page-header" style={{ marginBottom: 0 }}>
          <h2 className="page-title">Your Videos</h2>
          <SearchBar value={query} onChange={setQuery} />
          <button
            id="library-upload-btn"
            className="btn btn-primary"
            onClick={() => onNavigate('upload')}
          >
            ＋ Upload
          </button>
        </div>

        {/* ── Video Grid ───────────────────────────────── */}
        <VideoGrid
          videos={filtered}
          onSelect={setSelectedVideo}
          selectedVideoId={selectedVideo?.videoId}
        />
      </div>
    </main>
  );
}
