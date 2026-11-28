export interface ResolutionConfig {
  width: number;
  height: number;
}

export interface IntroConfig {
  enabled: boolean;
  text: string;
  auto_duration?: boolean;
  duration: number;
  bg_mode: 'black' | 'blur_first_song' | 'image';
  bg_image?: string;
}

export interface TransitionConfig {
  video_style: 'cross_dissolve' | 'dip_to_black' | 'none' | 'custom' | string;
  video_duration: number;
  audio_duration: number;
}

export interface DetectedBright {
  index?: boolean;
  reason?: boolean;
  bottom?: boolean;
}

export interface LyricWord {
  start: number;
  end: number;
  text: string;
}

export interface LyricLine {
  time: number;
  end?: number;
  orig: string;
  trans?: string;
  words?: LyricWord[];
}

export interface LyricsFile {
  netease_id?: string;
  title?: string;
  artist?: string;
  has_translation?: boolean;
  has_word_timing?: boolean;
  lines: LyricLine[];
}

export interface BeatFile {
  times?: number[];
  energies?: number[];
  [key: string]: unknown;
}

export interface SongClip {
  start: string | number;
  end: string | number;
  reason?: string;
  reason_mode?: 'auto' | 'manual';
  reason_timings?: number[];
  visual_effect?: string;
  visual_modifiers?: string[];
}

export interface SongItem {
  title: string;
  artist: string;
  album?: string;
  netease_id?: string;
  youtube_url?: string;
  media_source?: 'auto' | 'video_url' | 'netease_cover' | 'local';
  start: string | number;
  end: string | number;
  clips?: SongClip[];
  file_path?: string;
  audio_path?: string;
  normalized_path?: string;
  cover_url?: string;
  cover_path?: string;
  reason?: string;
  reason_mode?: 'auto' | 'manual';
  reason_timings?: number[];
  transition_style?: string;
  visual_effect?: string;
  visual_modifiers?: string[];
  display_index?: number | null;
  lyrics_path?: string;
  lyrics_offset?: number;
  lyrics_enabled?: boolean;
  shadow_boost?: 'auto' | 'normal' | 'strong';
  detected_bright?: DetectedBright;
}

export interface PlaylistConfig {
  output_sequence_name: string;
  resolution: ResolutionConfig;
  fps: number;
  intro: IntroConfig;
  transition: TransitionConfig;
  songs: SongItem[];
}

export type PlaylistVideoProps = {
  meterMix?: boolean;
  playlist: PlaylistConfig;
  mediaBaseUrl?: string;
  [key: string]: unknown;
};
