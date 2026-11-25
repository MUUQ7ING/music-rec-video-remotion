import React, { useEffect, useMemo, useState } from 'react';
import {
  AbsoluteFill,
  Img,
  OffthreadVideo,
  continueRender,
  delayRender,
  interpolate,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';
import type { IntroConfig, LyricsFile, SongClip, SongItem } from '../types';
import {
  computeIntroTiming,
  computeReasonTimeline,
  pad2,
  parseTime,
  resolveAssetUrl,
  visualWidth,
} from '../utils/time';
import { AudioSpectrum } from './AudioSpectrum';
import { IntroCard } from './IntroCard';
import { VisualEffects } from './VisualEffects';

interface SongSegmentProps {
  song: SongItem;
  index: number;
  clipOverride?: SongClip;
  intro?: IntroConfig;
  audioInFrames?: number;
  audioOutFrames?: number;
  mediaBaseUrl?: string;
}

const SERIF_FONT =
  '"Noto Serif SC", "Source Han Serif SC", "Songti SC", "SimSun", serif';

function buildShadow(isBright: boolean, boost?: 'auto' | 'normal' | 'strong'): string {
  const strong = boost === 'strong' || (boost !== 'normal' && isBright);
  if (strong) {
    return '0 3px 16px rgba(0, 0, 0, 0.96), 0 1px 5px rgba(0, 0, 0, 0.98), 0 0 28px rgba(0, 0, 0, 0.75)';
  }
  return '0 2px 14px rgba(0, 0, 0, 0.85), 0 1px 3px rgba(0, 0, 0, 0.9)';
}

export const SongSegment: React.FC<SongSegmentProps> = ({
  song,
  index,
  clipOverride,
  intro,
  audioInFrames = 24,
  audioOutFrames = 48,
  mediaBaseUrl,
}) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();

  const [lyrics, setLyrics] = useState<LyricsFile | null>(null);
  const lyricsUrl = useMemo(
    () =>
      song.lyrics_enabled !== false && song.lyrics_path
        ? resolveAssetUrl(song.lyrics_path, mediaBaseUrl)
        : '',
    [song.lyrics_enabled, song.lyrics_path, mediaBaseUrl],
  );

  useEffect(() => {
    if (!lyricsUrl) {
      setLyrics(null);
      return;
    }
    const handle = delayRender(`Loading lyrics for ${song.title}`);
    let cancelled = false;
    fetch(lyricsUrl)
      .then((res) => (res.ok ? res.json() : null))
      .then((data: LyricsFile | null) => {
        if (!cancelled) {
          setLyrics(data);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setLyrics(null);
        }
      })
      .finally(() => {
        continueRender(handle);
      });
    return () => {
      cancelled = true;
    };
  }, [lyricsUrl, song.title]);

  const activeStart = clipOverride ? clipOverride.start : song.start;
  const activeReason =
    clipOverride && clipOverride.reason && clipOverride.reason.trim()
      ? clipOverride.reason
      : song.reason;
  const activeReasonMode =
    clipOverride && clipOverride.reason && clipOverride.reason.trim()
      ? clipOverride.reason_mode ?? song.reason_mode
      : song.reason_mode;
  const activeReasonTimings =
    clipOverride && clipOverride.reason && clipOverride.reason.trim()
      ? clipOverride.reason_timings ?? song.reason_timings
      : song.reason_timings;
  const startSec = parseTime(activeStart);
  const startFrom = Math.max(0, Math.round(startSec * fps));

  const videoPath = song.normalized_path || song.file_path;
  const videoUrl = resolveAssetUrl(videoPath, mediaBaseUrl);
  const coverUrl = resolveAssetUrl(song.cover_path, mediaBaseUrl) || song.cover_url || '';

  const hasIntro = Boolean(intro?.enabled && intro?.text?.trim());
  const introTotalSecs = hasIntro
    ? computeIntroTiming(intro!.text, intro!.auto_duration, intro!.duration).totalSecs
    : 0;
  const introFrames = hasIntro
    ? Math.min(durationInFrames - fps, Math.max(fps, Math.round(introTotalSecs * fps)))
    : 0;
  const uiStartFrame = hasIntro ? Math.max(0, introFrames - Math.round(0.25 * fps)) : 0;
  const uiElapsed = Math.max(0, frame - uiStartFrame);
  const uiDuration = Math.max(1, durationInFrames - uiStartFrame - 1);

  const fadeFrames = Math.round(0.35 * fps);
  const uiOpacity = interpolate(frame, [uiStartFrame, uiStartFrame + fadeFrames], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const barTranslateY = interpolate(frame, [uiStartFrame, uiStartFrame + fadeFrames], [18, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  const displayNum = song.display_index ?? index + 1;
  const indexText = `#${pad2(displayNum)}`;
  const progressPct = Math.min(100, Math.max(0, (uiElapsed / uiDuration) * 100));

  const reasonSlices = useMemo(
    () =>
      computeReasonTimeline(
        activeReason,
        activeReasonMode,
        activeReasonTimings,
        uiDuration,
        fps,
      ),
    [activeReason, activeReasonMode, activeReasonTimings, uiDuration, fps],
  );

  let currentReasonText = '';
  let reasonOpacity = uiOpacity;
  let reasonTranslateY = 0;
  if (reasonSlices.length === 1) {
    currentReasonText = reasonSlices[0].text;
  } else if (reasonSlices.length > 1) {
    let activeSlice = reasonSlices[reasonSlices.length - 1];
    for (let i = 0; i < reasonSlices.length; i++) {
      if (uiElapsed < reasonSlices[i].startFrame + reasonSlices[i].lengthFrames) {
        activeSlice = reasonSlices[i];
        break;
      }
    }
    if (uiElapsed >= activeSlice.startFrame) {
      currentReasonText = activeSlice.text;
      const localF = uiElapsed - activeSlice.startFrame;
      const inF = Math.min(Math.round(0.4 * fps), Math.floor(activeSlice.lengthFrames / 3));
      const outF = Math.min(Math.round(0.35 * fps), Math.floor(activeSlice.lengthFrames / 3));
      const isLastSlice = activeSlice === reasonSlices[reasonSlices.length - 1];
      const localAlpha = isLastSlice
        ? interpolate(localF, [0, inF], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' })
        : interpolate(
            localF,
            [0, inF, activeSlice.lengthFrames - outF, activeSlice.lengthFrames],
            [0, 1, 1, 0],
            { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' },
          );
      reasonOpacity = uiOpacity * localAlpha;
      reasonTranslateY = interpolate(localF, [0, inF], [10, 0], {
        extrapolateLeft: 'clamp',
        extrapolateRight: 'clamp',
      });
    } else {
      reasonOpacity = 0;
    }
  }

  const isBottomBright =
    song.shadow_boost === 'strong' ||
    (song.shadow_boost !== 'normal' && Boolean(song.detected_bright?.bottom));

  // Title marquee when title is long
  const isLongTitle = visualWidth(song.title) > 34;
  const titleContainerW = 880;
  const estimatedTitleW = visualWidth(song.title) * 23;
  const overflowPx = Math.max(0, estimatedTitleW - titleContainerW + 40);
  const marqueeOffset =
    isLongTitle && overflowPx > 0
      ? interpolate(
          uiElapsed,
          [Math.round(1.8 * fps), Math.max(Math.round(2.5 * fps), uiDuration - Math.round(1.8 * fps))],
          [0, -overflowPx],
          { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' },
        )
      : 0;

  // Active lyric lookup
  const currentMediaSec = startSec + frame / fps - (song.lyrics_offset ?? 0);
  const activeLyric = useMemo(() => {
    if (!lyrics?.lines?.length) return null;
    let current = null;
    for (let i = 0; i < lyrics.lines.length; i++) {
      if (lyrics.lines[i].time <= currentMediaSec) {
        current = lyrics.lines[i];
      } else {
        break;
      }
    }
    return current;
  }, [lyrics, currentMediaSec]);

  // Constant-power (sin/cos) audio fade-in & fade-out for seamless crossfades
  const computeVolume = (f: number): number => {
    let gain = 1;
    if (audioInFrames > 0 && f < audioInFrames) {
      const t = Math.max(0, Math.min(1, f / audioInFrames));
      gain *= Math.sin((t * Math.PI) / 2);
    }
    const remaining = durationInFrames - 1 - f;
    if (audioOutFrames > 0 && remaining < audioOutFrames) {
      const t = Math.max(0, Math.min(1, remaining / audioOutFrames));
      gain *= Math.sin((t * Math.PI) / 2);
    }
    return gain;
  };

  return (
    <AbsoluteFill style={{ backgroundColor: '#000000' }}>
      {/* V1: Base MV Video (wrapped in optional cover/beat/glitch visual effect) */}
      <VisualEffects
        effect={song.visual_effect}
        audioSrc={videoUrl}
        startSec={startSec}
        coverUrl={coverUrl}
        lyrics={lyrics}
        currentMediaSec={currentMediaSec}
      >
        {videoUrl ? (
          <OffthreadVideo
            src={videoUrl}
            startFrom={startFrom}
            volume={computeVolume}
            style={{ width: '100%', height: '100%', objectFit: 'cover' }}
          />
        ) : coverUrl ? (
          <Img
            src={coverUrl}
            style={{ width: '100%', height: '100%', objectFit: 'cover' }}
          />
        ) : null}
      </VisualEffects>

      {/* Optional Intro overlay over the continuously playing first song */}
      {hasIntro && intro ? (
        <IntroCard
          intro={intro}
          introFrames={introFrames}
          mediaBaseUrl={mediaBaseUrl}
        />
      ) : null}

      {/* Top-left #Index */}
      <div
        style={{
          position: 'absolute',
          left: 34,
          top: 30,
          fontFamily: SERIF_FONT,
          fontSize: 82,
          fontWeight: 600,
          lineHeight: 1.05,
          color: '#ffffff',
          letterSpacing: '0.02em',
          textShadow: buildShadow(Boolean(song.detected_bright?.index), song.shadow_boost),
          opacity: uiOpacity,
        }}
      >
        {indexText}
      </div>

      {/* Top-right Recommendation Reason (supports multi-paragraph auto or manual timing) */}
      {currentReasonText ? (
        <div
          style={{
            position: 'absolute',
            right: 36,
            top: 38,
            maxWidth: 1200,
            fontFamily: SERIF_FONT,
            fontSize: 40,
            fontWeight: 600,
            lineHeight: 1.4,
            color: '#ffffff',
            textAlign: 'right',
            whiteSpace: 'pre-wrap',
            letterSpacing: '0.02em',
            textShadow: buildShadow(Boolean(song.detected_bright?.reason), song.shadow_boost),
            opacity: reasonOpacity,
            transform: `translateY(${reasonTranslateY}px)`,
          }}
        >
          {currentReasonText}
        </div>
      ) : null}

      {/* Floating Frosted-Glass Bottom Bar (X=28..1892, Y=870..1056) */}
      <div
        style={{
          position: 'absolute',
          left: 28,
          bottom: 24,
          width: 1864,
          height: 186,
          borderRadius: 12,
          overflow: 'hidden',
          backgroundColor: isBottomBright
            ? 'rgba(10, 12, 16, 0.58)'
            : 'rgba(12, 14, 18, 0.36)',
          backdropFilter: 'blur(26px) saturate(140%)',
          WebkitBackdropFilter: 'blur(26px) saturate(140%)',
          border: '1px solid rgba(255, 255, 255, 0.16)',
          boxShadow: '0 10px 36px rgba(0, 0, 0, 0.45)',
          opacity: uiOpacity,
          transform: `translateY(${barTranslateY}px)`,
        }}
      >
        {/* Left 1:1 Album Cover (186x186) + Bottom Audio Spectrum */}
        <div
          style={{
            position: 'absolute',
            left: 0,
            top: 0,
            width: 186,
            height: 186,
            backgroundColor: '#18181b',
            overflow: 'hidden',
          }}
        >
          {coverUrl ? (
            <Img
              src={coverUrl}
              style={{ width: '100%', height: '100%', objectFit: 'cover' }}
            />
          ) : null}
          {videoUrl ? (
            <div style={{ position: 'absolute', left: 0, bottom: 0, width: 186, height: 68 }}>
              <AudioSpectrum audioSrc={videoUrl} startSec={startSec} width={186} height={68} />
            </div>
          ) : null}
        </div>

        {/* Song Metadata (3 lines) */}
        <div
          style={{
            position: 'absolute',
            left: 214,
            top: 22,
            width: titleContainerW,
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
          }}
        >
          <div
            style={{
              width: titleContainerW,
              overflow: 'hidden',
              whiteSpace: 'nowrap',
              maskImage:
                isLongTitle && overflowPx > 0
                  ? 'linear-gradient(to right, black 0%, black 93%, transparent 100%)'
                  : undefined,
              WebkitMaskImage:
                isLongTitle && overflowPx > 0
                  ? 'linear-gradient(to right, black 0%, black 93%, transparent 100%)'
                  : undefined,
            }}
          >
            <div
              style={{
                display: 'inline-block',
                fontFamily: SERIF_FONT,
                fontSize: 44,
                fontWeight: 600,
                lineHeight: 1.2,
                color: '#ffffff',
                letterSpacing: '0.015em',
                textShadow: buildShadow(isBottomBright, song.shadow_boost),
                transform: `translateX(${marqueeOffset}px)`,
              }}
            >
              {song.title}
            </div>
          </div>

          {song.album ? (
            <div
              style={{
                fontFamily: SERIF_FONT,
                fontSize: 26,
                fontWeight: 500,
                lineHeight: 1.25,
                color: 'rgba(235, 240, 250, 0.92)',
                letterSpacing: '0.02em',
                textShadow: buildShadow(isBottomBright, song.shadow_boost),
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
            >
              {song.album}
            </div>
          ) : null}

          <div
            style={{
              fontFamily: SERIF_FONT,
              fontSize: 24,
              fontWeight: 500,
              lineHeight: 1.25,
              color: 'rgba(219, 230, 242, 0.86)',
              letterSpacing: '0.025em',
              textShadow: buildShadow(isBottomBright, song.shadow_boost),
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {song.artist}
          </div>
        </div>

        {/* Bottom-right Bilingual Lyrics (hidden when lyric_stage already displays full scrolling lyrics) */}
        {activeLyric && song.visual_effect !== 'lyric_stage' ? (
          <div
            style={{
              position: 'absolute',
              right: 26,
              bottom: 24,
              maxWidth: 740,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'flex-end',
              gap: 6,
            }}
          >
            <div
              style={{
                fontFamily: SERIF_FONT,
                fontSize: 30,
                fontWeight: 500,
                lineHeight: 1.25,
                color: '#ffffff',
                textAlign: 'right',
                textShadow: buildShadow(isBottomBright, song.shadow_boost),
              }}
            >
              {activeLyric.orig}
            </div>
            {activeLyric.trans ? (
              <div
                style={{
                  fontFamily: SERIF_FONT,
                  fontSize: 24,
                  fontWeight: 400,
                  lineHeight: 1.25,
                  color: 'rgba(235, 240, 250, 0.88)',
                  textAlign: 'right',
                  textShadow: buildShadow(isBottomBright, song.shadow_boost),
                }}
              >
                {activeLyric.trans}
              </div>
            ) : null}
          </div>
        ) : null}

        {/* Real-time 60fps Progress Bar along bottom edge of glass bar */}
        <div
          style={{
            position: 'absolute',
            left: 186,
            right: 0,
            bottom: 0,
            height: 4,
            backgroundColor: 'rgba(255, 255, 255, 0.14)',
          }}
        >
          <div
            style={{
              width: `${progressPct}%`,
              height: '100%',
              backgroundColor: 'rgba(255, 255, 255, 0.9)',
              boxShadow: '0 0 8px rgba(255, 255, 255, 0.55)',
            }}
          />
        </div>
      </div>
    </AbsoluteFill>
  );
};
