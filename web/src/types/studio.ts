export const RUNTIME_SONG_FIELDS = [
  'has_file',
  'file_size_mb',
  'has_cover',
  'has_normalized',
  'has_pre_rendered',
  'has_lyrics',
  'has_beat',
  'has_audio',
  'audio_size_mb',
] as const;

export type RuntimeSongField = (typeof RUNTIME_SONG_FIELDS)[number];

export type MediaSourceMode = 'auto' | 'video_url' | 'netease_cover' | 'local';
export type EffectiveSourceMode = 'video_url' | 'netease_cover' | 'local';
export type ReasonMode = 'auto' | 'manual';
export type ShadowBoostMode = 'auto' | 'normal' | 'strong';
export type IntroBgMode = 'black' | 'blur_first_song' | 'image';

export type TransitionStyle =
  | 'inherit'
  | 'cross_dissolve'
  | 'light_leak'
  | 'light_leak_neon'
  | 'whip_pan'
  | 'curtain_split'
  | 'blur_slide'
  | 'zoom_blur'
  | 'cross_zoom'
  | 'dip_to_black'
  | 'flash_white'
  | 'flip'
  | 'none';

export type VisualEffectMode =
  | 'auto'
  | 'none'
  | 'lyric_stage'
  | 'vinyl_spin'
  | 'flow_lyrics'
  | 'ken_burns'
  | 'cyber_hud'
  | 'waveform_aura';

export type VisualModifierId = 'beat_pulse' | 'float_3d' | 'glitch' | 'retro_crt';

export interface ResolutionConfig {
  width: number;
  height: number;
  [key: string]: unknown;
}

export interface IntroConfig {
  enabled: boolean;
  text: string;
  auto_duration: boolean;
  duration: number;
  bg_mode: IntroBgMode;
  bg_image: string;
  [key: string]: unknown;
}

export interface TransitionConfig {
  video_style: Exclude<TransitionStyle, 'inherit'> | string;
  video_duration: number;
  audio_duration: number;
  [key: string]: unknown;
}

export interface SongClip {
  start: string;
  end: string;
  reason: string;
  reason_mode: ReasonMode;
  reason_timings: number[];
  [key: string]: unknown;
}

export interface DetectedBright {
  index?: boolean;
  reason?: boolean;
  bottom?: boolean;
  [key: string]: unknown;
}

export interface SongRuntimeFields {
  has_file?: boolean;
  file_size_mb?: number;
  has_cover?: boolean;
  has_normalized?: boolean;
  has_pre_rendered?: boolean;
  has_lyrics?: boolean;
  has_beat?: boolean;
  has_audio?: boolean;
  audio_size_mb?: number;
}

export interface SongItem extends SongRuntimeFields {
  title: string;
  artist: string;
  album: string;
  netease_id: string;
  youtube_url: string;
  media_source: MediaSourceMode;
  start: string;
  end: string;
  clips: SongClip[];
  file_path: string;
  audio_path: string;
  normalized_path: string;
  cover_url: string;
  cover_path: string;
  reason: string;
  reason_mode: ReasonMode;
  reason_timings: number[];
  transition_style: TransitionStyle | string;
  visual_effect: VisualEffectMode | string;
  visual_modifiers: VisualModifierId[] | string[];
  display_index?: number | null;
  lyrics_path: string;
  lyrics_offset: number;
  lyrics_enabled: boolean;
  shadow_boost: ShadowBoostMode;
  detected_bright: DetectedBright;
  [key: string]: unknown;
}

export interface PlaylistConfig {
  output_sequence_name: string;
  resolution: ResolutionConfig;
  fps: number;
  intro: IntroConfig;
  transition: TransitionConfig;
  songs: SongItem[];
  [key: string]: unknown;
}

export interface StatusState {
  is_downloading: boolean;
  is_rendering: boolean;
  queue_count: number;
  current_song: string;
  logs: string[];
  progress_percent: number;
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
  text?: string;
  words?: LyricWord[];
}

export interface LyricsResponse {
  netease_id?: string;
  title?: string;
  artist?: string;
  has_translation?: boolean;
  has_word_timing?: boolean;
  lines: LyricLine[];
}

export type CandidatePlatform = 'all' | 'bilibili' | 'youtube';

export interface CandidateItem {
  id: string;
  title: string;
  uploader: string;
  duration_str: string;
  url: string;
  thumbnail: string;
  platform: 'bilibili' | 'youtube';
}

export interface BiliStatus {
  logged_in: boolean;
  uname: string;
  is_vip: boolean;
  vip_label: string;
}

export interface BiliQrGenerateResponse {
  qrcode_key: string;
  url: string;
}

export interface BiliQrPollResponse {
  status: 'waiting' | 'scanned' | 'expired' | 'success' | 'error';
  message: string;
  user?: BiliStatus;
}

export interface NeteaseAudioConfig {
  configured: boolean;
  api_url: string;
  api_key_masked: string;
  default_quality: string;
  qualities: string[];
}

export type SaveState = 'saved' | 'dirty' | 'error';
export type ActiveView = 'song' | 'intro';
export type WorkspaceTab = 'trim' | 'source' | 'stage';
export type RackFilter = 'all' | 'missing';
export type ThemeMode = 'light' | 'dark';

export interface ToastState {
  message: string;
  kind: 'info' | 'error' | 'success';
  persistent: boolean;
  showRetry: boolean;
}

export const TRANSITION_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'cross_dissolve', label: '交叉叠化 (Fade)' },
  { value: 'light_leak', label: '电影暖金漏光 (Light Leak)' },
  { value: 'light_leak_neon', label: '赛博霓虹漏光 (Neon Leak)' },
  { value: 'whip_pan', label: '高速甩镜横移 (Whip Pan)' },
  { value: 'curtain_split', label: '电影帷幕拉开 (Curtain)' },
  { value: 'blur_slide', label: '动态模糊滑入 (Blur Slide)' },
  { value: 'zoom_blur', label: '缩放模糊切入 (Zoom Blur)' },
  { value: 'cross_zoom', label: '交叉变焦 (Cross Zoom)' },
  { value: 'dip_to_black', label: '黑场过渡 (Dip Black)' },
  { value: 'flash_white', label: '闪白转场 (Flash White)' },
  { value: 'flip', label: '3D 翻转 (Flip)' },
  { value: 'none', label: '硬切 (None)' },
];

export const VISUAL_EFFECT_OPTIONS: Array<{ value: VisualEffectMode; label: string }> = [
  { value: 'auto', label: '自动 (MV无动效 / 封面鼓点)' },
  { value: 'none', label: '默认纯封面 / 原画面' },
  { value: 'lyric_stage', label: '侧立封面 + 滚动歌词' },
  { value: 'vinyl_spin', label: '黑胶唱片旋转' },
  { value: 'flow_lyrics', label: '流光歌词 (静态封面/光斑)' },
  { value: 'ken_burns', label: '电影推拉 (Ken Burns)' },
  { value: 'cyber_hud', label: '赛博频谱 (Cyber HUD)' },
  { value: 'waveform_aura', label: '声波光环 (Waveform Aura)' },
];

export const VISUAL_MODIFIER_OPTIONS: Array<{ id: VisualModifierId; label: string; code: string }> = [
  { id: 'beat_pulse', label: '鼓点脉冲', code: 'BEAT' },
  { id: 'float_3d', label: '3D 悬浮', code: '3D' },
  { id: 'glitch', label: '赛博故障', code: 'GLITCH' },
  { id: 'retro_crt', label: '复古胶片', code: 'CRT' },
];
