// Upload.jsx — drag-drop file input, XHR progress, status polling, redirects on done
import { useState, useRef } from 'react';

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3000';

export default function Upload({ onUploadDone, onNavigate }) {
  const [title, setTitle]           = useState('');
  const [description, setDescription] = useState('');
  const [file, setFile]             = useState(null);
  const [isDragging, setIsDragging] = useState(false);

  // phase: idle | uploading | processing | done | error
  const [phase, setPhase]     = useState('idle');
  const [progress, setProgress] = useState(0);
  const [errorMsg, setErrorMsg] = useState('');

  const fileInputRef = useRef(null);
  const pollRef      = useRef(null);

  /* ── File selection ─────────────────────────────────── */
  const handleFileChange = (e) => {
    const f = e.target.files[0];
    if (f) setFile(f);
  };

  const handleDrop = (e) => {
    e.preventDefault();
    setIsDragging(false);
    const f = e.dataTransfer.files[0];
    if (f && f.type.startsWith('video/')) setFile(f);
  };

  /* ── Upload via XHR (gives us onprogress) ────────────── */
  const handleSubmit = (e) => {
    e.preventDefault();
    if (!file) return;

    setPhase('uploading');
    setProgress(0);
    setErrorMsg('');

    const formData = new FormData();
    formData.append('file', file);
    formData.append('title', title || file.name.replace(/\.[^.]+$/, ''));
    formData.append('description', description);

    const xhr = new XMLHttpRequest();

    xhr.upload.onprogress = (ev) => {
      if (ev.lengthComputable) {
        setProgress(Math.round((ev.loaded / ev.total) * 100));
      }
    };

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        const data = JSON.parse(xhr.responseText);
        setPhase('processing');
        startPolling(data.videoId);
      } else {
        setPhase('error');
        setErrorMsg(`Upload failed (HTTP ${xhr.status})`);
      }
    };

    xhr.onerror = () => {
      setPhase('error');
      setErrorMsg('Network error — could not reach the server.');
    };

    xhr.open('POST', `${BACKEND_URL}/upload`);
    xhr.send(formData);
  };

  /* ── Poll /status until ready ───────────────────────── */
  const startPolling = (videoId) => {
    pollRef.current = setInterval(async () => {
      try {
        const res  = await fetch(`${BACKEND_URL}/status/${videoId}`);
        const data = await res.json();

        if (data.status === 'ready') {
          clearInterval(pollRef.current);
          setPhase('done');
          onUploadDone?.();          // refresh video list in App
          setTimeout(() => onNavigate('library'), 1500);
        } else if (data.status === 'failed') {
          clearInterval(pollRef.current);
          setPhase('error');
          setErrorMsg('Transcoding failed on the server.');
        }
      } catch {
        clearInterval(pollRef.current);
        setPhase('error');
        setErrorMsg('Lost connection while waiting for processing.');
      }
    }, 5000);
  };

  const isSubmitting = phase === 'uploading' || phase === 'processing';

  return (
    <main className="page upload-page">
      <div className="page-header">
        <button
          id="upload-back-btn"
          className="btn btn-ghost"
          onClick={() => onNavigate('library')}
        >
          ← Library
        </button>
        <h1 className="page-title">Upload Video</h1>
      </div>

      <form className="upload-section" onSubmit={handleSubmit}>
        {/* Title */}
        <div className="form-group">
          <label className="form-label" htmlFor="upload-title">Title</label>
          <input
            id="upload-title"
            className="form-input"
            type="text"
            placeholder="Give your video a title…"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            disabled={isSubmitting}
          />
        </div>

        {/* Description */}
        <div className="form-group">
          <label className="form-label" htmlFor="upload-description">Description <span className="text-muted">(optional)</span></label>
          <input
            id="upload-description"
            className="form-input"
            type="text"
            placeholder="Short description…"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            disabled={isSubmitting}
          />
        </div>

        {/* Dropzone */}
        <div
          className={`dropzone${isDragging ? ' dropzone--active' : ''}`}
          onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
          onDragLeave={() => setIsDragging(false)}
          onDrop={handleDrop}
          onClick={() => !isSubmitting && fileInputRef.current?.click()}
        >
          <input
            ref={fileInputRef}
            type="file"
            accept="video/*"
            onChange={handleFileChange}
            disabled={isSubmitting}
            id="upload-file-input"
            style={{ display: 'none' }}
          />
          <span className="dropzone__icon">🎥</span>
          <p className="dropzone__text">
            {isDragging ? 'Drop it here!' : 'Drag & drop a video or click to browse'}
          </p>
          <p className="dropzone__sub">MP4, MOV, MKV, WebM — any size</p>
          {file && <p className="dropzone__filename">📄 {file.name}</p>}
        </div>

        {/* Upload progress */}
        {phase === 'uploading' && (
          <div className="progress-wrap">
            <div className="progress-label">
              <span>Uploading…</span>
              <span>{progress}%</span>
            </div>
            <div className="progress-track">
              <div className="progress-fill" style={{ width: `${progress}%` }} />
            </div>
          </div>
        )}

        {/* Status messages */}
        {phase === 'processing' && (
          <div className="status-row status-row--processing">
            <span className="spin">⏳</span>
            Transcoding to HLS — this may take a minute…
          </div>
        )}
        {phase === 'done' && (
          <div className="status-row status-row--success">
            ✅ Ready! Redirecting to Library…
          </div>
        )}
        {phase === 'error' && (
          <div className="status-row status-row--error">
            ❌ {errorMsg}
          </div>
        )}

        {/* Submit */}
        {!isSubmitting && phase !== 'done' && (
          <button
            id="upload-submit-btn"
            type="submit"
            className="btn btn-primary"
            style={{ alignSelf: 'flex-start' }}
            disabled={!file}
          >
            🚀 Upload &amp; Transcode
          </button>
        )}
      </form>
    </main>
  );
}
