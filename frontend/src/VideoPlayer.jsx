import React from 'react';
import videojs from 'video.js';
import 'video.js/dist/video-js.css';
import 'videojs-contrib-quality-levels';
import 'videojs-hls-quality-selector';

export const VideoPlayer = (props) => {
  const videoRef = React.useRef(null);
  const playerRef = React.useRef(null);
  const {options, onReady} = props;

  React.useEffect(() => {

    // Make sure Video.js player is only initialized once
    if (!playerRef.current) {
      const videoElement = document.createElement("video-js");
      videoElement.classList.add('vjs-big-play-centered');
      videoRef.current.appendChild(videoElement);

      const player = playerRef.current = videojs(videoElement, options, () => {
        videojs.log('player is ready');
        onReady && onReady(player);

        // Wait for hls.js to finish parsing the master playlist and populate
        // quality levels before initialising the selector — avoids the bug
        // where only the first variant (480p) appears in the menu.
        const qualityLevels = player.qualityLevels();

        const initSelector = () => {
          videojs.log(`[QualitySelector] ${qualityLevels.length} level(s) detected — initialising selector`);
          player.hlsQualitySelector({ displayCurrentQuality: true });
        };

        if (qualityLevels.length > 0) {
          // Levels already loaded (cached / fast connection)
          initSelector();
        } else {
          // Listen for the first quality level to be added, then init
          qualityLevels.on('addqualitylevel', function onAdd() {
            qualityLevels.off('addqualitylevel', onAdd);
            initSelector();
          });
        }
      });

    } else {
      const player = playerRef.current;
      player.autoplay(options.autoplay);
      player.src(options.sources);
    }
  }, [options, videoRef]);

  // Dispose the Video.js player when the functional component unmounts
  React.useEffect(() => {
    const player = playerRef.current;

    return () => {
      if (player && !player.isDisposed()) {
        player.dispose();
        playerRef.current = null;
      }
    };
  }, [playerRef]);

  return (
    <div data-vjs-player>
      <div ref={videoRef} />
    </div>
  );
}

export default VideoPlayer;