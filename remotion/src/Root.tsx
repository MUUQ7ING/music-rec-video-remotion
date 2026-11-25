import React from 'react';
import { Composition, type CalculateMetadataFunction } from 'remotion';
import defaultPlaylist from '../../playlist.json';
import { PlaylistVideo } from './components/PlaylistVideo';
import type { PlaylistConfig, PlaylistVideoProps } from './types';
import { expandPlaylistSegments } from './utils/segments';

const calculateMetadata: CalculateMetadataFunction<PlaylistVideoProps> = ({
  props,
}) => {
  const pl = props.playlist;
  const fps = pl.fps || 60;
  const width = pl.resolution?.width || 1920;
  const height = pl.resolution?.height || 1080;

  const segments = expandPlaylistSegments(pl, fps);
  const segFrames = segments.reduce((sum, s) => sum + s.durationFrames, 0);
  const segOverlap = segments.reduce((sum, s) => sum + s.transitionAfterFrames, 0);
  const totalFrames = Math.max(fps, segFrames - segOverlap);

  return {
    durationInFrames: totalFrames,
    fps,
    width,
    height,
  };
};

export const RemotionRoot: React.FC = () => {
  return (
    <Composition
      id="MusicRecVideo"
      component={PlaylistVideo}
      durationInFrames={60 * 30}
      fps={60}
      width={1920}
      height={1080}
      calculateMetadata={calculateMetadata}
      defaultProps={{
        playlist: defaultPlaylist as PlaylistConfig,
      }}
    />
  );
};
