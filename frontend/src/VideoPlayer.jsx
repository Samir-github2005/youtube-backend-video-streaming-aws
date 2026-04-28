import { useRef, useEffect, useState } from 'react';
import Hls from 'hls.js';

export default function VideoPlayer({ src }) {
  const videoRef = useRef(null);
  const hlsRef = useRef(null);
  const [levels, setLevels] = useState([]);
  const [currentLevel, setCurrentLevel] = useState(-1); // -1 = Auto
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !src) return;

    if (Hls.isSupported()) {
      const hls = new Hls();
      hlsRef.current = hls;

      hls.loadSource(src);
      hls.attachMedia(video);

      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        setLevels(hls.levels);
        video.play().catch(() => {});
      });

      hls.on(Hls.Events.LEVEL_SWITCHED, (_, data) => {
        setCurrentLevel(data.level);
      });

      return () => {
        hls.destroy();
        hlsRef.current = null;
      };
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      // Safari native HLS
      video.src = src;
      video.addEventListener('loadedmetadata', () => video.play());
    }
  }, [src]);

  const switchQuality = (levelIndex) => {
    if (!hlsRef.current) return;
    hlsRef.current.currentLevel = levelIndex; // -1 = auto
    setCurrentLevel(levelIndex);
    setMenuOpen(false);
  };

  const activeLabel =
    currentLevel === -1 ? 'Auto' : `${levels[currentLevel]?.height}p`;

  return (
    <div className="hls-player-wrap">
      <video ref={videoRef} controls />

      {levels.length > 1 && (
        <div className="quality-menu">
          <button
            className="quality-menu__toggle"
            onClick={() => setMenuOpen((o) => !o)}
            title="Quality"
          >
            ⚙ {activeLabel}
          </button>

          {menuOpen && (
            <div className="quality-menu__list">
              <button
                className={currentLevel === -1 ? 'active' : ''}
                onClick={() => switchQuality(-1)}
              >
                Auto
              </button>
              {levels.map((lvl, i) => (
                <button
                  key={i}
                  className={currentLevel === i ? 'active' : ''}
                  onClick={() => switchQuality(i)}
                >
                  {lvl.height}p
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}