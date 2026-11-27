import { useContext, useEffect } from 'react';
import { Internals } from 'remotion';
import { PlaylistVideo } from '../../../remotion/src/components/PlaylistVideo';
import type { PlaylistVideoProps } from '../../../remotion/src/types';

export type MixReading = { left: number; right: number; clip: boolean };

export function SequenceMix({ onMix, ...props }: PlaylistVideoProps & { onMix?: (reading: MixReading | null) => void }) {
  const gain = useContext(Internals.SharedAudioContext)?.gainNode;
  useEffect(() => {
    if (!gain || !onMix) return;
    const splitter = gain.context.createChannelSplitter(2);
    const analysers = [gain.context.createAnalyser(), gain.context.createAnalyser()];
    const buffer = new Float32Array(1024);
    gain.connect(splitter);
    analysers.forEach((node, index) => {
      node.fftSize = buffer.length;
      splitter.connect(node, index);
    });
    const timer = window.setInterval(() => {
      let clip = false;
      const levels = analysers.map(node => {
        node.getFloatTimeDomainData(buffer);
        let sum = 0;
        for (const sample of buffer) {
          sum += sample * sample;
          clip ||= Math.abs(sample) >= 1;
        }
        return Math.max(-60, Math.min(0, 10 * Math.log10(sum / buffer.length)));
      });
      onMix({ left: levels[0], right: levels[1], clip });
    }, 80);
    return () => {
      clearInterval(timer);
      gain.disconnect(splitter);
      splitter.disconnect();
      onMix(null);
    };
  }, [gain, onMix]);
  return <PlaylistVideo {...props} meterMix={Boolean(onMix)} />;
}
