import React from 'react';
import { AbsoluteFill, interpolate } from 'remotion';
import type { TransitionPresentation, TransitionPresentationComponentProps } from '@remotion/transitions';

type EmptyProps = Record<string, never>;

/** Pure-CSS Blur Slide (no experimental html-in-canvas required) */
const BlurSlideComponent: React.FC<TransitionPresentationComponentProps<EmptyProps>> = ({
  children,
  presentationDirection,
  presentationProgress,
}) => {
  const isEntering = presentationDirection === 'entering';
  const x = isEntering
    ? interpolate(presentationProgress, [0, 1], [120, 0])
    : interpolate(presentationProgress, [0, 1], [0, -120]);
  const blur = isEntering
    ? interpolate(presentationProgress, [0, 0.7, 1], [18, 4, 0])
    : interpolate(presentationProgress, [0, 0.3, 1], [0, 4, 18]);
  const opacity = isEntering
    ? interpolate(presentationProgress, [0, 0.65], [0, 1], { extrapolateRight: 'clamp' })
    : interpolate(presentationProgress, [0.35, 1], [1, 0], { extrapolateLeft: 'clamp' });

  return (
    <AbsoluteFill
      style={{
        transform: `translateX(${x}px)`,
        filter: blur > 0.2 ? `blur(${blur}px)` : undefined,
        opacity,
      }}
    >
      {children}
    </AbsoluteFill>
  );
};

export function cssBlurSlide(): TransitionPresentation<EmptyProps> {
  return { component: BlurSlideComponent, props: {} };
}

/** Pure-CSS Zoom Blur */
const ZoomBlurComponent: React.FC<TransitionPresentationComponentProps<EmptyProps>> = ({
  children,
  presentationDirection,
  presentationProgress,
}) => {
  const isEntering = presentationDirection === 'entering';
  const scale = isEntering
    ? interpolate(presentationProgress, [0, 1], [1.22, 1])
    : interpolate(presentationProgress, [0, 1], [1, 0.88]);
  const blur = isEntering
    ? interpolate(presentationProgress, [0, 0.75, 1], [20, 4, 0])
    : interpolate(presentationProgress, [0, 0.25, 1], [0, 6, 20]);
  const opacity = isEntering
    ? interpolate(presentationProgress, [0, 0.6], [0, 1], { extrapolateRight: 'clamp' })
    : interpolate(presentationProgress, [0.4, 1], [1, 0], { extrapolateLeft: 'clamp' });

  return (
    <AbsoluteFill
      style={{
        transform: `scale(${scale})`,
        filter: blur > 0.2 ? `blur(${blur}px)` : undefined,
        opacity,
      }}
    >
      {children}
    </AbsoluteFill>
  );
}

export function cssZoomBlur(): TransitionPresentation<EmptyProps> {
  return { component: ZoomBlurComponent, props: {} };
}

/** Pure-CSS Cross Zoom */
const CrossZoomComponent: React.FC<TransitionPresentationComponentProps<EmptyProps>> = ({
  children,
  presentationDirection,
  presentationProgress,
}) => {
  const isEntering = presentationDirection === 'entering';
  const scale = isEntering
    ? interpolate(presentationProgress, [0, 1], [0.86, 1])
    : interpolate(presentationProgress, [0, 1], [1, 1.18]);
  const opacity = isEntering
    ? interpolate(presentationProgress, [0.15, 0.85], [0, 1], {
        extrapolateLeft: 'clamp',
        extrapolateRight: 'clamp',
      })
    : interpolate(presentationProgress, [0.15, 0.85], [1, 0], {
        extrapolateLeft: 'clamp',
        extrapolateRight: 'clamp',
      });

  return (
    <AbsoluteFill style={{ transform: `scale(${scale})`, opacity }}>
      {children}
    </AbsoluteFill>
  );
}

export function cssCrossZoom(): TransitionPresentation<EmptyProps> {
  return { component: CrossZoomComponent, props: {} };
}

/** Pure-CSS Dip to Black */
const DipToBlackComponent: React.FC<TransitionPresentationComponentProps<EmptyProps>> = ({
  children,
  presentationDirection,
  presentationProgress,
}) => {
  const isEntering = presentationDirection === 'entering';
  const opacity = isEntering
    ? interpolate(presentationProgress, [0.45, 1], [0, 1], {
        extrapolateLeft: 'clamp',
        extrapolateRight: 'clamp',
      })
    : interpolate(presentationProgress, [0, 0.55], [1, 0], {
        extrapolateLeft: 'clamp',
        extrapolateRight: 'clamp',
      });

  return (
    <AbsoluteFill style={{ backgroundColor: '#000000' }}>
      <AbsoluteFill style={{ opacity }}>{children}</AbsoluteFill>
    </AbsoluteFill>
  );
};

export function cssDipToBlack(): TransitionPresentation<EmptyProps> {
  return { component: DipToBlackComponent, props: {} };
}

/** Pure-CSS Flash White (great for energetic EDM/rock drops) */
const FlashWhiteComponent: React.FC<TransitionPresentationComponentProps<EmptyProps>> = ({
  children,
  presentationDirection,
  presentationProgress,
}) => {
  const isEntering = presentationDirection === 'entering';
  const contentOpacity = isEntering
    ? interpolate(presentationProgress, [0.4, 0.6], [0, 1], {
        extrapolateLeft: 'clamp',
        extrapolateRight: 'clamp',
      })
    : interpolate(presentationProgress, [0.4, 0.6], [1, 0], {
        extrapolateLeft: 'clamp',
        extrapolateRight: 'clamp',
      });
  const flashOpacity = interpolate(
    presentationProgress,
    [0, 0.45, 0.55, 1],
    [0, 0.9, 0.9, 0],
    { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' },
  );

  return (
    <AbsoluteFill>
      <AbsoluteFill style={{ opacity: contentOpacity }}>{children}</AbsoluteFill>
      {isEntering ? (
        <AbsoluteFill
          style={{
            backgroundColor: '#ffffff',
            opacity: flashOpacity,
            pointerEvents: 'none',
          }}
        />
      ) : null}
    </AbsoluteFill>
  );
};

export function cssFlashWhite(): TransitionPresentation<EmptyProps> {
  return { component: FlashWhiteComponent, props: {} };
}

/** High-speed camera Whip Pan (horizontal whip with mid-point blur & subtle scale dip) */
const WhipPanComponent: React.FC<TransitionPresentationComponentProps<EmptyProps>> = ({
  children,
  presentationDirection,
  presentationProgress,
}) => {
  const isEntering = presentationDirection === 'entering';
  const tx = isEntering
    ? interpolate(presentationProgress, [0, 1], [100, 0])
    : interpolate(presentationProgress, [0, 1], [0, -100]);
  const midIntensity = Math.sin(presentationProgress * Math.PI);
  const blur = midIntensity * 16;
  const scale = 1 - midIntensity * 0.06;

  return (
    <AbsoluteFill
      style={{
        transform: `translate3d(${tx}%, 0, 0) scale(${scale})`,
        filter: blur > 0.3 ? `blur(${blur}px)` : undefined,
        willChange: 'transform',
      }}
    >
      {children}
    </AbsoluteFill>
  );
};

export function cssWhipPan(): TransitionPresentation<EmptyProps> {
  return { component: WhipPanComponent, props: {} };
}

/** Cinematic Curtain Split expanding from center horizontally */
const CurtainSplitComponent: React.FC<TransitionPresentationComponentProps<EmptyProps>> = ({
  children,
  presentationDirection,
  presentationProgress,
}) => {
  if (presentationDirection === 'exiting') {
    const brightness = interpolate(presentationProgress, [0, 1], [1, 0.7]);
    return (
      <AbsoluteFill style={{ filter: `brightness(${brightness})` }}>
        {children}
      </AbsoluteFill>
    );
  }

  const insetX = interpolate(presentationProgress, [0, 1], [50, 0]);
  const scale = interpolate(presentationProgress, [0, 1], [1.05, 1]);

  return (
    <AbsoluteFill
      style={{
        clipPath: `inset(0% ${insetX}% 0% ${insetX}%)`,
        transform: `scale(${scale})`,
        willChange: 'clip-path, transform',
      }}
    >
      {children}
    </AbsoluteFill>
  );
};

export function cssCurtainSplit(): TransitionPresentation<EmptyProps> {
  return { component: CurtainSplitComponent, props: {} };
}
