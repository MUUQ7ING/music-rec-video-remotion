import { useState } from 'react';
import { useStudioStore } from '../state/useStudioStore';
import { coverSrc, formatSongDuration } from '../utils/time';
import { SafeImage } from './ui/SafeImage';
import { Segmented } from './ui/Segmented';
import { TactileButton } from './ui/TactileButton';

export function TrackRack() {
  const {
    playlist,
    rackFilter,
    setRackFilter,
    filteredSongs,
    activeView,
    activeIdx,
    readyCount,
    missingCount,
    selectIntro,
    selectSong,
    addEmptySong,
    reorderSongs,
  } = useStudioStore();

  const [dragSrcIdx, setDragSrcIdx] = useState<number | null>(null);
  const [dragOverIdx, setDragOverIdx] = useState<number | null>(null);

  const totalCount = (playlist.songs || []).length;
  const introEnabled = Boolean(playlist.intro?.enabled);
  const introDur = Number(playlist.intro?.duration) || 8;

  return (
    <aside className="rack" data-testid="track-rack">
      <div className="rack-header">
        <span className="rack-title">TRACK RACK</span>
        <Segmented
          value={rackFilter}
          onChange={setRackFilter}
          options={[
            { value: 'all', label: 'ALL', testId: 'filter-all' },
            { value: 'missing', label: `MISS (${missingCount})`, testId: 'filter-miss' },
          ]}
        />
      </div>

      <div className="rack-list">
        <div
          role="button"
          tabIndex={0}
          data-testid="rack-intro"
          className={
            activeView === 'intro' ? 'rack-item intro-item active' : 'rack-item intro-item'
          }
          onClick={() => selectIntro()}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              selectIntro();
            }
          }}
        >
          <span className="rack-num">00</span>
          <div className="rack-thumb">INTRO</div>
          <div className="rack-meta">
            <div className="rack-song">开场白 &amp; 全局转场</div>
            <div className="rack-artist">
              {playlist.transition?.video_style || 'cross_dissolve'}
            </div>
          </div>
          <div className="rack-right">
            <span className="rack-dur">{introEnabled ? `${introDur}s` : 'OFF'}</span>
            <span className={introEnabled ? 'te-led green' : 'te-led off'} />
          </div>
        </div>

        {filteredSongs.map(({ song, idx }) => {
          const isActive = activeView === 'song' && activeIdx === idx;
          const isDragging = dragSrcIdx === idx;
          const isDragOver = dragOverIdx === idx && dragSrcIdx !== idx;
          const itemClasses = ['rack-item', 'rack-song-item'];
          if (isActive) itemClasses.push('active');
          if (isDragging) itemClasses.push('dragging');
          if (isDragOver) itemClasses.push('drag-over');

          const clipCount = Array.isArray(song.clips) ? song.clips.length : 0;

          return (
            <div
              key={`${idx}-${song.netease_id || song.title}`}
              role="button"
              tabIndex={0}
              draggable
              data-testid={`rack-song-${idx}`}
              className={itemClasses.join(' ')}
              onClick={() => selectSong(idx)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  selectSong(idx);
                }
              }}
              onDragStart={() => setDragSrcIdx(idx)}
              onDragOver={(e) => {
                e.preventDefault();
                setDragOverIdx(idx);
              }}
              onDragEnd={() => {
                setDragSrcIdx(null);
                setDragOverIdx(null);
              }}
              onDrop={(e) => {
                e.preventDefault();
                const from = dragSrcIdx;
                setDragSrcIdx(null);
                setDragOverIdx(null);
                if (from !== null && from !== idx) {
                  reorderSongs(from, idx);
                }
              }}
            >
              <span className="drag-grip" aria-hidden="true">
                ⋮⋮
              </span>
              <span className="rack-num">{String(idx + 1).padStart(2, '0')}</span>
              <div className="rack-thumb">
                <SafeImage
                  src={coverSrc(song)}
                  alt={song.title}
                  fallback={<span>NO IMG</span>}
                />
              </div>
              <div className="rack-meta">
                <div className="rack-song">{song.title || '未命名曲目'}</div>
                <div className="rack-artist">{song.artist || '未知歌手'}</div>
              </div>
              <div className="rack-right">
                <span className="rack-dur">
                  {formatSongDuration(song)}
                  {clipCount > 1 ? <span className="clip-tag">×{clipCount}</span> : null}
                </span>
                <div className="led-group">
                  <span className="led-cell" title="视频素材">
                    <span className={song.has_file ? 'te-led green' : 'te-led off'} />V
                  </span>
                  <span className="led-cell" title="-14 LUFS 响度标准化">
                    <span className={song.has_normalized ? 'te-led green' : 'te-led off'} />N
                  </span>
                  <span className="led-cell" title="双语歌词">
                    <span className={song.has_lyrics ? 'te-led green' : 'te-led off'} />L
                  </span>
                </div>
              </div>
            </div>
          );
        })}

        {rackFilter === 'missing' && filteredSongs.length === 0 ? (
          <div className="rack-empty-note">ALL TRACKS READY</div>
        ) : null}
      </div>

      <div className="rack-footer">
        <span>
          {readyCount}/{totalCount} READY · ↑↓ SWITCH
        </span>
        <TactileButton
          size="sm"
          data-testid="add-track-btn"
          onClick={() => addEmptySong()}
        >
          + NEW
        </TactileButton>
      </div>
    </aside>
  );
}
