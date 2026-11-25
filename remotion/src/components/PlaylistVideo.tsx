import React from 'react';
import { AbsoluteFill, useVideoConfig } from 'remotion';
import {
  TransitionSeries,
  type TransitionPresentation,
  linearTiming,
} from '@remotion/transitions';
import { fade } from '@remotion/transitions/fade';
import { flip } from '@remotion/transitions/flip';
import { slide } from '@remotion/transitions/slide';
import { wipe } from '@remotion/transitions/wipe';
import type { PlaylistVideoProps } from '../types';
import {
  cssBlurSlide,
  cssCrossZoom,
  cssDipToBlack,
  cssFlashWhite,
  cssZoomBlur,
} from '../utils/customTransitions';
import { expandPlaylistSegments } from '../utils/segments';
import { SongSegment } from './SongSegment';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function resolvePresentation(style: string): TransitionPresentation<any> {
  switch (style) {
    case 'blur_slide':
      return cssBlurSlide();
    case 'zoom_blur':
      return cssZoomBlur();
    case 'cross_zoom':
      return cssCrossZoom();
    case 'dip_to_black':
      return cssDipToBlack();
    case 'flash_white':
      return cssFlashWhite();
    case 'slide':
      return slide({ direction: 'from-right' });
    case 'wipe':
      return wipe({ direction: 'from-left' });
    case 'flip':
      return flip({ direction: 'from-right' });
    case 'cross_dissolve':
    default:
      return fade();
  }
}

export const PlaylistVideo: React.FC<PlaylistVideoProps> = ({
  playlist,
  mediaBaseUrl,
}) => {
  const { fps } = useVideoConfig();
  const intro = playlist.intro;
  const hasIntro = Boolean(intro?.enabled && intro?.text?.trim());
  const segments = expandPlaylistSegments(playlist, fps);

  return (
    <AbsoluteFill style={{ backgroundColor: '#000000' }}>
      <TransitionSeries>
        {segments.map((seg, flatIdx) => (
          <React.Fragment
            key={`${seg.song.netease_id || seg.song.title}-${seg.songIndex}-${seg.clipIndex}`}
          >
            <TransitionSeries.Sequence durationInFrames={seg.durationFrames}>
              <SongSegment
                song={seg.song}
                index={seg.songIndex}
                clipOverride={seg.clip}
                intro={flatIdx === 0 && hasIntro ? intro : undefined}
                audioInFrames={seg.audioInFrames}
                audioOutFrames={seg.audioOutFrames}
                mediaBaseUrl={mediaBaseUrl}
              />
            </TransitionSeries.Sequence>
            {seg.transitionAfterFrames > 0 ? (
              <TransitionSeries.Transition
                presentation={resolvePresentation(seg.transitionAfterStyle)}
                timing={linearTiming({
                  durationInFrames: seg.transitionAfterFrames,
                })}
              />
            ) : null}
          </React.Fragment>
        ))}
      </TransitionSeries>
    </AbsoluteFill>
  );
};
