// VideoCard.jsx — single video card in the grid
export default function VideoCard({ video, onSelect, isActive }) {
  const isReady      = video.status === 'ready';
  const isProcessing = video.status === 'processing';

  const handleClick = () => {
    if (isReady) onSelect(video);
  };

  const formattedDate = video.createdAt
    ? new Date(video.createdAt).toLocaleDateString('en-US', {
        month: 'short', day: 'numeric', year: 'numeric',
      })
    : '';

  let cardClass = 'video-card';
  if (isProcessing) cardClass += ' video-card--processing';
  if (isActive)     cardClass += ' video-card--active';

  return (
    <div
      id={`video-card-${video.videoId}`}
      className={cardClass}
      onClick={handleClick}
      role={isReady ? 'button' : undefined}
      tabIndex={isReady ? 0 : undefined}
      onKeyDown={(e) => e.key === 'Enter' && handleClick()}
      aria-label={`Play ${video.title}`}
    >
      {/* Thumbnail */}
      <div className="video-card__thumb">
        <div className="video-card__play">▶</div>
        {isProcessing && <div className="video-card__spinner" />}
      </div>

      {/* Info */}
      <div className="video-card__info">
        <p className="video-card__title" title={video.title}>{video.title || 'Untitled'}</p>
        <div className="video-card__meta">
          <span className="video-card__date">{formattedDate}</span>
          <span className={`badge badge--${video.status ?? 'processing'}`}>
            {video.status ?? 'processing'}
          </span>
        </div>
      </div>
    </div>
  );
}
