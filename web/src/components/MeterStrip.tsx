import { useEffect, useRef, useState } from 'react';
import { useStudioStore } from '../state/useStudioStore';
import {
  IDLE_METER_SNAPSHOT,
  sampleAudioMeter,
  type AudioMeterSnapshot,
} from '../utils/audioMeter';

const SEGMENTS = Array.from({ length: 22 }, (_, i) => i);

export function MeterStrip() {
  const { videoRef, isPlaying, activeSong, activeMediaUrl } = useStudioStore();
  const [snap, setSnap] = useState<AudioMeterSnapshot>(IDLE_METER_SNAPSHOT);
  const [peakSegL, setPeakSegL] = useState(0);
  const [peakSegR, setPeakSegR] = useState(0);
  const [clipHold, setClipHold] = useState(false);

  const peakTimerRef = useRef<{ lAt: number; rAt: number; lVal: number; rVal: number; clipAt: number }>({
    lAt: 0,
    rAt: 0,
    lVal: 0,
    rVal: 0,
    clipAt: 0,
  });

  useEffect(() => {
    if (!isPlaying || !activeMediaUrl) {
      setSnap(IDLE_METER_SNAPSHOT);
      setPeakSegL(0);
      setPeakSegR(0);
      setClipHold(false);
      return;
    }

    let rafId = 0;
    const tick = () => {
      const next = sampleAudioMeter(videoRef.current);
      const now = performance.now();
      const p = peakTimerRef.current;

      if (next.segmentsL >= p.lVal || now - p.lAt > 900) {
        p.lVal = next.segmentsL;
        p.lAt = now;
      }
      if (next.segmentsR >= p.rVal || now - p.rAt > 900) {
        p.rVal = next.segmentsR;
        p.rAt = now;
      }
      if (next.isClipping) {
        p.clipAt = now;
      }

      setSnap(next);
      setPeakSegL(p.lVal);
      setPeakSegR(p.rVal);
      setClipHold(next.isClipping || now - p.clipAt < 1200);
      rafId = window.requestAnimationFrame(tick);
    };

    rafId = window.requestAnimationFrame(tick);
    return () => {
      window.cancelAnimationFrame(rafId);
    };
  }, [isPlaying, activeMediaUrl, videoRef]);

  const lufsText = snap.active && snap.hasSignal ? `${snap.lufs.toFixed(1)} LUFS` : '-14 LUFS';
  const normReady = Boolean(activeSong?.has_normalized);

  return (
    <div className="meter-strip" data-testid="meter-strip">
      <div className="meter-leds">
        <span className="meter-led-tag">
          <span className={snap.hasSignal ? 'te-led green' : 'te-led off'} />
          SIG
        </span>
        <span className="meter-led-tag">
          <span className={clipHold ? 'te-led red' : 'te-led off'} />
          CLIP
        </span>
      </div>

      <div className="meter-bars">
        <div className="meter-ch-row">
          <span className="meter-ch-label">L</span>
          <div className="meter-seg-row">
            {SEGMENTS.map((idx) => {
              const lit = idx < snap.segmentsL;
              const isPeak = !lit && peakSegL > 0 && idx === peakSegL - 1;
              const zone = idx >= 20 ? 'hot' : idx >= 16 ? 'mid' : '';
              return (
                <span
                  key={idx}
                  className={`meter-seg ${zone}${lit ? ' lit' : ''}${isPeak ? ' peak' : ''}`}
                />
              );
            })}
          </div>
        </div>

        <div className="meter-ch-row">
          <span className="meter-ch-label">R</span>
          <div className="meter-seg-row">
            {SEGMENTS.map((idx) => {
              const lit = idx < snap.segmentsR;
              const isPeak = !lit && peakSegR > 0 && idx === peakSegR - 1;
              const zone = idx >= 20 ? 'hot' : idx >= 16 ? 'mid' : '';
              return (
                <span
                  key={idx}
                  className={`meter-seg ${zone}${lit ? ' lit' : ''}${isPeak ? ' peak' : ''}`}
                />
              );
            })}
          </div>
        </div>

        <div className="meter-scale">
          <span style={{ left: '0%' }}>-60</span>
          <span style={{ left: '54.5%', transform: 'translateX(-50%)' }}>-24</span>
          <span style={{ left: '72.7%', transform: 'translateX(-50%)' }}>-12</span>
          <span style={{ left: '81.8%', transform: 'translateX(-50%)' }}>-6</span>
          <span style={{ left: '90.9%', transform: 'translateX(-50%)' }}>0</span>
          <span style={{ right: '0%' }}>+6</span>
        </div>
      </div>

      <div className="meter-status">
        <span>{lufsText}</span>
        <span className={normReady ? 'te-led green' : 'te-led amber'} />
        <span>{normReady ? 'NORM READY' : 'RAW'}</span>
      </div>
    </div>
  );
}
