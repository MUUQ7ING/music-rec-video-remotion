import { isPublicDemo } from '../api/publicDemo';
import { ProjectSelector } from './ProjectSelector';
import { useEffect, useRef, useState } from 'react';
import { PixelIcon } from './ui/PixelIcon';
import { useStudioStore } from '../state/useStudioStore';
import { BatchDrawer } from './BatchDrawer';
import { TactileButton } from './ui/TactileButton';

export function Topbar({ fullEdit, onToggleFullEdit }: { fullEdit: boolean; onToggleFullEdit: () => void }) {
  const {
    theme,
    toggleTheme,
    playlist,
    setSequenceName,
    saveState,
    dirty,
    isSaving,
    activeView,
    activeTab,
    applyTrimAndSave,
    savePlaylist,
    totalDurationStr,
    status,
    biliUser,
    neteaseAudioCfg,
    showTools,
    setShowTools,
    openingStudio,
    openRemotionStudio,
    renderRemotionVideo,
    cancelRemotionRender,
  } = useStudioStore();

  const [studioUrl, setStudioUrl] = useState<string>();
  const studioDialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    if (studioUrl && !studioDialog.current?.open) studioDialog.current?.showModal();
  }, [studioUrl]);

  const songs = playlist.songs || [];
  const height = playlist.resolution?.height || 1080;
  const fps = playlist.fps || 60;

  const chipClasses = ['save-chip'];
  if (dirty || saveState !== 'saved') chipClasses.push('dirty');
  if (saveState === 'error') chipClasses.push('error');

  const ledTone =
    saveState === 'error' ? 'red' : saveState === 'dirty' || dirty ? 'accent' : 'green';
  const chipLabel =
    isSaving
      ? 'SAVING'
      : saveState === 'error'
        ? 'SAVE ERR'
        : saveState === 'dirty' || dirty
          ? 'UNSAVED'
          : 'SAVED';

  const handleChipClick = () => {
    if (activeView === 'song' && activeTab === 'trim') {
      applyTrimAndSave();
    } else {
      savePlaylist({ silent: false });
    }
  };

  const authReady = biliUser.logged_in && neteaseAudioCfg.configured;

  return (
    <header className="topbar">
      <div className="topbar-left">
        <div className="brand-plate" data-testid="brand-plate">
          <span className="brand-name">MRV<span>–</span>02</span>
          <span className="brand-caption">{isPublicDemo ? 'Workstation · Online Demo' : 'Music Video Workstation'}</span>
        </div>

        {!isPublicDemo && <ProjectSelector />}

        <input
          type="text"
          className="seq-input"
          data-testid="seq-name-input"
          aria-label="输出序列名称"
          value={playlist.output_sequence_name || ''}
          onChange={(e) => setSequenceName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              (e.currentTarget as HTMLInputElement).blur();
              savePlaylist({ silent: true });
            }
          }}
          placeholder="输出序列名称"
        />

        <TactileButton customLayout
          type="button"
          className={chipClasses.join(' ')}
          data-testid="save-chip"
          data-state={saveState}
          onClick={handleChipClick}
          title={saveState === 'error' ? '点击重试保存' : '保存配置 (Cmd/Ctrl+S)'}
        >
          <span className={`te-led ${ledTone}`} />
          <span>{chipLabel}</span>
        </TactileButton>

        <span className="spec-pill" data-testid="spec-pill">
          {songs.length} TRK · {totalDurationStr} · {height}P/{fps}FPS
        </span>
      </div>

      <div className="topbar-right">
        <TactileButton
          variant="default"
          size="icon"
          data-testid="theme-toggle"
          onClick={toggleTheme}
          title={theme === 'light' ? '切换深色面板' : '切换浅色面板'}
          aria-label="切换主题"
        >
          <PixelIcon name={theme === 'light' ? 'moon' : 'sun'} />
        </TactileButton>

        {!isPublicDemo && (
          <div className="tools-wrap">
            <TactileButton
              variant="default"
              active={showTools}
              led={authReady ? 'green' : 'amber'}
              data-testid="batch-menu-btn"
              onClick={() => setShowTools((prev) => !prev)}
            >
              <span>≡ BATCH</span>
              {status.queue_count > 0 ? <span className="mono">Q:{status.queue_count}</span> : null}
            </TactileButton>
            <BatchDrawer />
          </div>
        )}

        <span className="topbar-sep" />
        <TactileButton active={fullEdit} aria-pressed={fullEdit} onClick={onToggleFullEdit}>
          {fullEdit ? 'Track Edit' : 'Sequence Edit'}
        </TactileButton>

        <TactileButton
          variant="dark"
          data-testid="studio-btn"
          disabled={isPublicDemo || openingStudio || isSaving}
          title={isPublicDemo ? 'Requires the local MRV-02 server' : undefined}
          onClick={async () => {
            const url = await openRemotionStudio();
            if (url) setStudioUrl(url);
          }}
        >
          <PixelIcon name="play" /> {openingStudio ? 'Starting' : 'Studio'}
        </TactileButton>

        {!status.is_rendering ? (
          <TactileButton
            variant="accent"
            data-testid="export-btn"
            disabled={isPublicDemo || status.is_downloading || isSaving}
            title={isPublicDemo ? 'Requires the local MRV-02 server' : undefined}
            onClick={() => renderRemotionVideo()}
          >
            <PixelIcon name="export" /> Export MP4
          </TactileButton>
        ) : (
          <TactileButton
            variant="danger"
            data-testid="cancel-render-btn"
            onClick={() => cancelRemotionRender()}
          >
            ⏹ STOP
          </TactileButton>
        )}
      </div>
      <dialog className="studio-dialog" ref={studioDialog} onClose={() => setStudioUrl(undefined)} aria-labelledby="studio-dialog-title">
        <div className="studio-dialog-head">
          <strong id="studio-dialog-title">Remotion Studio</strong>
          <TactileButton onClick={() => studioDialog.current?.close()}>Back to Workstation</TactileButton>
        </div>
        {studioUrl && <iframe title="Remotion Studio" src={studioUrl} allow="fullscreen" />}
      </dialog>
    </header>
  );
}
