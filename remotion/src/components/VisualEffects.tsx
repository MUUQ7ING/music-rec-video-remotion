import React, { useId } from 'react';
import {
  AbsoluteFill,
  Easing,
  Img,
  interpolate,
  random,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';
import {
  createSmoothSvgPath,
  useWindowedAudioData,
  visualizeAudio,
  visualizeAudioWaveform,
} from '@remotion/media-utils';
import type { LyricsFile } from '../types';
import { AudioCoverStage, canDecodeAudioUrl } from './AudioCoverStage';
import {
  FlowLyricsStage,
  buildWordsFromLine,
  clamp01,
  springStep,
} from './FlowLyricsStage';

export type VisualEffectType =
  | 'auto'
  | 'none'
  | 'beat_pulse'
  | 'ken_burns'
  | 'glitch'
  | 'vinyl_spin'
  | 'cyber_hud'
  | 'waveform_aura'
  | 'float_3d'
  | 'retro_crt'
  | 'lyric_stage'
  | 'flow_lyrics';

interface VisualEffectsProps {
  effect?: string;
  modifiers?: string[];
  audioSrc: string;
  startSec: number;
  coverUrl?: string;
  lyrics?: LyricsFile | null;
  currentMediaSec?: number;
  isCoverMode?: boolean;
  children: React.ReactNode;
}

type AudioDrivenMode =
  | 'beat_pulse'
  | 'glitch'
  | 'vinyl_spin'
  | 'cyber_hud'
  | 'waveform_aura';

const FullCoverBlurredBackdrop: React.FC<{
  coverUrl?: string;
  filter: string;
  transform: string;
  children: React.ReactNode;
}> = ({ coverUrl, filter, transform, children }) => (
  <>
    <AbsoluteFill style={{ opacity: 0, pointerEvents: 'none' }}>
      {children}
    </AbsoluteFill>
    {coverUrl ? (
      <AbsoluteFill
        style={{
          filter,
          transform,
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
  </>
);

const AudioDrivenEffectInner: React.FC<{
  mode: AudioDrivenMode;
  audioSrc: string;
  startSec: number;
  coverUrl?: string;
  children: React.ReactNode;
}> = ({ mode, audioSrc, startSec, coverUrl, children }) => {
  const frame = useCurrentFrame();
  const { fps, width } = useVideoConfig();
  const particleGradId = useId().replace(/:/g, '');
  const audioFrame = Math.max(0, frame + Math.round(startSec * fps));

  const { audioData, dataOffsetInSeconds } = useWindowedAudioData({
    src: audioSrc,
    frame: audioFrame,
    fps,
    windowInSeconds: 30,
  });

  let bassEnergy = 0;
  let midEnergy = 0;
  let frequencies: number[] = [];
  let waveformPath = '';

  if (audioData) {
    frequencies = visualizeAudio({
      fps,
      frame: audioFrame,
      audioData,
      numberOfSamples: 128,
      optimizeFor: 'speed',
      smoothing: true,
      dataOffsetInSeconds,
    });
    const bassSlice = frequencies.slice(0, 6);
    const midSlice = frequencies.slice(6, 28);
    const bassAvg =
      bassSlice.reduce((sum, v) => sum + v, 0) / Math.max(1, bassSlice.length);
    const midAvg =
      midSlice.reduce((sum, v) => sum + v, 0) / Math.max(1, midSlice.length);
    bassEnergy = Math.min(1, Math.pow(bassAvg * 1.8, 0.75));
    midEnergy = Math.min(1, Math.pow(midAvg * 2.4, 0.75));

    if (mode === 'cyber_hud' || mode === 'waveform_aura') {
      const wave = visualizeAudioWaveform({
        fps,
        frame: audioFrame,
        audioData,
        numberOfSamples: 128,
        windowInSeconds: 0.08,
        dataOffsetInSeconds,
      });
      const waveW = mode === 'cyber_hud' ? 1200 : width;
      const waveH = mode === 'cyber_hud' ? 170 : 180;
      const amp = mode === 'cyber_hud' ? 0.47 : 0.42;
      const points = wave.map((y, i) => ({
        x: (i / Math.max(1, wave.length - 1)) * waveW,
        y: waveH / 2 + Math.max(-1, Math.min(1, y * 1.55)) * (waveH * amp),
      }));
      waveformPath = createSmoothSvgPath({ points });
    }
  }

  if (mode === 'beat_pulse') {
    const scale = 1.02 + bassEnergy * 0.065;
    const brightness = 1 + bassEnergy * 0.1;
    return (
      <AbsoluteFill style={{ overflow: 'hidden', backgroundColor: '#000' }}>
        <AbsoluteFill
          style={{
            transform: `scale(${scale})`,
            filter: `brightness(${brightness})`,
            transformOrigin: 'center center',
            willChange: 'transform',
          }}
        >
          {children}
        </AbsoluteFill>
      </AbsoluteFill>
    );
  }

  if (mode === 'glitch') {
    // True drum-beat onset detection: compare current sub-bass energy against
    // the previous 4 frames' baseline so glitches fire crisply on kick/snare transients
    // regardless of overall track loudness.
    const getBassAt = (f: number): number => {
      if (!audioData) return 0;
      const clampedF = Math.max(0, f);
      const fr = visualizeAudio({
        fps,
        frame: clampedF,
        audioData,
        numberOfSamples: 64,
        optimizeFor: 'speed',
        smoothing: false,
        dataOffsetInSeconds,
      });
      const slice = fr.slice(0, 4);
      const avg = slice.reduce((s, v) => s + v, 0) / Math.max(1, slice.length);
      return Math.min(1, Math.pow(avg * 1.8, 0.75));
    };

    const isRawTransient = (f: number): boolean => {
      const curr = getBassAt(f);
      if (curr < 0.66) return false;
      const prev = getBassAt(f - 1);
      if (curr < prev) return false;
      const baseline =
        (getBassAt(f - 3) + getBassAt(f - 4) + getBassAt(f - 5) + getBassAt(f - 6)) / 4;
      return curr - baseline > 0.30;
    };

    // Enforce an 18-frame (~300ms) cooldown so only major kick/drop hits trigger
    const isHitStart = (f: number): boolean => {
      if (!isRawTransient(f)) return false;
      for (let back = 1; back <= 18; back++) {
        if (isRawTransient(f - back)) return false;
      }
      return true;
    };

    // 3-frame decaying burst right on each detected drum hit
    let glitchIntensity = 0;
    if (isHitStart(audioFrame)) {
      glitchIntensity = 1.0;
    } else if (isHitStart(audioFrame - 1)) {
      glitchIntensity = 0.6;
    } else if (isHitStart(audioFrame - 2)) {
      glitchIntensity = 0.25;
    }
    const isGlitching = glitchIntensity > 0;

    const jitterX = isGlitching ? (random(`gx-${frame}`) - 0.5) * 20 * glitchIntensity : 0;
    const jitterY = isGlitching ? (random(`gy-${frame}`) - 0.5) * 8 * glitchIntensity : 0;
    const skewX = isGlitching ? (random(`sk-${frame}`) - 0.5) * 3.2 * glitchIntensity : 0;
    const barTop1 = Math.round(random(`b1-${frame}`) * 75);
    const barTop2 = Math.round(random(`b2-${frame}`) * 80);

    return (
      <AbsoluteFill style={{ overflow: 'hidden', backgroundColor: '#000' }}>
        <AbsoluteFill
          style={{
            transform: `scale(${(1.02 + bassEnergy * 0.03 + glitchIntensity * 0.02).toFixed(4)}) translate(${jitterX.toFixed(2)}px, ${jitterY.toFixed(2)}px) skewX(${skewX.toFixed(2)}deg)`,
            filter: isGlitching
              ? `contrast(${(1 + 0.22 * glitchIntensity).toFixed(2)}) saturate(${(1 + 0.5 * glitchIntensity).toFixed(2)}) drop-shadow(${(-5 * glitchIntensity).toFixed(1)}px 0 0 rgba(255,0,85,0.65)) drop-shadow(${(5 * glitchIntensity).toFixed(1)}px 0 0 rgba(0,240,255,0.65))`
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
                height: Math.round(14 * glitchIntensity),
                backgroundColor: `rgba(0, 240, 255, ${(0.22 * glitchIntensity).toFixed(2)})`,
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
                height: Math.round(8 * glitchIntensity),
                backgroundColor: `rgba(255, 0, 100, ${(0.24 * glitchIntensity).toFixed(2)})`,
                mixBlendMode: 'screen',
                pointerEvents: 'none',
              }}
            />
            <AbsoluteFill
              style={{
                background:
                  `repeating-linear-gradient(0deg, rgba(255,255,255,${(0.06 * glitchIntensity).toFixed(3)}) 0px, rgba(255,255,255,${(0.06 * glitchIntensity).toFixed(3)}) 1px, transparent 1px, transparent 5px)`,
                pointerEvents: 'none',
              }}
            />
          </>
        ) : null}
      </AbsoluteFill>
    );
  }

  if (mode === 'vinyl_spin') {
    const deg = (frame / fps) * 24;
    const barCount = 48;
    const radius = 252;
    return (
      <AbsoluteFill style={{ backgroundColor: '#09090b', overflow: 'hidden' }}>
        <AbsoluteFill
          style={{
            filter: 'blur(38px) brightness(0.36)',
            transform: `scale(${1.12 + bassEnergy * 0.04})`,
          }}
        >
          {children}
        </AbsoluteFill>

        <AbsoluteFill
          style={{
            justifyContent: 'center',
            alignItems: 'center',
            paddingBottom: 130,
          }}
        >
          <div style={{ position: 'relative', width: 580, height: 580, display: 'flex', justifyContent: 'center', alignItems: 'center' }}>
            {/* Radial 48-bar circular audio spectrum */}
            <svg
              width={580}
              height={580}
              viewBox="0 0 580 580"
              style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}
            >
              {Array.from({ length: barCount }).map((_, i) => {
                const angle = (i / barCount) * Math.PI * 2 - Math.PI / 2;
                const bin = Math.min(frequencies.length - 1, Math.floor((i / barCount) * 44) + 1);
                const val = frequencies[bin] ?? 0;
                const len = 8 + Math.min(52, Math.pow(val * (1 + i * 0.02), 0.65) * 68);
                const x1 = 290 + Math.cos(angle) * radius;
                const y1 = 290 + Math.sin(angle) * radius;
                const x2 = 290 + Math.cos(angle) * (radius + len);
                const y2 = 290 + Math.sin(angle) * (radius + len);
                return (
                  <line
                    key={i}
                    x1={x1}
                    y1={y1}
                    x2={x2}
                    y2={y2}
                    stroke="rgba(255, 255, 255, 0.72)"
                    strokeWidth={3.5}
                    strokeLinecap="round"
                  />
                );
              })}
            </svg>

            {/* Spinning Vinyl Disc */}
            <div
              style={{
                width: 450,
                height: 450,
                borderRadius: '50%',
                padding: 28,
                background:
                  'radial-gradient(circle, #18181b 0%, #09090b 60%, #27272a 82%, #09090b 100%)',
                boxShadow: `0 24px 70px rgba(0, 0, 0, 0.8), 0 0 ${Math.round(24 + bassEnergy * 32)}px rgba(255, 255, 255, ${0.08 + bassEnergy * 0.16})`,
                transform: `rotate(${deg}deg)`,
                display: 'flex',
                justifyContent: 'center',
                alignItems: 'center',
                position: 'relative',
              }}
            >
              {coverUrl ? (
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
              ) : null}
              {/* Center Spindle Hole */}
              <div
                style={{
                  position: 'absolute',
                  width: 28,
                  height: 28,
                  borderRadius: '50%',
                  backgroundColor: '#09090b',
                  border: '3px solid rgba(255, 255, 255, 0.35)',
                }}
              />
            </div>
          </div>
        </AbsoluteFill>
      </AbsoluteFill>
    );
  }

  if (mode === 'waveform_aura') {
    const coverScale = 1 + bassEnergy * 0.045;
    return (
      <AbsoluteFill style={{ backgroundColor: '#09090b', overflow: 'hidden' }}>
        <FullCoverBlurredBackdrop
          coverUrl={coverUrl}
          filter="blur(56px) brightness(0.38) saturate(1.4)"
          transform={`scale(${1.14 + midEnergy * 0.05})`}
        >
          {children}
        </FullCoverBlurredBackdrop>

        {/* Full-width glowing oscilloscope waveform behind cover */}
        {waveformPath ? (
          <AbsoluteFill
            style={{
              justifyContent: 'center',
              alignItems: 'center',
              paddingBottom: 64,
              pointerEvents: 'none',
            }}
          >
            <svg width={width} height={180} viewBox={`0 0 ${width} 180`}>
              <path
                d={waveformPath}
                fill="none"
                stroke="rgba(255, 255, 255, 0.32)"
                strokeWidth={8}
                strokeLinecap="round"
                style={{ filter: 'blur(6px)' }}
              />
              <path
                d={waveformPath}
                fill="none"
                stroke="rgba(255, 255, 255, 0.9)"
                strokeWidth={3}
                strokeLinecap="round"
              />
            </svg>
          </AbsoluteFill>
        ) : null}

        {/* Floating 1:1 Cover Card (605x605, centered at y=508) */}
        <AbsoluteFill
          style={{
            justifyContent: 'center',
            alignItems: 'center',
            paddingBottom: 64,
          }}
        >
          {coverUrl ? (
            <div
              style={{
                width: 605,
                height: 605,
                borderRadius: 24,
                overflow: 'hidden',
                transform: `scale(${coverScale})`,
                boxShadow: `0 28px 80px rgba(0, 0, 0, 0.78), 0 0 ${Math.round(20 + bassEnergy * 40)}px rgba(255, 255, 255, ${0.12 + bassEnergy * 0.2})`,
                border: '1px solid rgba(255, 255, 255, 0.22)',
              }}
            >
              <Img src={coverUrl} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
            </div>
          ) : null}
        </AbsoluteFill>
      </AbsoluteFill>
    );
  }

  // mode === 'cyber_hud'
  const diamondScale = 1 + bassEnergy * 0.05;
  const particleCount = 68;
  const timeSec = frame / fps;

  return (
    <AbsoluteFill style={{ backgroundColor: '#05080f', overflow: 'hidden' }}>
      <AbsoluteFill
        style={{
          filter: 'blur(36px) brightness(0.32) saturate(1.2)',
          transform: 'scale(1.12)',
        }}
      >
        {children}
      </AbsoluteFill>

      {/* Subtle Tech Grid */}
      <AbsoluteFill
        style={{
          backgroundImage:
            'linear-gradient(rgba(56, 189, 248, 0.06) 1px, transparent 1px), linear-gradient(90deg, rgba(56, 189, 248, 0.06) 1px, transparent 1px)',
          backgroundSize: '48px 48px',
          pointerEvents: 'none',
        }}
      />

      {/* Audio-Reactive Cyber Particle Field */}
      <AbsoluteFill style={{ pointerEvents: 'none' }}>
        <svg width={width} height={900} viewBox={`0 0 ${width} 900`}>
          <defs>
            <radialGradient id={`hud-particle-${particleGradId}`} cx="50%" cy="50%" r="50%">
              <stop offset="0%" stopColor="rgba(224, 242, 254, 1)" />
              <stop offset="45%" stopColor="rgba(56, 189, 248, 0.85)" />
              <stop offset="100%" stopColor="rgba(56, 189, 248, 0)" />
            </radialGradient>
          </defs>
          {Array.from({ length: particleCount }).map((_, i) => {
            const angle = random(`pa-${i}`) * Math.PI * 2;
            const speed = 0.08 + random(`ps-${i}`) * 0.16;
            const phase = (random(`pp-${i}`) + timeSec * speed) % 1;
            const bin = Math.min(frequencies.length - 1, (i % 40) + 1);
            const freqVal = frequencies[bin] ?? 0;
            const energy = Math.min(1, Math.pow(freqVal * 2.2, 0.7));

            // Radiate outward from the diamond center (960, 440)
            const dist = 190 + phase * 620 + bassEnergy * 38;
            const cx = width / 2 + Math.cos(angle) * dist * 1.35;
            const cy = 440 + Math.sin(angle) * dist * 0.72;
            const baseR = 3 + random(`pr-${i}`) * 5.5;
            const r = baseR * (0.75 + energy * 1.45 + bassEnergy * 0.45);
            const lifeAlpha = Math.sin(phase * Math.PI);
            const opacity = Math.min(0.95, lifeAlpha * (0.32 + energy * 0.68));

            return (
              <circle
                key={i}
                cx={cx}
                cy={cy}
                r={r}
                fill={`url(#hud-particle-${particleGradId})`}
                opacity={opacity}
              />
            );
          })}
        </svg>
      </AbsoluteFill>

      {/* Center 45° Diamond Cover Frame */}
      <AbsoluteFill
        style={{
          justifyContent: 'center',
          alignItems: 'center',
          paddingBottom: 175,
        }}
      >
        <div
          style={{
            width: 340,
            height: 340,
            transform: `rotate(45deg) scale(${diamondScale})`,
            borderRadius: 20,
            overflow: 'hidden',
            border: '2px solid rgba(56, 189, 248, 0.65)',
            boxShadow: `0 0 ${Math.round(24 + bassEnergy * 42)}px rgba(56, 189, 248, ${0.35 + bassEnergy * 0.35})`,
            backgroundColor: '#0f172a',
          }}
        >
          {coverUrl ? (
            <Img
              src={coverUrl}
              style={{
                width: '100%',
                height: '100%',
                objectFit: 'cover',
              }}
            />
          ) : null}
        </div>
      </AbsoluteFill>

      {/* High-Amplitude Dual-layer HUD Waveform */}
      {waveformPath ? (
        <div
          style={{
            position: 'absolute',
            left: '50%',
            bottom: 222,
            transform: 'translateX(-50%)',
            width: 1200,
            height: 170,
            pointerEvents: 'none',
          }}
        >
          <svg width={1200} height={170} viewBox="0 0 1200 170">
            <line x1={0} y1={85} x2={1200} y2={85} stroke="rgba(56, 189, 248, 0.22)" strokeWidth={1} strokeDasharray="6 6" />
            <path
              d={waveformPath}
              fill="none"
              stroke="rgba(56, 189, 248, 0.45)"
              strokeWidth={8}
              strokeLinecap="round"
              style={{ filter: 'blur(6px)' }}
            />
            <path
              d={waveformPath}
              fill="none"
              stroke="rgba(186, 230, 253, 0.96)"
              strokeWidth={2.8}
              strokeLinecap="round"
            />
          </svg>
        </div>
      ) : null}
    </AbsoluteFill>
  );
};

const AudioDrivenEffect: React.FC<{
  mode: AudioDrivenMode;
  audioSrc: string;
  startSec: number;
  coverUrl?: string;
  children: React.ReactNode;
}> = (props) => {
  if (!canDecodeAudioUrl(props.audioSrc)) {
    return <AbsoluteFill>{props.children}</AbsoluteFill>;
  }
  return <AudioDrivenEffectInner {...props} />;
};

const RetroCrtOverlay: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const frame = useCurrentFrame();
  const flicker = 0.96 + random(`crt-${Math.floor(frame / 2)}`) * 0.05;
  return (
    <AbsoluteFill style={{ overflow: 'hidden', backgroundColor: '#000' }}>
      <AbsoluteFill
        style={{
          filter: `sepia(0.18) contrast(1.08) saturate(1.15) brightness(${flicker.toFixed(3)})`,
          transform: 'scale(1.02)',
        }}
      >
        {children}
      </AbsoluteFill>
      <AbsoluteFill
        style={{
          background:
            'repeating-linear-gradient(0deg, rgba(0,0,0,0.22) 0px, rgba(0,0,0,0.22) 1px, transparent 1px, transparent 4px)',
          pointerEvents: 'none',
        }}
      />
      <AbsoluteFill
        style={{
          background:
            'radial-gradient(circle at center, transparent 52%, rgba(0, 0, 0, 0.65) 100%)',
          pointerEvents: 'none',
        }}
      />
    </AbsoluteFill>
  );
};

export const VisualEffects: React.FC<VisualEffectsProps> = ({
  effect = 'auto',
  modifiers = [],
  audioSrc,
  startSec,
  coverUrl,
  lyrics,
  currentMediaSec = 0,
  isCoverMode = false,
  children,
}) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();

  const activeModifiers = new Set(modifiers);
  const legacyModifierEffects = new Set(['beat_pulse', 'float_3d', 'glitch', 'retro_crt']);

  let resolvedEffect: VisualEffectType = 'none';
  if (!effect || effect === 'auto') {
    resolvedEffect = 'none';
    if (isCoverMode && activeModifiers.size === 0) {
      activeModifiers.add('beat_pulse');
    }
  } else if (legacyModifierEffects.has(effect)) {
    resolvedEffect = 'none';
    activeModifiers.add(effect);
  } else {
    resolvedEffect = effect as VisualEffectType;
  }

  const hasBeatPulse = activeModifiers.has('beat_pulse');
  const hasFloat3d = activeModifiers.has('float_3d');
  const hasGlitch = activeModifiers.has('glitch');
  const hasRetroCrt = activeModifiers.has('retro_crt');

  const wrapScreenModifiers = (node: React.ReactNode): React.ReactNode => {
    let wrapped = node;
    if (hasGlitch && audioSrc) {
      wrapped = (
        <AudioDrivenEffect
          mode="glitch"
          audioSrc={audioSrc}
          startSec={startSec}
          coverUrl={coverUrl}
        >
          {wrapped}
        </AudioDrivenEffect>
      );
    }
    if (hasRetroCrt) {
      wrapped = <RetroCrtOverlay>{wrapped}</RetroCrtOverlay>;
    }
    return wrapped;
  };

  if (
    (resolvedEffect === 'vinyl_spin' ||
      resolvedEffect === 'cyber_hud' ||
      resolvedEffect === 'waveform_aura') &&
    audioSrc
  ) {
    return wrapScreenModifiers(
      <AudioDrivenEffect
        mode={resolvedEffect}
        audioSrc={audioSrc}
        startSec={startSec}
        coverUrl={coverUrl}
      >
        {children}
      </AudioDrivenEffect>,
    );
  }

  if (resolvedEffect === 'ken_burns') {
    const progress = interpolate(frame, [0, Math.max(1, durationInFrames - 1)], [0, 1], {
      easing: Easing.inOut(Easing.sin),
      extrapolateLeft: 'clamp',
      extrapolateRight: 'clamp',
    });
    // Pure centered cinema dolly-in (avoids 2D subpixel pan stepping on <video>)
    const scale = interpolate(progress, [0, 1], [1.0, 1.12]);
    return wrapScreenModifiers(
      <AbsoluteFill style={{ overflow: 'hidden', backgroundColor: '#000' }}>
        <AbsoluteFill
          style={{
            transform: `scale(${scale.toFixed(5)})`,
            transformOrigin: '50% 45%',
            willChange: 'transform',
            backfaceVisibility: 'hidden',
          }}
        >
          {children}
        </AbsoluteFill>
        <AbsoluteFill
          style={{
            background:
              'radial-gradient(circle at center, transparent 60%, rgba(0, 0, 0, 0.35) 100%)',
            pointerEvents: 'none',
          }}
        />
      </AbsoluteFill>,
    );
  }

  if (resolvedEffect === 'lyric_stage') {
    const lines = lyrics?.lines || [];
    let activeIdx = 0;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].time <= currentMediaSec) {
        activeIdx = i;
      } else {
        break;
      }
    }
    const rowHeight = 122;
    const viewportH = 560;
    const anchorY = viewportH * 0.36 - rowHeight / 2;
    const lineStartSec = lines[activeIdx]?.time ?? 0;
    const elapsedSinceLine = Math.max(0, currentMediaSec - lineStartSec);
    const prevIdx = Math.max(0, activeIdx - 1);
    const prevOffset = -(prevIdx * rowHeight) + anchorY;
    const currOffset = -(activeIdx * rowHeight) + anchorY;
    const scrollSpring = activeIdx === 0 ? 1 : springStep(elapsedSinceLine * 1.35);
    const targetOffset = prevOffset + (currOffset - prevOffset) * scrollSpring;

    const t = frame / fps;
    const gentleRotY = 16 + Math.sin(t * 0.6) * 3;
    const gentleFloatY = Math.sin(t * 0.9) * 6;

    return wrapScreenModifiers(
      <AbsoluteFill style={{ backgroundColor: '#09090b', overflow: 'hidden' }}>
        <AbsoluteFill
          style={{
            filter: 'blur(46px) brightness(0.34) saturate(1.4)',
            transform: 'scale(1.16)',
          }}
        >
          {children}
        </AbsoluteFill>

        {/* Left: 3D Angled Standing Album Cover */}
        <AbsoluteFill
          style={{
            left: 110,
            top: 195,
            width: 470,
            height: 470,
            perspective: 1200,
          }}
        >
          {coverUrl ? (
            <div
              style={{
                width: '100%',
                height: '100%',
                borderRadius: 22,
                overflow: 'hidden',
                transform: `translate3d(0, ${gentleFloatY.toFixed(2)}px, 0) rotateY(${gentleRotY.toFixed(2)}deg) rotateX(2deg)`,
                boxShadow:
                  '-18px 28px 75px rgba(0, 0, 0, 0.85), 0 0 0 1px rgba(255, 255, 255, 0.22)',
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

        {/* Right: Mygo-Music Style Word-Alpha Scrolling Bilingual Lyrics */}
        <div
          style={{
            position: 'absolute',
            left: 720,
            right: 140,
            top: 185,
            height: viewportH,
            overflow: 'hidden',
            maskImage:
              'linear-gradient(to bottom, transparent 0%, black 16%, black 82%, transparent 100%)',
            WebkitMaskImage:
              'linear-gradient(to bottom, transparent 0%, black 16%, black 82%, transparent 100%)',
          }}
        >
          {lines.length > 0 ? (
            <div
              style={{
                transform: `translate3d(0, ${targetOffset.toFixed(2)}px, 0)`,
                willChange: 'transform',
              }}
            >
              {lines.map((ln, lIdx) => {
                const dist = Math.abs(lIdx - activeIdx);
                const isActive = lIdx === activeIdx;
                const rowScale = isActive
                  ? 0.94 + 0.06 * springStep(elapsedSinceLine)
                  : 0.94;
                const rowOpacity = isActive
                  ? 0.36 + 0.64 * clamp01(elapsedSinceLine / 0.38)
                  : dist === 1
                    ? 0.34
                    : dist === 2
                      ? 0.22
                      : 0.14;
                const blurPx = isActive ? 0 : dist === 1 ? 0.35 : 1.05;
                const nextLineTime = lines[lIdx + 1]?.time ?? ln.time + 4.5;
                const activeWords = isActive
                  ? buildWordsFromLine(ln, nextLineTime)
                  : null;

                return (
                  <div
                    key={lIdx}
                    style={{
                      height: rowHeight,
                      display: 'flex',
                      flexDirection: 'column',
                      justifyContent: 'center',
                      alignItems: 'flex-start',
                      textAlign: 'left',
                      opacity: rowOpacity,
                      filter: blurPx > 0 ? `blur(${blurPx}px)` : undefined,
                      transform: `scale(${rowScale.toFixed(4)})`,
                      transformOrigin: 'left center',
                    }}
                  >
                    {isActive && activeWords ? (
                      <div
                        style={{
                          display: 'flex',
                          flexWrap: 'wrap',
                          alignItems: 'baseline',
                          fontFamily:
                            '"Noto Serif SC", "Source Han Serif SC", "Songti SC", sans-serif',
                          fontSize: 38,
                          fontWeight: 700,
                          lineHeight: 1.28,
                          textShadow: '0 2px 14px rgba(0, 0, 0, 0.78)',
                        }}
                      >
                        {activeWords.map((w, wIdx) => {
                          const lit = clamp01(
                            (currentMediaSec - w.startSec) /
                              Math.max(0.06, w.endSec - w.startSec)
                          );
                          const alpha = (0.36 + 0.64 * lit).toFixed(3);
                          return (
                            <span
                              key={wIdx}
                              style={{
                                display: 'inline-block',
                                marginRight: w.hasTrailingSpace ? '0.28em' : '0.01em',
                                color: `rgba(255, 255, 255, ${alpha})`,
                              }}
                            >
                              {w.text}
                            </span>
                          );
                        })}
                      </div>
                    ) : (
                      <div
                        style={{
                          maxWidth: '100%',
                          fontFamily:
                            '"Noto Serif SC", "Source Han Serif SC", "Songti SC", sans-serif',
                          fontSize: 34,
                          fontWeight: 600,
                          lineHeight: 1.28,
                          color: 'rgba(255, 255, 255, 0.92)',
                          textShadow: '0 2px 12px rgba(0, 0, 0, 0.72)',
                          display: '-webkit-box',
                          WebkitLineClamp: 2,
                          WebkitBoxOrient: 'vertical',
                          overflow: 'hidden',
                        }}
                      >
                        {ln.orig}
                      </div>
                    )}
                    {ln.trans ? (
                      <div
                        style={{
                          maxWidth: '100%',
                          fontFamily:
                            '"Noto Serif SC", "Source Han Serif SC", "Songti SC", sans-serif',
                          fontSize: isActive ? 22 : 19,
                          fontWeight: 400,
                          lineHeight: 1.32,
                          color: isActive
                            ? 'rgba(241, 245, 249, 0.92)'
                            : 'rgba(226, 232, 240, 0.82)',
                          marginTop: 5,
                          textShadow: '0 2px 10px rgba(0, 0, 0, 0.7)',
                          whiteSpace: 'nowrap',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                        }}
                      >
                        {ln.trans}
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          ) : (
            <div
              style={{
                height: '100%',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: 'rgba(255, 255, 255, 0.45)',
                fontSize: 28,
                fontFamily: '"Noto Serif SC", serif',
              }}
            >
              纯音乐 / 暂无歌词
            </div>
          )}
        </div>
      </AbsoluteFill>,
    );
  }

  if (resolvedEffect === 'flow_lyrics') {
    return wrapScreenModifiers(
      <AbsoluteFill style={{ backgroundColor: '#07070a', overflow: 'hidden' }}>
        <AudioCoverStage
          audioSrc={audioSrc}
          startSec={startSec}
          coverUrl={coverUrl}
          coverBrightness={0.52}
          animateBeat={hasBeatPulse}
          float3d={hasFloat3d}
          showParticles={true}
        >
          {children}
        </AudioCoverStage>

        {/* Foreground Center: 流光（Flow）Word-by-Word Kinetic Lyric Stage (centered on 605x605 cover) */}
        <div
          style={{
            position: 'absolute',
            left: 160,
            right: 160,
            top: 193,
            height: 630,
          }}
        >
          <FlowLyricsStage
            lyrics={lyrics}
            currentMediaSec={currentMediaSec}
          />
        </div>
      </AbsoluteFill>,
    );
  }

  if (isCoverMode && (hasBeatPulse || hasFloat3d)) {
    return wrapScreenModifiers(
      <AudioCoverStage
        audioSrc={audioSrc}
        startSec={startSec}
        coverUrl={coverUrl}
        coverBrightness={1}
        animateBeat={hasBeatPulse}
        float3d={hasFloat3d}
        showParticles={false}
      >
        {children}
      </AudioCoverStage>,
    );
  }

  if (hasBeatPulse && audioSrc) {
    return wrapScreenModifiers(
      <AudioDrivenEffect
        mode="beat_pulse"
        audioSrc={audioSrc}
        startSec={startSec}
        coverUrl={coverUrl}
      >
        {children}
      </AudioDrivenEffect>,
    );
  }

  if (hasFloat3d) {
    return wrapScreenModifiers(
      <AudioCoverStage
        audioSrc={audioSrc}
        startSec={startSec}
        coverUrl={coverUrl}
        coverBrightness={1}
        animateBeat={false}
        float3d={true}
        showParticles={false}
      >
        {children}
      </AudioCoverStage>,
    );
  }

  return wrapScreenModifiers(<AbsoluteFill>{children}</AbsoluteFill>);
};
