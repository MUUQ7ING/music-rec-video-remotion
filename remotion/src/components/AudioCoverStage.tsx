import React, { useMemo } from 'react';
import {
  AbsoluteFill,
  Img,
  random,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';
import { useWindowedAudioData, visualizeAudio } from '@remotion/media-utils';

interface AudioCoverStageProps {
  audioSrc?: string;
  startSec: number;
  coverUrl?: string;
  coverBrightness?: number;
  animateBeat?: boolean;
  float3d?: boolean;
  showParticles?: boolean;
  children?: React.ReactNode;
}

interface ParticleSpec {
  id: number;
  xPct: number;
  yOffset: number;
  speed: number;
  driftAmp: number;
  driftFreq: number;
  size: number;
  isBokeh: boolean;
  baseOpacity: number;
  hueShift: number;
}

const PARTICLE_COUNT = 36;
const UNSUPPORTED_AUDIO_EXT_RE = /\.(flac|ape|wma|alac)(\?.*)?$/i;

export const canDecodeAudioUrl = (src?: string): boolean => {
  if (!src) return false;
  const trimmed = src.trim();
  return trimmed.length > 0 && !UNSUPPORTED_AUDIO_EXT_RE.test(trimmed);
};

interface StageRenderProps extends AudioCoverStageProps {
  bassEnergy: number;
  midEnergy: number;
  highEnergy: number;
}

const AudioCoverStageBase: React.FC<StageRenderProps> = ({
  coverUrl = '',
  coverBrightness = 0.52,
  animateBeat = false,
  float3d = false,
  showParticles = true,
  bassEnergy,
  midEnergy,
  highEnergy,
  children,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = frame / fps;

  const particles = useMemo<ParticleSpec[]>(() => {
    return Array.from({ length: PARTICLE_COUNT }, (_, i) => {
      const isBokeh = i < 14;
      return {
        id: i,
        xPct: random(`acs-x-${i}`) * 100,
        yOffset: random(`acs-y-${i}`) * 110,
        speed: (isBokeh ? 2.2 : 4.2) + random(`acs-spd-${i}`) * (isBokeh ? 2.6 : 4.5),
        driftAmp: (isBokeh ? 26 : 16) + random(`acs-amp-${i}`) * 24,
        driftFreq: 0.25 + random(`acs-frq-${i}`) * 0.45,
        size: isBokeh
          ? 28 + random(`acs-sz-${i}`) * 64
          : 3 + random(`acs-sz-${i}`) * 6,
        isBokeh,
        baseOpacity: isBokeh
          ? 0.08 + random(`acs-op-${i}`) * 0.14
          : 0.24 + random(`acs-op-${i}`) * 0.36,
        hueShift: random(`acs-hue-${i}`),
      };
    });
  }, []);

  // Keep backdrop & cover static by default; pulse only when animateBeat is active
  const bgScale = animateBeat ? 1.14 + bassEnergy * 0.065 : 1.14;
  const bgBrightness = animateBeat ? 0.36 + bassEnergy * 0.14 : 0.36;

  const coverScale = animateBeat ? 1 + bassEnergy * 0.048 : 1;
  const auraScale = animateBeat ? 1 + bassEnergy * 0.18 + midEnergy * 0.06 : 1;
  const auraOpacity = animateBeat ? 0.28 + bassEnergy * 0.42 : 0.22;

  const floatY = float3d ? Math.sin(t * 1.1) * 10 : 0;
  const rotX = float3d ? Math.cos(t * 0.55) * 6 : 0;
  const rotY = float3d ? Math.sin(t * 0.7) * 9 : 0;

  const coverSize = 605;
  const coverCenterY = 508;

  const coverTransform = float3d
    ? `translate3d(-50%, calc(-50% + ${floatY.toFixed(2)}px), 0) perspective(1200px) rotateX(${rotX.toFixed(2)}deg) rotateY(${rotY.toFixed(2)}deg) scale(${coverScale.toFixed(4)})`
    : `translate3d(-50%, -50%, 0) scale(${coverScale.toFixed(4)})`;

  return (
    <AbsoluteFill style={{ backgroundColor: '#07070a', overflow: 'hidden' }}>
      {/* Keep children mounted at opacity 0 so video audio keeps playing */}
      {children ? (
        <AbsoluteFill style={{ opacity: 0, pointerEvents: 'none' }}>
          {children}
        </AbsoluteFill>
      ) : null}

      {/* Layer 1: Full-Screen Blurred Album Cover Backdrop */}
      {coverUrl ? (
        <AbsoluteFill
          style={{
            transform: `scale(${bgScale.toFixed(4)})`,
            filter: `blur(56px) brightness(${bgBrightness.toFixed(3)}) saturate(1.42)`,
            transformOrigin: 'center center',
            willChange: 'transform, filter',
          }}
        >
          <Img
            src={coverUrl}
            style={{ width: '100%', height: '100%', objectFit: 'cover' }}
          />
        </AbsoluteFill>
      ) : null}

      {/* Deep ambient vignette so HUD text stays legible */}
      <AbsoluteFill
        style={{
          background:
            'radial-gradient(circle at 50% 42%, rgba(10, 12, 20, 0.12) 0%, rgba(5, 6, 10, 0.62) 68%, rgba(0, 0, 0, 0.84) 100%)',
          pointerEvents: 'none',
        }}
      />

      {/* Layer 2: Smoothly Drifting Bokeh & Dust Particles */}
      {showParticles ? (
        <AbsoluteFill style={{ pointerEvents: 'none' }}>
          {particles.map((p) => {
            const rawY = (p.yOffset - t * p.speed) % 112;
            const yPct = rawY < -12 ? rawY + 112 : rawY;
            const xDriftPx = Math.sin(t * p.driftFreq + p.id) * p.driftAmp;
            const shimmer = p.isBokeh ? midEnergy * 0.2 : highEnergy * 0.25;
            const opacity = Math.min(0.8, p.baseOpacity * (0.9 + shimmer));
            const warmTint =
              p.hueShift > 0.5
                ? `rgba(255, 226, 185, ${opacity.toFixed(3)})`
                : `rgba(185, 220, 255, ${opacity.toFixed(3)})`;

            return (
              <div
                key={p.id}
                style={{
                  position: 'absolute',
                  left: `${p.xPct.toFixed(2)}%`,
                  top: `${yPct.toFixed(2)}%`,
                  width: p.size,
                  height: p.size,
                  borderRadius: '50%',
                  transform: `translate3d(${xDriftPx.toFixed(1)}px, 0, 0)`,
                  background: p.isBokeh
                    ? `radial-gradient(circle, ${warmTint} 0%, rgba(255, 255, 255, 0) 70%)`
                    : warmTint,
                  filter: p.isBokeh ? 'blur(4px)' : undefined,
                  boxShadow: p.isBokeh ? undefined : `0 0 6px ${warmTint}`,
                }}
              />
            );
          })}
        </AbsoluteFill>
      ) : null}

      {/* Layer 3: Radial Halo */}
      <div
        style={{
          position: 'absolute',
          left: '50%',
          top: coverCenterY,
          width: coverSize + 190,
          height: coverSize + 190,
          borderRadius: '50%',
          transform: `translate3d(-50%, -50%, 0) scale(${auraScale.toFixed(4)})`,
          background:
            'radial-gradient(circle, rgba(255, 255, 255, 0.22) 0%, rgba(160, 200, 255, 0.14) 45%, rgba(0, 0, 0, 0) 72%)',
          opacity: auraOpacity,
          filter: 'blur(22px)',
          pointerEvents: 'none',
        }}
      />

      {/* Layer 4: Centered Album Cover Card (605x605) */}
      {coverUrl ? (
        <div
          style={{
            position: 'absolute',
            left: '50%',
            top: coverCenterY,
            width: coverSize,
            height: coverSize,
            borderRadius: 24,
            overflow: 'hidden',
            transform: coverTransform,
            filter: `brightness(${coverBrightness}) saturate(1.08)`,
            boxShadow: `0 28px 80px rgba(0, 0, 0, 0.78), 0 0 ${Math.round(18 + (animateBeat ? bassEnergy * 38 : 0))}px rgba(255, 255, 255, ${(0.12 + (animateBeat ? bassEnergy * 0.22 : 0)).toFixed(2)}), 0 0 0 1px rgba(255, 255, 255, 0.22)`,
            pointerEvents: 'none',
            willChange: 'transform',
          }}
        >
          <Img
            src={coverUrl}
            style={{ width: '100%', height: '100%', objectFit: 'cover' }}
          />
        </div>
      ) : null}
    </AbsoluteFill>
  );
};

const AudioCoverStageWithAudio: React.FC<AudioCoverStageProps> = (props) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const audioFrame = Math.max(0, frame + Math.round(props.startSec * fps));

  const { audioData, dataOffsetInSeconds } = useWindowedAudioData({
    src: props.audioSrc || '',
    frame: audioFrame,
    fps,
    windowInSeconds: 30,
  });

  let bassEnergy = 0;
  let midEnergy = 0;
  let highEnergy = 0;

  if (audioData) {
    const frequencies = visualizeAudio({
      fps,
      frame: audioFrame,
      audioData,
      numberOfSamples: 128,
      optimizeFor: 'speed',
      smoothing: true,
      dataOffsetInSeconds,
    });

    const avgRange = (from: number, to: number) => {
      const slice = frequencies.slice(from, to);
      if (slice.length === 0) return 0;
      return slice.reduce((acc, v) => acc + v, 0) / slice.length;
    };

    bassEnergy = Math.min(1, Math.pow(avgRange(0, 6) * 1.9, 0.72));
    midEnergy = Math.min(1, Math.pow(avgRange(6, 28) * 2.4, 0.72));
    highEnergy = Math.min(1, Math.pow(avgRange(28, 72) * 3.2, 0.75));
  }

  return (
    <AudioCoverStageBase
      {...props}
      bassEnergy={bassEnergy}
      midEnergy={midEnergy}
      highEnergy={highEnergy}
    />
  );
};

export const AudioCoverStage: React.FC<AudioCoverStageProps> = (props) => {
  const shouldReadAudio = Boolean(
    canDecodeAudioUrl(props.audioSrc) && (props.animateBeat || props.showParticles)
  );
  if (shouldReadAudio) {
    return <AudioCoverStageWithAudio {...props} />;
  }
  return (
    <AudioCoverStageBase
      {...props}
      bassEnergy={0}
      midEnergy={0}
      highEnergy={0}
    />
  );
};
