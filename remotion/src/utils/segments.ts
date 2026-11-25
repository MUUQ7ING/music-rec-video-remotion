import type { PlaylistConfig, SongClip, SongItem } from '../types';
import { getSongDurationSecs } from './time';

export interface ExpandedSegment {
  song: SongItem;
  songIndex: number;
  clipIndex: number;
  clip: SongClip;
  durationFrames: number;
  transitionAfterStyle: string;
  transitionAfterFrames: number;
  overlayAfterStyle: string;
  overlayAfterFrames: number;
  audioInFrames: number;
  audioOutFrames: number;
}

export function expandPlaylistSegments(
  playlist: PlaylistConfig,
  fps: number,
): ExpandedSegment[] {
  const songs = playlist.songs || [];
  const defaultStyle = playlist.transition?.video_style || 'cross_dissolve';
  const defaultSecs = Math.max(0, playlist.transition?.video_duration ?? 0.6);
  const audioSecs = Math.max(0, playlist.transition?.audio_duration ?? 0.8);
  const innerClipSecs = 0.35;

  const flat: Array<{
    song: SongItem;
    songIndex: number;
    clipIndex: number;
    clip: SongClip;
    durationFrames: number;
  }> = [];

  songs.forEach((song, songIndex) => {
    const clips: SongClip[] =
      song.clips && song.clips.length > 0
        ? song.clips
        : [
            {
              start: song.start,
              end: song.end,
              reason: song.reason,
              reason_mode: song.reason_mode,
              reason_timings: song.reason_timings,
            },
          ];

    clips.forEach((clip, clipIndex) => {
      const secs = getSongDurationSecs(clip.start, clip.end);
      flat.push({
        song,
        songIndex,
        clipIndex,
        clip,
        durationFrames: Math.max(fps, Math.round(secs * fps)),
      });
    });
  });

  return flat.map((item, idx) => {
    const prev = idx > 0 ? flat[idx - 1] : null;
    const next = idx < flat.length - 1 ? flat[idx + 1] : null;

    const audioInFrames = !prev
      ? Math.round(0.35 * fps)
      : prev.songIndex === item.songIndex
        ? Math.round(innerClipSecs * fps)
        : Math.round(audioSecs * fps);

    const audioOutFrames = !next
      ? Math.round(Math.max(audioSecs, 1.0) * fps)
      : next.songIndex === item.songIndex
        ? Math.round(innerClipSecs * fps)
        : Math.round(audioSecs * fps);

    if (!next) {
      return {
        ...item,
        transitionAfterStyle: 'none',
        transitionAfterFrames: 0,
        overlayAfterStyle: 'none',
        overlayAfterFrames: 0,
        audioInFrames,
        audioOutFrames,
      };
    }

    // Same song multi-clip boundary -> 0.35s short cross-dissolve
    if (next.songIndex === item.songIndex) {
      return {
        ...item,
        transitionAfterStyle: 'cross_dissolve',
        transitionAfterFrames: Math.round(innerClipSecs * fps),
        overlayAfterStyle: 'none',
        overlayAfterFrames: 0,
        audioInFrames,
        audioOutFrames,
      };
    }

    // Song-to-song boundary -> per-song override or global default
    const style =
      next.song.transition_style && next.song.transition_style !== 'inherit'
        ? next.song.transition_style
        : defaultStyle;

    // Light leak uses TransitionSeries.Overlay (does not shorten timeline)
    if (style === 'light_leak' || style === 'light_leak_neon') {
      return {
        ...item,
        transitionAfterStyle: 'none',
        transitionAfterFrames: 0,
        overlayAfterStyle: style,
        overlayAfterFrames: Math.round(Math.max(defaultSecs, 0.7) * fps),
        audioInFrames,
        audioOutFrames,
      };
    }

    const frames = style === 'none' ? 0 : Math.round(defaultSecs * fps);
    return {
      ...item,
      transitionAfterStyle: style,
      transitionAfterFrames: frames,
      overlayAfterStyle: 'none',
      overlayAfterFrames: 0,
      audioInFrames,
      audioOutFrames,
    };
  });
}

export function getIntroTransitionFrames(
  playlist: PlaylistConfig,
  fps: number,
): { style: string; frames: number } {
  const songs = playlist.songs || [];
  if (songs.length === 0) return { style: 'none', frames: 0 };
  const defaultStyle = playlist.transition?.video_style || 'cross_dissolve';
  const defaultSecs = Math.max(0, playlist.transition?.video_duration ?? 0.6);
  const firstStyle =
    songs[0].transition_style && songs[0].transition_style !== 'inherit'
      ? songs[0].transition_style
      : defaultStyle;
  return {
    style: firstStyle,
    frames: firstStyle === 'none' ? 0 : Math.round(defaultSecs * fps),
  };
}
