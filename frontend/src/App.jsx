// App.jsx — global state shell + routing
import { useEffect, useState } from 'react';
import './index.css';
import Navbar from './Navbar';
import VideoLibrary from './VideoLibrary';
import Upload from './Upload';

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3000';

export default function App() {
  const [videos, setVideos] = useState([]);
  const [page, setPage]     = useState('library'); // 'library' | 'upload'

  /* ── Initial fetch of video list ───────────────────── */
  useEffect(() => {
    fetch(`${BACKEND_URL}/videos`)
      .then((r) => r.json())
      .then((data) => setVideos(data))
      .catch(console.error);
  }, []);

  /* ── Callback for Library polling to push fresh data ── */
  const handleVideosUpdate = (data) => setVideos(data);

  /* ── Called by Upload when transcoding finishes ──────── */
  const handleUploadDone = () => {
    fetch(`${BACKEND_URL}/videos`)
      .then((r) => r.json())
      .then((data) => setVideos(data))
      .catch(console.error);
  };

  return (
    <>
      <Navbar page={page} setPage={setPage} />

      {page === 'library' && (
        <VideoLibrary
          videos={videos}
          onVideosUpdate={handleVideosUpdate}
          onNavigate={setPage}
        />
      )}

      {page === 'upload' && (
        <Upload
          onUploadDone={handleUploadDone}
          onNavigate={setPage}
        />
      )}
    </>
  );
}