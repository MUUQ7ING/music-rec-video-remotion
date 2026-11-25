import React from 'react';
import { AbsoluteFill, useVideoConfig } from 'remotion';
import {
  TransitionSeries,
  type TransitionPresentation,
  linearTiming,
  springTiming,
} from '@remotion/transitions';
import { fade } from '@remotion/transitions/fade';
import { flip } from '@remotion/transitions/flip';
import type { PlaylistVideoProps } from '../types';
import {
  cssBlurSlide,
  cssCrossZoom,
  cssCurtainSplit,
  cssDipToBlack,
  cssFlashWhite,
  cssWhipPan,
  cssZoomBlur,
} from '../utils/customTransitions';
import { expandPlaylistSegments } from '../utils/segments';
import { LightLeakOverlay } from './LightLeakOverlay';
import { SongSegment } from './SongSegment';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function resolvePresentation(style: string): TransitionPresentation<any> {
  switch (style) {
    case 'whip_pan':
      return cssWhipPan();
    case 'curtain_split':
      return cssCurtainSplit();
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
    case 'flip':
      return flip({ direction: 'from-right' });
    case 'cross_dissolve':
    default:
      return fade();
  }
}

function resolveTiming(style: string, durationInFrames: number) {
  const springStyles = new Set([
    'whip_pan',
    'curtain_split',
    'blur_slide',
    'flip',
  ]);
  if (springStyles.has(style)) {
    return springTiming({
      config: { damping: 200 },
      durationInFrames,
    });
  }
  return linearTiming({ durationInFrames });
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
    <AbsoluteFill
      style={{
        backgroundColor: '#000000',
        translate: '1px 0px'
      }}
    >
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
                timing={resolveTiming(
                  seg.transitionAfterStyle,
                  seg.transitionAfterFrames,
                )}
              />
            ) : seg.overlayAfterFrames > 0 ? (
              <TransitionSeries.Overlay durationInFrames={seg.overlayAfterFrames}>
                <LightLeakOverlay
                  seed={seg.overlayAfterStyle === 'light_leak_neon' ? 5 : 2}
                  hueShift={seg.overlayAfterStyle === 'light_leak_neon' ? 240 : 0}
                />
              </TransitionSeries.Overlay>
            ) : null}
          </React.Fragment>
        ))}
      </TransitionSeries>
    </AbsoluteFill>
  );
};
