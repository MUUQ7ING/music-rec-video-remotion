import React from 'react';
import { useCurrentFrame, useVideoConfig } from 'remotion';
import { useAudioData, visualizeAudio } from '@remotion/media-utils';

interface AudioSpectrumProps {
  audioSrc: string;
  startSec: number;
  width?: number;
  height?: number;
  barCount?: number;
}

export const AudioSpectrum: React.FC<AudioSpectrumProps> = ({
  audioSrc,
  startSec,
  width = 186,
  height = 68,
  barCount = 24,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const audioData = useAudioData(audioSrc);

  if (!audioData) {
    return null;
  }

  const audioFrame = frame + Math.round(startSec * fps);
  const numberOfSamples = 256;
  const frequencyData = visualizeAudio({
    fps,
    frame: Math.max(0, audioFrame),
    audioData,
    numberOfSamples,
    smoothing: true,
  });

  // Map bars logarithmically across musical frequencies (~60Hz to ~12kHz)
  // and apply perceptual high-frequency tilt so mids & highs dance naturally
  // instead of collapsing into a 1/f slope on the right.
  const minBin = 1;
  const maxBin = Math.min(frequencyData.length - 1, 96);
  const bins: number[] = [];

  for (let i = 0; i < barCount; i++) {
    const t0 = i / barCount;
    const t1 = (i + 1) / barCount;
    const startIdx = Math.floor(minBin * Math.pow(maxBin / minBin, t0));
    const endIdx = Math.max(
      startIdx + 1,
      Math.ceil(minBin * Math.pow(maxBin / minBin, t1)),
    );

    let peak = 0;
    for (let b = startIdx; b < endIdx && b < frequencyData.length; b++) {
      if (frequencyData[b] > peak) {
        peak = frequencyData[b];
      }
    }

    // Perceptual tilt (+3dB/oct style compensation) + dynamic range compression
    const tilt = 1 + (i / (barCount - 1)) * 2.2;
    const compressed = Math.pow(Math.min(1, peak * tilt), 0.55);
    bins.push(Math.min(1, compressed * 1.15));
  }

  const gap = 3;
  const barWidth = Math.max(2, (width - 16 - gap * (barCount - 1)) / barCount);

  return (
    <div
      style={{
        width,
        height,
        display: 'flex',
        alignItems: 'flex-end',
        justifyContent: 'center',
        gap,
        padding: '0 8px 6px 8px',
        boxSizing: 'border-box',
        background:
          'linear-gradient(to top, rgba(0, 0, 0, 0.62) 0%, rgba(0, 0, 0, 0.2) 65%, rgba(0, 0, 0, 0) 100%)',
      }}
    >
      {bins.map((val, idx) => {
        const barH = Math.max(3, Math.round(val * (height - 14)));
        return (
          <div
            key={idx}
            style={{
              width: barWidth,
              height: barH,
              borderRadius: 2,
              backgroundColor: 'rgba(255, 255, 255, 0.88)',
              boxShadow: '0 0 6px rgba(255, 255, 255, 0.35)',
            }}
          />
        );
      })}
    </div>
  );
};
