import './App.css'
import { useRef } from 'react'
import VideoPlayer from './VideoPlayer.jsx'


function App() {

  const playerRef= useRef(null)
  const videoLink= "http://localhost:3000/output/a1378075-31a2-4f96-8fdb-8dd80e71d720/index.m3u8"

  const handlePlayerReady = (player) => {
    playerRef.current = player;
  };
  const VideoPlayerOptions= {
    controls: true,
    autoplay: true,
    sources: [
      {
        src: videoLink,
        type: "application/x-mpegURL",
      },
    ],
  };
  return (
    <>
     <VideoPlayer options={VideoPlayerOptions} onReady={handlePlayerReady} />
    </>
  )
}

export default App
