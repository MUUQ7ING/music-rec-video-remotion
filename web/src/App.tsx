import { lazy, Suspense, useState } from 'react';
import { ColumnDivider } from './components/ColumnDivider';
import { ConsoleDrawer } from './components/ConsoleDrawer';
import { Topbar } from './components/Topbar';
import { TrackRack } from './components/TrackRack';
import { BiliAuthModal } from './components/modals/BiliAuthModal';
import { NeteaseAudioModal } from './components/modals/NeteaseAudioModal';
import { NeteaseImportModal } from './components/modals/NeteaseImportModal';
import { Toast } from './components/ui/Toast';
import { StudioProvider, useStudioStore } from './state/useStudioStore';
import { formatSongDuration } from './utils/time';
import { EmptyStateView } from './views/EmptyStateView';
import { IntroGlobalView } from './views/IntroGlobalView';
import { MonitorTrimView } from './views/MonitorTrimView';

const TrackCompositionPreview = lazy(() => import('./components/TrackCompositionPreview'));

function StudioShell() {
  const [fullEdit, setFullEdit] = useState(false);
  const {
    hydrated,
    playlist,
    activeView,
    activeIdx,
    activeTab,
    setActiveTab,
    activeSong,
    activeClips,
    toast,
    dismissToast,
    retrySave,
  } = useStudioStore();

  if (!hydrated) {
    return <div className="shell" />;
  }

  const songs = playlist.songs || [];

  return (
    <div className="shell">
      <Topbar fullEdit={fullEdit} onToggleFullEdit={() => setFullEdit(!fullEdit)} />

      <div className="workspace">
        <TrackRack />
        <ColumnDivider side="rack" />

        <main className="deck">
          {fullEdit && songs.length > 0 ? (
            <Suspense fallback={<p>Loading sequence preview…</p>}><TrackCompositionPreview full /></Suspense>
          ) : songs.length === 0 && activeView !== 'intro' ? (
            <EmptyStateView />
          ) : activeView === 'intro' ? (
            <IntroGlobalView />
          ) : activeSong ? (
            <>
              <div className="deck-bar">
                <div className="deck-bar-left">
                  <div className="deck-id">
                    <span className="deck-index">
                      {String(activeIdx + 1).padStart(2, '0')}
                    </span>
                    <div className="deck-title-wrap">
                      <div className="deck-title" data-testid="deck-title">
                        {activeSong.title || '未命名曲目'}
                      </div>
                      <div className="deck-sub">
                        {activeSong.artist || '未知歌手'} · {formatSongDuration(activeSong)}
                      </div>
                    </div>
                  </div>

                  <span className="deck-bar-sep" />

                  <div className="tab-strip">
                    <button
                      type="button"
                      data-testid="tab-trim"
                      className={activeTab === 'trim' ? 'tab-btn active' : 'tab-btn'}
                      onClick={() => setActiveTab('trim')}
                    >
                      Lyrics & Copy
                    </button>
                    <button
                      type="button"
                      data-testid="tab-source"
                      className={activeTab === 'source' ? 'tab-btn active' : 'tab-btn'}
                      onClick={() => setActiveTab('source')}
                    >
                      Source
                    </button>
                    <button
                      type="button"
                      data-testid="tab-stage"
                      className={activeTab === 'stage' ? 'tab-btn active' : 'tab-btn'}
                      onClick={() => setActiveTab('stage')}
                    >
                      Stage &amp; FX
                    </button>
                  </div>
                </div>

                <div className="deck-bar-right mono">
                  <span>
                    {activeSong.has_file && activeSong.file_size_mb
                      ? `${activeSong.file_size_mb}MB`
                      : 'NO MEDIA'}
                  </span>
                  {activeSong.has_normalized ? <span>· -14 LUFS</span> : null}
                  {activeClips.length > 1 ? <span>· {activeClips.length} CLIPS</span> : null}
                </div>
              </div>

              <MonitorTrimView />
            </>
          ) : null}
        </main>
      </div>

      <div className="dock-footer">
        <Toast
          message={toast?.message ?? null}
          tone={toast?.kind === 'error' ? 'error' : 'info'}
          actionLabel={toast?.showRetry ? '重试保存' : undefined}
          actionTestId={toast?.showRetry ? 'save-retry-btn' : undefined}
          onAction={toast?.showRetry ? () => retrySave() : undefined}
          onDismiss={dismissToast}
        />
        <ConsoleDrawer />
      </div>

      <NeteaseImportModal />
      <BiliAuthModal />
      <NeteaseAudioModal />
    </div>
  );
}

export function App() {
  return (
    <StudioProvider>
      <StudioShell />
    </StudioProvider>
  );
}

export default App;
