import { isPublicDemo } from '../api/publicDemo';
import { SourceMatrixView } from './SourceMatrixView';
import { StageFxView } from './StageFxView';
import { ColumnDivider } from '../components/ColumnDivider';
import { lazy, Suspense, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { LyricsPanel } from '../components/LyricsPanel';
import { MeterStrip } from '../components/MeterStrip';
import { ReasonPanel } from '../components/ReasonPanel';
import { TapeScrubber } from '../components/TapeScrubber';
import type { PlayerRef } from '@remotion/player';
import { SafeImage } from '../components/ui/SafeImage';
import { TactileButton } from '../components/ui/TactileButton';
import { useStudioStore } from '../state/useStudioStore';
import { releaseMeterGraph } from '../utils/audioMeter';
import { coverSrc, fmtSec, parseSec } from '../utils/time';

const TrackCompositionPreview = lazy(() => import('../components/TrackCompositionPreview'));

export function MonitorTrimView() {
  const {
    activeIdx,
    activeTab,
    activeSong,
    activeClips,
    activeClipIdx,
    activeClip,
    playlist,
    seekTo,
    onFxTimeUpdate,
    activeMediaUrl,
    trimCurrentSec,
    trimTotalSec,
    videoRef,
    switchTrimClip,
    addTrimClip,
    removeTrimClip,
    onVideoLoaded,
    onVideoTimeUpdate,
    onVideoPlayState,
    setActiveTab,
    downloadSingle,
  } = useStudioStore();

  const [showEffect, setShowEffect] = useState(isPublicDemo);
  const [effectPlaying, setEffectPlaying] = useState(false);
  const effectPlayer = useRef<PlayerRef>(null);

  useEffect(() => {
    if (!showEffect) return;
    const onSpace = (event: KeyboardEvent) => {
      if (event.code !== 'Space' || event.repeat || !effectPlayer.current ||
          (event.target instanceof Element && event.target.closest('input, textarea, select, button, [contenteditable], dialog'))) return;
      event.preventDefault();
      event.stopPropagation();
      effectPlayer.current.toggle();
    };
    window.addEventListener('keydown', onSpace, true);
    return () => window.removeEventListener('keydown', onSpace, true);
  }, [showEffect]);

  const seekEffect = (seconds: number) => {
    const player = effectPlayer.current;
    if (!player) return;
    const fps = playlist.fps || 60;
    const start = parseSec(activeClip?.start);
    const frames = Math.max(fps, Math.round((parseSec(activeClip?.end) - start) * fps));
    player.seekTo(Math.max(0, Math.min(frames - 1, Math.round((seconds - start) * fps))));
  };

  const initialSplit = (() => {
    const v = parseFloat(localStorage.getItem('mrv_side_split') || '50');
    return Number.isFinite(v) ? Math.max(22, Math.min(78, v)) : 50;
  })();

  const [sideSplitPct, setSideSplitPct] = useState(initialSplit);
  const [draggingSplit, setDraggingSplit] = useState(false);
  const sideStackRef = useRef<HTMLDivElement | null>(null);
  const draggingRef = useRef(false);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!draggingRef.current || !sideStackRef.current) return;
      const rect = sideStackRef.current.getBoundingClientRect();
      if (rect.height <= 0) return;
      const pct = Math.max(22, Math.min(78, ((e.clientY - rect.top) / rect.height) * 100));
      setSideSplitPct(Math.round(pct * 10) / 10);
    };
    const onUp = () => {
      if (!draggingRef.current) return;
      draggingRef.current = false;
      setDraggingSplit(false);
      setSideSplitPct((cur) => {
        localStorage.setItem('mrv_side_split', String(cur));
        return cur;
      });
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, []);

  useEffect(() => {
    const el = videoRef.current;
    return () => {
      releaseMeterGraph(el);
    };
  }, [activeMediaUrl, videoRef]);

  const startSplitDrag = (e: ReactMouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    draggingRef.current = true;
    setDraggingSplit(true);
  };

  const resetSideSplit = () => {
    setSideSplitPct(50);
    localStorage.setItem('mrv_side_split', '50');
  };

  const sideStackStyle = {
    gridTemplateRows: `calc(${sideSplitPct}% - var(--module-seam) / 2) var(--module-seam) calc(${100 - sideSplitPct}% - var(--module-seam) / 2)`,
  };

  return (
    <div className="deck-body fill-mode">
      <div className="trim-grid">
        <section className="monitor-col" aria-label="Monitor and trim">
          <div className="monitor-module-header">
            <h2>Monitor</h2>
            <TactileButton aria-pressed={showEffect} onClick={() => { videoRef.current?.pause(); if (showEffect) seekTo(trimCurrentSec); setEffectPlaying(false); setShowEffect(value => !value); }}>
              {showEffect ? 'Source Preview' : 'FX Preview'}
            </TactileButton>
          </div>
          <div className="clip-strip">
            {activeClips.map((clip, cIdx) => (
              <TactileButton customLayout
                key={cIdx}
                type="button"
                data-testid={`clip-pill-${cIdx}`}
                active={cIdx === activeClipIdx}
                aria-pressed={cIdx === activeClipIdx}
                className={cIdx === activeClipIdx ? 'clip-pill active' : 'clip-pill'}
                onClick={() => switchTrimClip(cIdx)}
              >
                <span>CLIP {cIdx + 1}</span>
                <span>
                  {clip.start}–{clip.end}
                </span>
              </TactileButton>
            ))}

            <TactileButton
              size="xs"
              data-testid="add-clip-btn"
              onClick={() => addTrimClip()}
            >
              + ADD CLIP
            </TactileButton>

            <TactileButton
              variant="danger"
              size="xs"
              disabled={activeClips.length <= 1}
              data-testid="del-clip-btn"
              onClick={() => removeTrimClip(activeClipIdx)}
            >
              DEL CLIP
            </TactileButton>

          </div>

          <div className="screen-bezel" hidden={showEffect}>
            <div className="screen-frame" data-testid="monitor-screen">
              <div className="screen-bar monitor-glass-heading">
                <div className="monitor-time">
                  <span className="monitor-playhead">{fmtSec(trimCurrentSec)}</span>
                  <span className="monitor-duration">/ {trimTotalSec > 0 ? fmtSec(trimTotalSec) : '—'}</span>
                </div>
                <span>Clip {activeClipIdx + 1}/{activeClips.length}</span>
              </div>

              <div className="screen-stage">
                {activeMediaUrl ? (
                  <video
                    key={activeMediaUrl}
                    ref={videoRef}
                    data-testid="monitor-video"
                    src={activeMediaUrl}
                    playsInline
                    preload="metadata"
                    onLoadedMetadata={() => onVideoLoaded()}
                    onTimeUpdate={() => onVideoTimeUpdate()}
                    onPlay={() => onVideoPlayState(true)}
                    onPause={() => onVideoPlayState(false)}
                    onEnded={() => onVideoPlayState(false)}
                  />
                ) : (
                  <div className="screen-empty">
                    <SafeImage
                      src={coverSrc(activeSong)}
                      alt={activeSong?.title || ''}
                      className="screen-empty-cover"
                      fallback={null}
                    />
                    <div className="mono">{isPublicDemo ? 'COVER ONLY · ONLINE DEMO' : `NO VIDEO SIGNAL FOR TRACK ${activeIdx + 1}`}</div>
                    {!isPublicDemo && <div className="empty-card-actions">
                      <TactileButton
                        size="sm"
                        onClick={() => setActiveTab('source')}
                      >
                        前往 02 SOURCE MATRIX
                      </TactileButton>
                      <TactileButton
                        variant="accent"
                        size="sm"
                        onClick={() => downloadSingle(activeIdx)}
                      >
                        队列下载 MV
                      </TactileButton>
                    </div>}
                  </div>
                )}
              </div>

              <MeterStrip />
            </div>
          </div>

          {showEffect && <div className="song-effect-preview"><Suspense fallback={<p>Loading FX preview…</p>}><TrackCompositionPreview transportRef={effectPlayer} onPlaybackChange={setEffectPlaying} onSourceTimeChange={onFxTimeUpdate} /></Suspense></div>}
          <TapeScrubber previewTransport={showEffect ? { playing: effectPlaying, toggle: () => effectPlayer.current?.toggle(), seek: seekEffect } : undefined} />
        </section>

        <div ref={sideStackRef} className="side-stack" style={activeTab === 'trim' ? sideStackStyle : { gridTemplateRows: 'minmax(0, 1fr)' }}>
          <ColumnDivider side="editor" />
          {activeTab !== 'trim' ? (
            <div className="song-inspector">
              {activeTab === 'source' ? <SourceMatrixView /> : <StageFxView embedded />}
            </div>
          ) : <>
          <LyricsPanel onPreviewSeek={showEffect ? seekEffect : undefined} />
          <div
            className={draggingSplit ? 'side-splitter active' : 'side-splitter'}
            data-testid="side-splitter"
            onMouseDown={startSplitDrag}
            onDoubleClick={resetSideSplit}
            title="拖拽调整歌词与文案区高度，双击恢复 50/50"
          />
          <ReasonPanel />
          </>}
        </div>
      </div>
    </div>
  );
}
