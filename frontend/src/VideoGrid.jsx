// VideoGrid.jsx — renders a VideoCard for each filtered video
import VideoCard from './VideoCard';

export default function VideoGrid({ videos, onSelect, selectedVideoId }) {
  if (!videos || videos.length === 0) {
    return (
      <div className="video-grid">
        <div className="video-grid__empty">
          <span className="video-grid__empty-icon">🎬</span>
          <p>No videos found</p>
        </div>
      </div>
    );
  }

  return (
    <div className="video-grid">
      {videos.map((video) => (
        <VideoCard
          key={video.videoId}
          video={video}
          onSelect={onSelect}
          isActive={video.videoId === selectedVideoId}
        />
      ))}
    </div>
  );
}
