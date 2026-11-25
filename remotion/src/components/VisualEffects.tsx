import React from 'react';
import {
  AbsoluteFill,
  Easing,
  Img,
  interpolate,
  random,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';
import { useAudioData, visualizeAudio } from '@remotion/media-utils';

export type VisualEffectType =
  | 'auto'
  | 'none'
  | 'beat_pulse'
  | 'ken_burns'
  | 'glitch'
  | 'vinyl_spin';

interface VisualEffectsProps {
  effect?: string;
  audioSrc: string;
  startSec: number;
  coverUrl?: string;
  children: React.ReactNode;
}

const AudioDrivenEffect: React.FC<{
  mode: 'beat_pulse' | 'glitch';
  audioSrc: string;
  startSec: number;
  children: React.ReactNode;
}> = ({ mode, audioSrc, startSec, children }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const audioData = useAudioData(audioSrc);

  let bassEnergy = 0;
  if (audioData) {
    const audioFrame = Math.max(0, frame + Math.round(startSec * fps));
    const freqs = visualizeAudio({
      fps,
      frame: audioFrame,
      audioData,
      numberOfSamples: 64,
      smoothing: true,
    });
    const bassSlice = freqs.slice(0, 4);
    const avg =
      bassSlice.reduce((sum, v) => sum + v, 0) / Math.max(1, bassSlice.length);
    bassEnergy = Math.min(1, Math.pow(avg * 1.8, 0.75));
  }

  if (mode === 'beat_pulse') {
    const scale = 1.02 + bassEnergy * 0.065;
    const brightness = 1 + bassEnergy * 0.1;
    return (
      <AbsoluteFill
        style={{
          overflow: 'hidden',
          backgroundColor: '#000',
        }}
      >
        <AbsoluteFill
          style={{
            transform: `scale(${scale})`,
            filter: `brightness(${brightness})`,
            transformOrigin: 'center center',
          }}
        >
          {children}
        </AbsoluteFill>
      </AbsoluteFill>
    );
  }

  // Glitch mode: NEVER duplicate `children` (<OffthreadVideo>), which would spawn extra
  // audio/video decoders mid-playback and cause audio stutter. Apply CSS transforms &
  // lightweight overlay bars on top of the single video layer instead.
  const beatHit = bassEnergy > 0.65;
  const periodicHit = frame % 90 >= 84 && frame % 90 <= 87;
  const isGlitching = beatHit || periodicHit;

  const jitterX = isGlitching ? (random(`gx-${frame}`) - 0.5) * 16 : 0;
  const jitterY = isGlitching ? (random(`gy-${frame}`) - 0.5) * 6 : 0;
  const skewX = isGlitching ? (random(`sk-${frame}`) - 0.5) * 2.5 : 0;
  const barTop1 = Math.round(random(`b1-${frame}`) * 75);
  const barTop2 = Math.round(random(`b2-${frame}`) * 80);

  return (
    <AbsoluteFill style={{ overflow: 'hidden', backgroundColor: '#000' }}>
      <AbsoluteFill
        style={{
          transform: `scale(${1.02 + bassEnergy * 0.025}) translate(${jitterX}px, ${jitterY}px) skewX(${skewX}deg)`,
          filter: isGlitching
            ? 'contrast(1.18) saturate(1.45) drop-shadow(-4px 0 0 rgba(255,0,85,0.55)) drop-shadow(4px 0 0 rgba(0,240,255,0.55))'
            : undefined,
          transformOrigin: 'center center',
        }}
      >
        {children}
      </AbsoluteFill>

      {isGlitching ? (
        <>
          <div
            style={{
              position: 'absolute',
              left: 0,
              right: 0,
              top: `${barTop1}%`,
              height: 14,
              backgroundColor: 'rgba(0, 240, 255, 0.18)',
              mixBlendMode: 'screen',
              pointerEvents: 'none',
            }}
          />
          <div
            style={{
              position: 'absolute',
              left: 0,
              right: 0,
              top: `${barTop2}%`,
              height: 8,
              backgroundColor: 'rgba(255, 0, 100, 0.2)',
              mixBlendMode: 'screen',
              pointerEvents: 'none',
            }}
          />
          <AbsoluteFill
            style={{
              background:
                'repeating-linear-gradient(0deg, rgba(255,255,255,0.05) 0px, rgba(255,255,255,0.05) 1px, transparent 1px, transparent 5px)',
              pointerEvents: 'none',
            }}
          />
        </>
      ) : null}
    </AbsoluteFill>
  );
};

export const VisualEffects: React.FC<VisualEffectsProps> = ({
  effect = 'auto',
  audioSrc,
  startSec,
  coverUrl,
  children,
}) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();

  const resolvedEffect: VisualEffectType =
    effect && effect !== 'auto'
      ? (effect as VisualEffectType)
      : 'none';

  if ((resolvedEffect === 'beat_pulse' || resolvedEffect === 'glitch') && audioSrc) {
    return (
      <AudioDrivenEffect
        mode={resolvedEffect}
        audioSrc={audioSrc}
        startSec={startSec}
      >
        {children}
      </AudioDrivenEffect>
    );
  }

  if (resolvedEffect === 'ken_burns') {
    const progress = interpolate(frame, [0, Math.max(1, durationInFrames - 1)], [0, 1], {
      easing: Easing.inOut(Easing.sin),
      extrapolateLeft: 'clamp',
      extrapolateRight: 'clamp',
    });
    // Use translate3d + willChange to force GPU sub-pixel compositing and prevent 1px snapping
    const scale = interpolate(progress, [0, 1], [1.02, 1.14]);
    const tx = interpolate(progress, [0, 1], [14, -14]);
    const ty = interpolate(progress, [0, 1], [8, -8]);
    return (
      <AbsoluteFill style={{ overflow: 'hidden', backgroundColor: '#000' }}>
        <AbsoluteFill
          style={{
            transform: `translate3d(${tx.toFixed(3)}px, ${ty.toFixed(3)}px, 0) scale(${scale.toFixed(5)})`,
            transformOrigin: 'center center',
            willChange: 'transform',
            backfaceVisibility: 'hidden',
          }}
        >
          {children}
        </AbsoluteFill>
      </AbsoluteFill>
    );
  }

  if (resolvedEffect === 'vinyl_spin' && coverUrl) {
    const deg = (frame / fps) * 24;
    return (
      <AbsoluteFill style={{ backgroundColor: '#09090b', overflow: 'hidden' }}>
        <AbsoluteFill
          style={{
            filter: 'blur(36px) brightness(0.38)',
            transform: 'scale(1.12)',
          }}
        >
          {children}
        </AbsoluteFill>

        <AbsoluteFill
          style={{
            justifyContent: 'center',
            alignItems: 'center',
            paddingBottom: 120,
          }}
        >
          <div
            style={{
              width: 460,
              height: 460,
              borderRadius: '50%',
              padding: 26,
              background:
                'radial-gradient(circle, #18181b 0%, #09090b 65%, #27272a 100%)',
              boxShadow: '0 24px 70px rgba(0, 0, 0, 0.75)',
              transform: `rotate(${deg}deg)`,
              display: 'flex',
              justifyContent: 'center',
              alignItems: 'center',
            }}
          >
            <Img
              src={coverUrl}
              style={{
                width: '100%',
                height: '100%',
                borderRadius: '50%',
                objectFit: 'cover',
                border: '4px solid rgba(255, 255, 255, 0.14)',
              }}
            />
          </div>
        </AbsoluteFill>
      </AbsoluteFill>
    );
  }

  return <AbsoluteFill>{children}</AbsoluteFill>;
};
