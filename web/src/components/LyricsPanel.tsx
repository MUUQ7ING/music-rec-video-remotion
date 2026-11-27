import { useEffect, useRef } from 'react';
import { useStudioStore } from '../state/useStudioStore';
import { fmtSec } from '../utils/time';
import { RotaryKnob } from './ui/RotaryKnob';
import { TactileButton } from './ui/TactileButton';

export function LyricsPanel() {
  const {
    activeSong,
    lyricsLines,
    loadingLyrics,
    activeLyricIdx,
    isPlaying,
    seekTo,
    nudgeLyricsOffset,
    resetLyricsOffset,
    alignLyricToCurrent,
    refetchLyrics,
  } = useStudioStore();

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const offset = Number(activeSong?.lyrics_offset) || 0;
  const offsetStr = `${offset >= 0 ? '+' : ''}${offset.toFixed(1)}s`;

  useEffect(() => {
    if (!isPlaying || activeLyricIdx < 0) return;
    const container = scrollRef.current;
    if (!container) return;
    const row = container.querySelector(`[data-lyric-idx="${activeLyricIdx}"]`);
    if (row) {
      row.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }, [activeLyricIdx, isPlaying]);

  return (
    <section className="panel-box lyrics-col" data-testid="lyrics-panel">
      <div className="panel-head">
        <span>BILINGUAL LYRICS SYNC</span>
        <div className="panel-head-group">
          <span data-testid="lyrics-offset-readout">{offsetStr}</span>
          <TactileButton
            size="xs"
            data-testid="lyrics-offset-minus"
            onClick={() => nudgeLyricsOffset(-0.2)}
          >
            -0.2
          </TactileButton>
          <TactileButton
            size="xs"
            data-testid="lyrics-offset-plus"
            onClick={() => nudgeLyricsOffset(0.2)}
          >
            +0.2
          </TactileButton>
          <TactileButton
            size="xs"
            data-testid="lyrics-offset-reset"
            onClick={() => resetLyricsOffset()}
          >
            0
          </TactileButton>
          <TactileButton
            size="xs"
            disabled={loadingLyrics}
            data-testid="lyrics-fetch-btn"
            onClick={() => refetchLyrics()}
          >
            拉取
          </TactileButton>
        </div>
        <RotaryKnob
          compact
          label="Lyrics offset"
          tone="green"
          min={-Math.max(5, Math.ceil(Math.abs(offset)))}
          max={Math.max(5, Math.ceil(Math.abs(offset)))}
          step={0.1}
          unit="s"
          value={offset}
          defaultValue={0}
          onChange={value => nudgeLyricsOffset(value - offset)}
        />
      </div>

      <div ref={scrollRef} className="lyrics-scroll">
        {loadingLyrics ? (
          <div className="lyrics-empty">LOADING LYRICS...</div>
        ) : lyricsLines.length === 0 ? (
          <div className="lyrics-empty">NO LYRICS LOADED</div>
        ) : (
          lyricsLines.map((ln, lIdx) => {
            const isActive = lIdx === activeLyricIdx;
            const isPrimaryAlign = isActive || (activeLyricIdx < 0 && lIdx === 0);
            const origText = ln.orig || ln.text || '';
            return (
              <div
                key={`${lIdx}-${ln.time}`}
                data-testid={`lyric-row-${lIdx}`}
                data-lyric-idx={lIdx}
                data-active={isActive ? 'true' : 'false'}
                className={isActive ? 'lyric-row active' : 'lyric-row'}
                onClick={() => seekTo(Math.max(0, (ln.time || 0) + offset))}
              >
                <span className="lyric-time">{fmtSec(ln.time || 0)}</span>
                <div className="lyric-text">
                  <div className="lyric-orig">{origText}</div>
                  {ln.trans ? <div className="lyric-trans">{ln.trans}</div> : null}
                </div>
                <TactileButton
                  size="xs"
                  data-testid={isPrimaryAlign ? 'lyrics-align-btn' : `lyrics-align-btn-${lIdx}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    alignLyricToCurrent(ln);
                  }}
                >
                  对齐
                </TactileButton>
              </div>
            );
          })
        )}
      </div>
    </section>
  );
}
