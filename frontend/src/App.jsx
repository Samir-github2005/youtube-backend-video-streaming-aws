// App.jsx
import { useState } from 'react';
import VideoPlayer from './VideoPlayer';
import 'videojs-hls-quality-selector/dist/videojs-hls-quality-selector.css';

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3000';
const CF_URL = import.meta.env.VITE_CLOUDFRONT_URL;

export default function App() {
  const [videoId, setVideoId] = useState(null);
  const [status, setStatus] = useState('idle'); // idle | uploading | processing | ready | error
  const [error, setError] = useState(null);

  const handleUpload = async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    setStatus('uploading');
    setError(null);

    try {
      const formData = new FormData();
      formData.append('file', file);

      const res = await fetch(`${BACKEND_URL}/upload`, {
        method: 'POST',
        body: formData
      });

      if (!res.ok) throw new Error('Upload failed');

      const data = await res.json();
      setVideoId(data.videoId);
      setStatus('processing');

      // poll backend every 5 seconds to check if HLS is ready
      pollStatus(data.videoId);


    } catch (err) {
      setError(err.message);
      setStatus('error');
    }
  };

  const pollStatus = (id) => {
    const interval = setInterval(async () => {
      try {
        const res = await fetch(`${BACKEND_URL}/status/${id}`);
        const data = await res.json();

        if (data.status === 'ready') {
          clearInterval(interval);
          setStatus('ready');
        } else if (data.status === 'failed') {
          clearInterval(interval);
          setStatus('error');
          setError('Processing failed');
        }
      } catch {
        clearInterval(interval);
      }
    }, 5000);
  };

  const hlsUrl = videoId
    ? `${CF_URL}/hls/${videoId}/master.m3u8`
    : null;

  return (
    <div style={{ maxWidth: 800, margin: '40px auto', padding: '0 20px' }}>
      <h2>Video Streaming Pipeline</h2>

      <input
        type="file"
        accept="video/*"
        onChange={handleUpload}
        disabled={status === 'uploading' || status === 'processing'}
      />

      {status === 'uploading' && <p>Uploading to S3...</p>}
      {status === 'processing' && <p>Processing video... this takes a minute</p>}
      {status === 'error' && <p style={{ color: 'red' }}>{error}</p>}

      {status === 'ready' && hlsUrl && (
        <VideoPlayer
          options={{
            controls: true,
            autoplay: true,
            responsive: true,
            fluid: true,
            html5: {
              vhs: {
                enableLowLatency: true,
                overrideNative: true,
              }
            },
            sources: [{ src: hlsUrl, type: 'application/x-mpegURL' }],
          }}
        />
      )}
    </div>
  );
}