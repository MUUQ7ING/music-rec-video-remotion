import { useEffect, useRef, type MouseEvent as ReactMouseEvent } from 'react';
import { useStudioStore } from '../state/useStudioStore';
import { fmtSec, parseSec } from '../utils/time';
import { TransportKeycaps } from './TransportKeycaps';
import { PixelIcon } from './ui/PixelIcon';
import { TapeWaveform } from './TapeWaveform';
import { TactileButton } from './ui/TactileButton';

export function TapeScrubber({ previewTransport }: { previewTransport?: { playing: boolean; toggle: () => void } }) {
  const {
    activeClip,
    activeIdx,
    activeMediaUrl,
    trimCurrentSec,
    trimTotalSec,
    isPlaying,
    trimLoopPlaying,
    setTrimLoopPlaying,
    togglePlay,
    seekTo,
    setTrimPoint,
    nudgeTrim,
    setScrubPoint,
  } = useStudioStore();

  const playing = previewTransport?.playing ?? isPlaying;
  const trackRef = useRef<HTMLDivElement | null>(null);
  const draggingHandleRef = useRef<'in' | 'out' | null>(null);

  const startSec = parseSec(activeClip?.start);
  const endSec = parseSec(activeClip?.end);
  const total = trimTotalSec > 0 ? trimTotalSec : Math.max(endSec, 1);

  const leftPct = Math.max(0, Math.min(100, (startSec / total) * 100));
  const rightPct = Math.max(leftPct, Math.min(100, (endSec / total) * 100));
  const headPct = Math.max(0, Math.min(100, (trimCurrentSec / total) * 100));
  const clipDur = Math.max(0, endSec - startSec);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const handle = draggingHandleRef.current;
      const track = trackRef.current;
      if (!handle || !track) return;
      const rect = track.getBoundingClientRect();
      if (rect.width <= 0) return;
      const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      const sec = Math.round(ratio * total * 10) / 10;
      setScrubPoint(handle, sec);
    };
    const onUp = () => {
      draggingHandleRef.current = null;
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [setScrubPoint, total]);

  const onTrackClick = (e: ReactMouseEvent<HTMLDivElement>) => {
    if (!trackRef.current) return;
    const rect = trackRef.current.getBoundingClientRect();
    if (rect.width <= 0) return;
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    seekTo(ratio * total);
  };

  return (
    <div className="scrubber-box" data-testid="tape-scrubber">
      <div className="tape-readout mono">
        <span>TAPE</span>
        <span>{fmtSec(trimCurrentSec)} / {trimTotalSec > 0 ? fmtSec(trimTotalSec) : '—'}</span>
      </div>
      <div
        ref={trackRef}
        className="scrubber-track"
        onClick={onTrackClick}
      >
        <TapeWaveform index={activeIdx} mediaUrl={activeMediaUrl} duration={trimTotalSec} />
        <div className="scrubber-ticks" />
        <div
          className="scrubber-range"
          style={{ left: `${leftPct}%`, width: `${Math.max(0.8, rightPct - leftPct)}%` }}
        />
        <div className="scrubber-head" style={{ left: `${headPct}%` }} />
        <div
          className="scrubber-handle in"
          data-testid="scrubber-handle-in"
          style={{ left: `clamp(6px, ${leftPct}%, calc(100% - 6px))` }}
          onClick={(e) => e.stopPropagation()}
          onMouseDown={(e) => {
            e.preventDefault();
            e.stopPropagation();
            draggingHandleRef.current = 'in';
          }}
        >
          I
        </div>
        <div
          className="scrubber-handle out"
          data-testid="scrubber-handle-out"
          style={{ left: `clamp(6px, ${rightPct}%, calc(100% - 6px))` }}
          onClick={(e) => e.stopPropagation()}
          onMouseDown={(e) => {
            e.preventDefault();
            e.stopPropagation();
            draggingHandleRef.current = 'out';
          }}
        >
          O
        </div>
      </div>

      <div className="transport-row">
        <div className="transport-btns">
          <TactileButton
            variant="dark"
            size="sm"
            data-testid="transport-play"
            onClick={previewTransport?.toggle ?? (() => togglePlay())}
          >
            <PixelIcon name={playing ? 'pause' : 'play'} />
            {playing ? 'Pause' : 'Play'}
          </TactileButton>
          <TactileButton
            size="sm"
            active={trimLoopPlaying}
            led={trimLoopPlaying ? 'accent' : 'off'}
            data-testid="transport-loop"
            onClick={() => setTrimLoopPlaying(!trimLoopPlaying)}
          >
            {trimLoopPlaying ? 'LOOP ON' : 'LOOP OFF'}
          </TactileButton>
          <TactileButton
            size="sm"
            data-testid="transport-jump-in"
            onClick={() => seekTo(startSec)}
          >
            IN ⇥
          </TactileButton>
          <TactileButton
            size="sm"
            data-testid="transport-jump-out"
            onClick={() => seekTo(endSec)}
          >
            ⇤ OUT
          </TactileButton>
        </div>

        <div className="transport-notes">
          <span className="transport-hint">{clipDur.toFixed(1)} s</span>
          <TransportKeycaps />
        </div>
      </div>

      <div className="io-grid">
        {(['in', 'out'] as const).map(point => {
          const isIn = point === 'in';
          return (
            <div className="io-box" data-testid={`io-${point}-box`} key={point}>
              <div className="io-top">
                <span className="io-label">{isIn ? 'In point' : 'Out point'}</span>
                <span className="io-readout">{fmtSec(isIn ? startSec : endSec)}</span>
              </div>
              <div className="io-btns">
                <div className="trim-nudge-keys" role="group" aria-label={isIn ? '微调入点' : '微调出点'}>
                  {[-1, -0.1, 0.1, 1].map(delta => (
                    <TactileButton key={delta} size="xs" onClick={() => nudgeTrim(point, delta)}>
                      {delta > 0 ? '+' : ''}{delta}s
                    </TactileButton>
                  ))}
                </div>
                <TactileButton className="trim-set-key" size="xs" onClick={() => setTrimPoint(point)}>
                  {isIn ? 'Set I' : 'Set O'}
                </TactileButton>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
