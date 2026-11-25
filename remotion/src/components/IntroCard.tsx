import React, { useMemo } from 'react';
import {
  AbsoluteFill,
  Img,
  interpolate,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';
import type { IntroConfig } from '../types';
import { computeIntroTiming, resolveAssetUrl } from '../utils/time';

interface IntroCardProps {
  intro: IntroConfig;
  introFrames: number;
  mediaBaseUrl?: string;
}

const SERIF_FONT =
  '"Noto Serif SC", "Source Han Serif SC", "Songti SC", "SimSun", serif';

export const IntroCard: React.FC<IntroCardProps> = ({
  intro,
  introFrames,
  mediaBaseUrl,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const { pages, pageStarts, pageLengths } = useMemo(() => {
    const { pages: pList, pageWeights } = computeIntroTiming(
      intro.text,
      intro.auto_duration,
      intro.duration,
    );
    const weightSum = pageWeights.reduce((s, w) => s + w, 0) || 1;
    const starts: number[] = [];
    const lengths: number[] = [];
    let acc = 0;
    for (let i = 0; i < pList.length; i++) {
      const len =
        i === pList.length - 1
          ? Math.max(1, introFrames - acc)
          : Math.max(1, Math.round((pageWeights[i] / weightSum) * introFrames));
      starts.push(acc);
      lengths.push(len);
      acc += len;
    }
    return { pages: pList, pageStarts: starts, pageLengths: lengths };
  }, [intro.text, intro.auto_duration, intro.duration, introFrames]);

  const exitFadeFrames = Math.min(Math.round(0.6 * fps), Math.floor(introFrames / 3));
  if (frame >= introFrames) {
    return null;
  }

  const overlayOpacity = interpolate(
    frame,
    [introFrames - exitFadeFrames, introFrames],
    [1, 0],
    { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' },
  );

  let currentPageIdx = pages.length - 1;
  for (let i = 0; i < pages.length; i++) {
    if (frame < pageStarts[i] + pageLengths[i]) {
      currentPageIdx = i;
      break;
    }
  }
  const pageFrames = pageLengths[currentPageIdx];
  const localFrame = frame - pageStarts[currentPageIdx];

  const fadeInFrames = Math.min(Math.round(0.75 * fps), Math.floor(pageFrames / 3));
  const fadeOutFrames = Math.min(Math.round(0.65 * fps), Math.floor(pageFrames / 3));

  const textOpacity = interpolate(
    localFrame,
    [0, fadeInFrames, pageFrames - fadeOutFrames, pageFrames],
    [0, 1, 1, 0],
    { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' },
  );

  const translateY = interpolate(
    localFrame,
    [0, fadeInFrames, pageFrames - fadeOutFrames, pageFrames],
    [18, 0, 0, -10],
    { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' },
  );

  const bgImageUrl = resolveAssetUrl(intro.bg_image, mediaBaseUrl);

  return (
    <AbsoluteFill style={{ opacity: overlayOpacity, pointerEvents: 'none' }}>
      {/* Background treatment over the continuously playing first song */}
      {intro.bg_mode === 'blur_first_song' ? (
        <AbsoluteFill
          style={{
            backgroundColor: 'rgba(0, 0, 0, 0.48)',
            backdropFilter: 'blur(32px)',
            WebkitBackdropFilter: 'blur(32px)',
          }}
        />
      ) : intro.bg_mode === 'image' && bgImageUrl ? (
        <AbsoluteFill style={{ filter: 'blur(14px) brightness(0.45)' }}>
          <Img
            src={bgImageUrl}
            style={{ width: '100%', height: '100%', objectFit: 'cover' }}
          />
        </AbsoluteFill>
      ) : (
        <AbsoluteFill style={{ backgroundColor: '#000000' }} />
      )}

      {/* Centered sequential intro text */}
      <AbsoluteFill
        style={{
          justifyContent: 'center',
          alignItems: 'center',
          padding: '0 180px',
          opacity: textOpacity,
          transform: `translateY(${translateY}px)`,
        }}
      >
        <div
          style={{
            fontFamily: SERIF_FONT,
            fontSize: 46,
            lineHeight: 1.8,
            fontWeight: 600,
            color: '#ffffff',
            textAlign: 'center',
            whiteSpace: 'pre-wrap',
            letterSpacing: '0.06em',
            textShadow: '0 4px 24px rgba(0, 0, 0, 0.85)',
          }}
        >
          {pages[currentPageIdx]}
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
