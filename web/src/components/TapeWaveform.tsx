import { useEffect, useMemo, useState } from 'react';
import { loadPreviewWaveform, type PreviewWaveform } from '../api/client';

interface TapeWaveformProps {
  index: number;
  mediaUrl: string;
  duration: number;
}

export function TapeWaveform({ index, mediaUrl, duration }: TapeWaveformProps) {
  const [result, setResult] = useState<{ mediaUrl: string; waveform: PreviewWaveform } | null>(null);
  const waveform = result?.mediaUrl === mediaUrl ? result.waveform : null;

  useEffect(() => {
    if (!mediaUrl) return;
    const controller = new AbortController();
    loadPreviewWaveform(index, controller.signal)
      .then(response => {
        if (!controller.signal.aborted) setResult({ mediaUrl, waveform: response });
      })
      .catch(() => {
        if (!controller.signal.aborted) setResult({ mediaUrl, waveform: { duration: 0, peaks: [] } });
      });
    return () => controller.abort();
  }, [index, mediaUrl]);

  const drawing = useMemo(() => {
    if (!waveform?.peaks.length || duration <= 0 || waveform.duration <= 0) return '';
    const width = 1000 * waveform.duration / duration;
    return waveform.peaks.map((peak, index) => {
      const x = ((index + 0.5) / waveform.peaks.length * width).toFixed(2);
      const amplitude = Math.max(0.8, Math.sqrt(peak) * 17);
      return `M${x},${20 - amplitude}V${20 + amplitude}`;
    }).join(' ');
  }, [waveform, duration]);

  const state = !mediaUrl ? 'empty' : !waveform ? 'loading' : drawing ? 'ready' : 'empty';

  return (
    <div className="tape-waveform" data-testid="tape-waveform" data-state={state} aria-hidden="true">
      {drawing ? (
        <svg viewBox="0 0 1000 40" preserveAspectRatio="none">
          <path d={drawing} />
        </svg>
      ) : (
        <span>{state === 'loading' ? 'Reading audio…' : 'No waveform'}</span>
      )}
    </div>
  );
}
