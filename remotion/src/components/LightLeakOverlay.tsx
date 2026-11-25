import React from 'react';
import { lightLeak } from '@remotion/effects/light-leak';
import { AbsoluteFill, interpolate, Solid, useCurrentFrame, useVideoConfig } from 'remotion';

interface LightLeakOverlayProps {
  seed?: number;
  hueShift?: number;
}

export const LightLeakOverlay: React.FC<LightLeakOverlayProps> = ({
  seed = 2,
  hueShift = 0,
}) => {
  const frame = useCurrentFrame();
  const { durationInFrames, height, width } = useVideoConfig();

  return (
    <AbsoluteFill style={{ mixBlendMode: 'screen', pointerEvents: 'none' }}>
      <Solid
        width={width}
        height={height}
        style={{ mixBlendMode: 'screen' }}
        effects={[
          lightLeak({
            seed,
            hueShift,
            progress: interpolate(frame, [0, Math.max(1, durationInFrames - 1)], [0, 1], {
              extrapolateLeft: 'clamp',
              extrapolateRight: 'clamp',
            }),
          }),
        ]}
      />
    </AbsoluteFill>
  );
};
