import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { Player, type PlayerRef } from '@remotion/player';
import { SequenceMix, type MixReading } from './SequenceMix';
import { AudioMeter } from './ui/Hardware';
import { TRANSITION_OPTIONS } from '../types/studio';
import { fmtSec } from '../utils/time';
import { expandPlaylistSegments } from '../../../remotion/src/utils/segments';
import type { PlaylistConfig } from '../../../remotion/src/types';
import { useStudioStore } from '../state/useStudioStore';
import { IntroGlobalView } from '../views/IntroGlobalView';
import { StageFxView } from '../views/StageFxView';
import { TactileButton } from './ui/TactileButton';
import { SafeImage } from './ui/SafeImage';
import { Bay } from './ui/Bay';

export default function TrackCompositionPreview({ full = false, transportRef, onPlaybackChange }: {
  full?: boolean;
  transportRef?: RefObject<PlayerRef | null>;
  onPlaybackChange?: (playing: boolean) => void;
}) {
  const { playlist, activeSong, activeClip, activeClipIdx, activeIdx, activeView, selectSong, trimLoopPlaying, updateActiveSongField, saveMeta } = useStudioStore();
  const localPlayer = useRef<PlayerRef>(null);
  const player = transportRef ?? localPlayer;
  const pendingSegment = useRef<{ song: number; frame: number } | null>(null);
  const [position, setPosition] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [mix, setMix] = useState<MixReading | null>(null);
  const [transition, setTransition] = useState<number | null>(null);
  const [selected, setSelected] = useState(-1);
  const inputProps = useMemo(() => {
    const composition: PlaylistConfig = {
      ...playlist,
      intro: full ? playlist.intro : { ...playlist.intro, enabled: false },
      songs: (full ? playlist.songs : activeSong ? [{
        ...activeSong,
        clips: activeClip ? [activeClip] : activeSong.clips,
      }] : []).map(song => ({
        ...song,
        normalized_path: song.has_normalized ? song.normalized_path : '',
        file_path: song.has_file ? song.file_path : '',
        audio_path: song.has_audio ? song.audio_path : '',
        cover_path: song.has_cover ? song.cover_path : '',
        lyrics_path: song.has_lyrics ? song.lyrics_path : '',
      })),
    };
    return { playlist: composition, mediaBaseUrl: '/api/composition-media' };
  }, [playlist, activeSong, activeClip, full]);
  const fps = playlist.fps || 60;
  const segments = useMemo(() => {
    let frame = 0;
    return expandPlaylistSegments(inputProps.playlist, fps).map(segment => {
      const start = frame;
      frame += segment.durationFrames - segment.transitionAfterFrames;
      return { ...segment, start, next: frame };
    });
  }, [inputProps, fps]);
  const frames = segments.at(-1)?.next ?? 0;
  const songStart = segments.find(segment => segment.songIndex === activeIdx)?.start;
  const songStartRef = useRef(songStart);
  songStartRef.current = songStart;
  useEffect(() => {
    if (!full) return;
    if (pendingSegment.current && activeView === 'song' && pendingSegment.current.song === activeIdx) {
      player.current?.seekTo(pendingSegment.current.frame);
      pendingSegment.current = null;
      return;
    }
    player.current?.seekTo(activeView === 'intro' ? 0 : songStartRef.current ?? 0);
    setSelected(-1);
    setTransition(null);
  }, [full, activeIdx, activeView, player]);
  useEffect(() => {
    const instance = player.current;
    if (!instance || !onPlaybackChange) return;
    const play = () => onPlaybackChange(true);
    const pause = () => onPlaybackChange(false);
    pause();
    instance.addEventListener('play', play);
    instance.addEventListener('pause', pause);
    instance.addEventListener('ended', pause);
    return () => {
      instance.removeEventListener('play', play);
      instance.removeEventListener('pause', pause);
      instance.removeEventListener('ended', pause);
    };
  }, [player, onPlaybackChange, activeIdx, activeClipIdx, activeSong?.has_file, activeSong?.has_normalized, activeSong?.has_audio]);

  useEffect(() => {
    const instance = player.current;
    if (!full || !instance) return;
    const sync = () => setPosition(instance.getCurrentFrame());
    const play = () => setPlaying(true);
    const pause = () => setPlaying(false);
    sync();
    instance.addEventListener('frameupdate', sync);
    instance.addEventListener('seeked', sync);
    instance.addEventListener('play', play);
    instance.addEventListener('pause', pause);
    instance.addEventListener('ended', pause);
    return () => {
      instance.removeEventListener('frameupdate', sync);
      instance.removeEventListener('seeked', sync);
      instance.removeEventListener('play', play);
      instance.removeEventListener('pause', pause);
      instance.removeEventListener('ended', pause);
    };
  }, [full, player]);

  const jumpTo = (index: number, boundary: boolean) => {
    const segment = segments[index];
    if (!segment) return;
    setSelected(index);
    setTransition(boundary ? index : null);
    const frame = boundary ? Math.max(0, segment.start - Math.round(fps / 2)) : segment.start;
    if (segment.songIndex !== activeIdx || activeView !== 'song') {
      pendingSegment.current = { song: segment.songIndex, frame };
      selectSong(segment.songIndex);
    } else {
      player.current?.seekTo(frame);
    }
  };

  const chosen = segments[selected] ?? segments.find(segment => segment.songIndex === activeIdx);
  const incoming = transition === null ? undefined : segments[transition];
  const outgoing = transition === null ? undefined : segments[transition - 1];

  const width = playlist.resolution?.width || 1920;
  const height = playlist.resolution?.height || 1080;

  const preview = (
    <Bay title={full ? "Sequence Preview" : "FX Preview"}>
      {full || activeSong?.has_file || activeSong?.has_normalized || activeSong?.has_audio ? (
        <Player
          ref={player}
          key={full ? "full" : `${activeIdx}-${activeClipIdx}`}
          component={SequenceMix}
          inputProps={{ ...inputProps, onMix: full ? setMix : undefined }}
          durationInFrames={Math.max(1, frames)}
          compositionWidth={width}
          compositionHeight={height}
          fps={fps}
          controls={!full && !transportRef}
          clickToPlay={!full && !transportRef}
          spaceKeyToPlayOrPause={!full && !transportRef}
          loop={Boolean(transportRef && trimLoopPlaying)}
          style={{ width: '100%', aspectRatio: width / height }}
        />
      ) : <span>添加本地素材后可预览效果。</span>}
    </Bay>
  );

  if (!full) return preview;

  return (
    <div className="deck-body full-edit">
      <div className="sequence-monitor">
        <div className="sequence-glass">
          <div className="sequence-time"><strong>{fmtSec(position / fps)}</strong> / {fmtSec(frames / fps)}</div>
          {preview}
          <div className="sequence-meters" aria-label="Composition mix">
            <AudioMeter label="L" db={Math.round(mix?.left ?? -60)} />
            <AudioMeter label="R" db={Math.round(mix?.right ?? -60)} />
            <span>{mix ? (mix.clip ? 'CLIP · dBFS' : 'Mix · dBFS') : 'Mix meter unavailable'}</span>
          </div>
        </div>
        <Bay title="Sequence Tape">
          <div className="sequence-tape-track">
            <div className="sequence-tape-progress" style={{ width: `${Math.min(100, position / Math.max(1, frames - 1) * 100)}%` }} />
            <input className="sequence-scrub" type="range" aria-label="Sequence playhead" min={0} max={Math.max(0, frames - 1)} value={Math.min(position, Math.max(0, frames - 1))} onChange={event => player.current?.seekTo(Number(event.target.value))} />
          </div>
          <div className="full-timeline" role="group" aria-label="Sequence clips">
            {segments.map((segment, index) => (
              <div className="sequence-segment" key={index}>
                {index > 0 && <TactileButton size="xs" aria-label={`Transition into ${segment.song.title}`} aria-pressed={transition === index} onClick={() => jumpTo(index, true)}>⇄</TactileButton>}
                <TactileButton
                  className="sequence-cover-key"
                  aria-label={`${segment.song.title} · Clip ${segment.clipIndex + 1}`}
                  title={`${fmtSec(segment.start / fps)} · ${segment.song.title}`}
                  aria-pressed={selected === index && transition === null}
                  onClick={() => jumpTo(index, false)}
                >
                  <SafeImage
                    src={segment.song.cover_path ? `/api/composition-media/${segment.song.cover_path}` : segment.song.cover_url || ''}
                    alt=""
                    fallback={<span className="sequence-cover-blank" aria-hidden="true" />}
                  />
                </TactileButton>
              </div>
            ))}
          </div>
          <TactileButton variant="dark" onClick={event => player.current?.toggle(event)}>{playing ? 'Pause' : 'Play'}</TactileButton>
        </Bay>
      </div>
      <div className="full-inspector song-inspector">
        {activeView === 'intro' ? <IntroGlobalView /> : incoming && outgoing ? (
          <Bay title="Transition">
            <p>{outgoing.song.title} → {incoming.song.title}</p>
            <p>{outgoing.transitionAfterStyle !== 'none' ? outgoing.transitionAfterStyle : outgoing.overlayAfterStyle} · {((outgoing.transitionAfterFrames || outgoing.overlayAfterFrames) / fps).toFixed(2)} s</p>
            {outgoing.songIndex === incoming.songIndex ? <p>Cross-dissolve between clips</p> : (
              <>
                <select className="te-select" aria-label="Transition style" value={activeSong?.transition_style || 'inherit'} onChange={event => updateActiveSongField('transition_style', event.target.value)}>
                  <option value="inherit">Use sequence default</option>
                  {TRANSITION_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
                </select>
                <TactileButton onClick={() => saveMeta()}>Save Changes</TactileButton>
              </>
            )}
          </Bay>
        ) : <>
          {chosen && <Bay title="Selected Clip">
            <strong>{chosen.song.title}</strong>
            <p>Sequence {fmtSec(chosen.start / fps)}–{fmtSec((chosen.start + chosen.durationFrames) / fps)}</p>
            <p>Source {chosen.clip.start}–{chosen.clip.end}</p>
          </Bay>}
          <StageFxView embedded />
        </>}
      </div>
    </div>
  );
}
