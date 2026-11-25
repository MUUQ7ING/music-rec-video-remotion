import React from 'react';
import { random } from 'remotion';
import type { LyricsFile, LyricLine } from '../types';

interface FlowLyricsStageProps {
  lyrics?: LyricsFile | null;
  currentMediaSec: number;
}

interface WordShape {
  x: number;
  y: number;
  rotate: number;
  baseScale: number;
  drift: number;
}

interface TimedWord {
  text: string;
  hasTrailingSpace: boolean;
  startSec: number;
  endSec: number;
  shape: WordShape;
}

const LOOKAHEAD_SEC = 0.08;
const CJK_CHAR_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/;

export const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));

const easeOutCubic = (t: number): number => {
  const c = clamp01(t);
  return 1 - Math.pow(1 - c, 3);
};

// Damped spring matching mygo-music's springStep(t)
export const springStep = (t: number): number => {
  if (t <= 0) return 0;
  if (t >= 1.5) return 1;
  return 1 - Math.exp(-10 * t) * (Math.cos(10 * t) + Math.sin(10 * t));
};

function tokenizeLine(orig: string): { text: string; hasTrailingSpace: boolean }[] {
  const trimmed = orig.trim();
  if (!trimmed) return [];

  const tokens: { text: string; hasTrailingSpace: boolean }[] = [];
  let i = 0;

  while (i < trimmed.length) {
    const ch = trimmed[i];
    if (/\s/.test(ch)) {
      if (tokens.length > 0) {
        tokens[tokens.length - 1].hasTrailingSpace = true;
      }
      i += 1;
      continue;
    }

    if (CJK_CHAR_RE.test(ch)) {
      tokens.push({ text: ch, hasTrailingSpace: false });
      i += 1;
      continue;
    }

    // Collect Latin / numeric / punctuation run until whitespace or CJK character
    let end = i + 1;
    while (
      end < trimmed.length &&
      !/\s/.test(trimmed[end]) &&
      !CJK_CHAR_RE.test(trimmed[end])
    ) {
      end += 1;
    }
    tokens.push({ text: trimmed.slice(i, end), hasTrailingSpace: false });
    i = end;
  }

  return tokens;
}

function makeWordShape(lineSeedMs: number, idx: number): WordShape {
  const seedBase = `flow-${lineSeedMs}-${idx}`;
  return {
    x: (random(`${seedBase}-x`) - 0.5) * 32,
    y: (random(`${seedBase}-y`) - 0.5) * 26,
    rotate: (random(`${seedBase}-rot`) - 0.5) * 10,
    baseScale: 1.06 + random(`${seedBase}-scale`) * 0.16,
    drift: (random(`${seedBase}-drift`) - 0.5) * 12,
  };
}

function spreadWords(
  orig: string,
  lineStartSec: number,
  nextLineStartSec: number
): TimedWord[] {
  const rawTokens = tokenizeLine(orig);
  if (rawTokens.length === 0) return [];

  const rawGap = Math.max(0.8, nextLineStartSec - lineStartSec);
  // Cap active singing span so lines before long instrumental breaks don't stretch unnaturally
  const maxNaturalSpan = Math.max(2.2, Math.min(6.2, rawTokens.length * 0.34));
  const effectiveSpan = Math.min(rawGap, maxNaturalSpan);
  const wordDur = effectiveSpan / rawTokens.length;
  const lineSeedMs = Math.round(lineStartSec * 1000);

  return rawTokens.map((tok, idx) => {
    const startSec = lineStartSec + idx * wordDur;
    const endSec = startSec + Math.max(0.14, wordDur * 0.92);

    return {
      text: tok.text,
      hasTrailingSpace: tok.hasTrailingSpace,
      startSec,
      endSec,
      shape: makeWordShape(lineSeedMs, idx),
    };
  });
}

export function buildWordsFromLine(line: LyricLine, nextLineStartSec: number): TimedWord[] {
  if (!line.words || line.words.length === 0) {
    return spreadWords(line.orig, line.time, nextLineStartSec);
  }

  const lineSeedMs = Math.round(line.time * 1000);
  const result: TimedWord[] = [];

  for (const w of line.words) {
    const trimmedEnd = w.text.trimEnd();
    const hasTrailingSpace = w.text.length > trimmedEnd.length;
    const cleanText = trimmedEnd.trimStart();

    if (!cleanText) {
      if (result.length > 0) {
        result[result.length - 1].hasTrailingSpace = true;
      }
      continue;
    }

    const idx = result.length;
    result.push({
      text: cleanText,
      hasTrailingSpace,
      startSec: w.start,
      endSec: Math.max(w.start + 0.08, w.end),
      shape: makeWordShape(lineSeedMs, idx),
    });
  }

  return result.length > 0 ? result : spreadWords(line.orig, line.time, nextLineStartSec);
}

interface KineticLineProps {
  line: LyricLine;
  nextLineStartSec: number;
  currentMediaSec: number;
  lineOpacity: number;
  lineTranslateY: number;
}

const KineticLine: React.FC<KineticLineProps> = ({
  line,
  nextLineStartSec,
  currentMediaSec,
  lineOpacity,
  lineTranslateY,
}) => {
  const words = buildWordsFromLine(line, nextLineStartSec);
  const t = currentMediaSec + LOOKAHEAD_SEC;

  return (
    <div
      style={{
        position: 'absolute',
        left: 0,
        right: 0,
        top: '50%',
        transform: `translate3d(0, calc(-50% + ${lineTranslateY.toFixed(2)}px), 0)`,
        opacity: lineOpacity,
        display: 'flex',
        flexWrap: 'wrap',
        justifyContent: 'center',
        alignItems: 'center',
        rowGap: 14,
        columnGap: 2,
        padding: '12px 16px',
        willChange: 'transform, opacity',
      }}
    >
      {words.map((word, wIdx) => {
        let tx = word.shape.x;
        let ty = word.shape.y;
        let rot = word.shape.rotate;
        let scale = word.shape.baseScale;
        let opacity = 1;
        let blur = 0;
        let glowOpacity = 0;

        const waitOffsetX = word.shape.x + 24;
        const waitOffsetY = word.shape.y + 10;
        const waitRot = word.shape.rotate + 20;
        const popScale = word.shape.baseScale * 1.36;

        if (t < word.startSec) {
          // Waiting state
          tx = waitOffsetX;
          ty = waitOffsetY;
          rot = waitRot;
          scale = 0.5;
          opacity = 0;
          blur = 10;
          glowOpacity = 0;
        } else if (t < word.endSec) {
          // Singing state
          const elapsed = t - word.startSec;
          const s = springStep(elapsed);
          tx = waitOffsetX + (word.shape.x - waitOffsetX) * s;
          ty = waitOffsetY + (word.shape.y - waitOffsetY) * s;
          rot = waitRot + (word.shape.rotate - waitRot) * s;
          scale = 0.5 + (popScale - 0.5) * s;
          opacity = clamp01(elapsed / 0.1);
          blur = 10 * (1 - clamp01(elapsed / 0.2));
          glowOpacity = opacity * 0.85;
        } else {
          // Past state
          const pastElapsed = t - word.endSec;
          const settleP = easeOutCubic(pastElapsed / 0.5);
          const driftP = easeOutCubic(pastElapsed / 5.0);
          tx = word.shape.x;
          ty = word.shape.y;
          rot = word.shape.rotate + word.shape.drift * driftP;
          scale = popScale + (word.shape.baseScale - popScale) * settleP;
          opacity = 1 - 0.42 * easeOutCubic(pastElapsed / 0.8);
          blur = 0;
          glowOpacity = 0.85 * (1 - easeOutCubic(pastElapsed / 0.9));
        }

        const transformStr = `translate3d(${tx.toFixed(2)}px, ${ty.toFixed(2)}px, 0) rotate(${rot.toFixed(2)}deg) scale(${scale.toFixed(3)})`;
        const marginRight = word.hasTrailingSpace ? '0.32em' : '0.02em';

        return (
          <span
            key={wIdx}
            style={{
              position: 'relative',
              display: 'inline-block',
              marginRight,
              fontFamily:
                '"Noto Serif SC", "Source Han Serif SC", "Songti SC", serif',
              fontSize: 42,
              fontWeight: 900,
              lineHeight: 1.35,
              transform: transformStr,
              opacity,
              filter: blur > 0.05 ? `blur(${blur.toFixed(2)}px)` : undefined,
              willChange: 'transform, opacity, filter',
            }}
          >
            {/* Blurred glow layer underneath */}
            {glowOpacity > 0.01 ? (
              <span
                aria-hidden="true"
                style={{
                  position: 'absolute',
                  inset: 0,
                  color: 'rgba(255, 255, 255, 0.95)',
                  filter: 'blur(11px)',
                  opacity: glowOpacity,
                  pointerEvents: 'none',
                  userSelect: 'none',
                }}
              >
                {word.text}
              </span>
            ) : null}
            {/* Crisp foreground character / word */}
            <span
              style={{
                position: 'relative',
                color: '#ffffff',
                textShadow: '0 3px 16px rgba(0, 0, 0, 0.72)',
              }}
            >
              {word.text}
            </span>
          </span>
        );
      })}
    </div>
  );
};

export const FlowLyricsStage: React.FC<FlowLyricsStageProps> = ({
  lyrics,
  currentMediaSec,
}) => {
  const lines = lyrics?.lines ?? [];

  if (lines.length === 0) {
    return (
      <div
        style={{
          width: '100%',
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
    );
  }

  let activeIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].time <= currentMediaSec) {
      activeIdx = i;
    } else {
      break;
    }
  }

  const activeLine = activeIdx >= 0 ? lines[activeIdx] : undefined;
  const prevLine = activeIdx > 0 ? lines[activeIdx - 1] : undefined;
  const nextLine =
    activeIdx + 1 < lines.length ? lines[activeIdx + 1] : undefined;

  const activeNextStartSec = nextLine
    ? nextLine.time
    : (activeLine?.time ?? 0) + 4.5;

  const lineElapsed = activeLine
    ? Math.max(0, currentMediaSec - activeLine.time)
    : 0;

  // 0.4s smooth fade-out for previous line
  const showPrevLine = prevLine !== undefined && lineElapsed < 0.4;
  const prevFadeP = easeOutCubic(lineElapsed / 0.4);
  const prevOpacity = 1 - prevFadeP;
  const prevTranslateY = -30 * prevFadeP;

  // Interlude breathing dots: before first line (>1.5s) or during >4s gap after active line finishes
  const activeEstimatedEnd = activeLine
    ? (activeLine.end ??
        activeLine.time +
          Math.min(
            activeNextStartSec - activeLine.time,
            Math.max(2.2, Math.min(6.2, tokenizeLine(activeLine.orig).length * 0.34))
          ))
    : 0;
  const gapAfterActive = nextLine
    ? nextLine.time - (activeLine?.time ?? 0)
    : 0;
  const isBeforeFirstLine =
    activeIdx === -1 && lines[0].time - currentMediaSec > 1.2;
  const isMidInterlude =
    activeLine !== undefined &&
    nextLine !== undefined &&
    gapAfterActive > 4.0 &&
    currentMediaSec > activeEstimatedEnd + 1.0 &&
    nextLine.time - currentMediaSec > 0.9;
  const showInterlude = isBeforeFirstLine || isMidInterlude;

  const transOpacity = activeLine?.trans
    ? easeOutCubic(lineElapsed / 0.35)
    : 0;

  return (
    <div
      style={{
        position: 'relative',
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        alignItems: 'center',
      }}
    >
      {/* Main Kinetic Word Stage */}
      <div
        style={{
          position: 'relative',
          width: '100%',
          height: 280,
        }}
      >
        {showPrevLine && prevLine ? (
          <KineticLine
            key={`prev-${activeIdx - 1}`}
            line={prevLine}
            nextLineStartSec={activeLine ? activeLine.time : prevLine.time + 4}
            currentMediaSec={currentMediaSec}
            lineOpacity={prevOpacity}
            lineTranslateY={prevTranslateY}
          />
        ) : null}

        {activeLine ? (
          <KineticLine
            key={`active-${activeIdx}`}
            line={activeLine}
            nextLineStartSec={activeNextStartSec}
            currentMediaSec={currentMediaSec}
            lineOpacity={showInterlude ? 0.25 : 1}
            lineTranslateY={0}
          />
        ) : null}

        {showInterlude ? (
          <div
            style={{
              position: 'absolute',
              left: 0,
              right: 0,
              bottom: 12,
              display: 'flex',
              justifyContent: 'center',
              alignItems: 'center',
              gap: 14,
            }}
          >
            {[0, 1, 2].map((dotIdx) => {
              const pulse =
                0.5 + 0.5 * Math.sin(currentMediaSec * 2.6 - dotIdx * 0.85);
              return (
                <div
                  key={dotIdx}
                  style={{
                    width: 11,
                    height: 11,
                    borderRadius: '50%',
                    backgroundColor: '#ffffff',
                    opacity: 0.32 + pulse * 0.58,
                    transform: `scale(${(0.85 + pulse * 0.35).toFixed(3)})`,
                    boxShadow: '0 0 12px rgba(255, 255, 255, 0.45)',
                  }}
                />
              );
            })}
          </div>
        ) : null}
      </div>

      {/* Translation + Next Line Preview */}
      <div
        style={{
          width: '100%',
          minHeight: 96,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'flex-start',
          marginTop: 8,
          gap: 10,
        }}
      >
        {activeLine?.trans ? (
          <div
            style={{
              maxWidth: '92%',
              textAlign: 'center',
              fontFamily:
                '"Noto Serif SC", "Source Han Serif SC", "Songti SC", sans-serif',
              fontSize: 25,
              fontWeight: 500,
              lineHeight: 1.38,
              color: 'rgba(241, 245, 249, 0.94)',
              opacity: showInterlude ? 0.3 : transOpacity,
              textShadow: '0 2px 12px rgba(0, 0, 0, 0.78)',
            }}
          >
            {activeLine.trans}
          </div>
        ) : null}

        {nextLine?.orig ? (
          <div
            style={{
              maxWidth: '88%',
              textAlign: 'center',
              fontFamily:
                '"Noto Serif SC", "Source Han Serif SC", "Songti SC", sans-serif',
              fontSize: 20,
              fontWeight: 400,
              lineHeight: 1.35,
              color: 'rgba(226, 232, 240, 0.42)',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              textShadow: '0 2px 10px rgba(0, 0, 0, 0.65)',
            }}
          >
            {nextLine.orig}
          </div>
        ) : null}
      </div>
    </div>
  );
};
