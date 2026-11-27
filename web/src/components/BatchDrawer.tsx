import { useStudioStore } from '../state/useStudioStore';

export function BatchDrawer() {
  const {
    showTools,
    setShowTools,
    status,
    biliUser,
    neteaseAudioCfg,
    setShowNeteaseModal,
    openBiliModal,
    openNeteaseAudioModal,
    downloadAll,
    runPreprocess,
    analyzeAllVisuals,
    selectIntro,
  } = useStudioStore();

  if (!showTools) return null;

  const busy = Boolean(status.is_downloading || status.is_rendering);

  return (
    <div className="tools-menu" data-testid="batch-menu-panel">
      <div className="tools-section-label">IMPORT &amp; AUTH</div>
      <button
        type="button"
        className="tools-item"
        onClick={() => {
          setShowTools(false);
          setShowNeteaseModal(true);
        }}
      >
        <span>导入网易云歌单</span>
        <span className="mono">NETEASE</span>
      </button>
      <button
        type="button"
        className="tools-item"
        onClick={() => openBiliModal()}
      >
        <span>B站扫码登录</span>
        <span className={biliUser.logged_in ? 'te-led green' : 'te-led amber'} />
      </button>
      <button
        type="button"
        className="tools-item"
        onClick={() => openNeteaseAudioModal()}
      >
        <span>网易云音源设置</span>
        <span className={neteaseAudioCfg.configured ? 'te-led green' : 'te-led amber'} />
      </button>

      <div className="tools-sep" />
      <div className="tools-section-label">BATCH PIPELINE</div>
      <button
        type="button"
        className="tools-item"
        disabled={busy}
        onClick={() => downloadAll()}
      >
        <span>↓ 批量下载全部曲目</span>
        <span className="mono">MV</span>
      </button>
      <button
        type="button"
        className="tools-item"
        disabled={busy}
        onClick={() => runPreprocess()}
      >
        <span>素材预处理 (封面 / -14 LUFS)</span>
        <span className="mono">NORM</span>
      </button>
      <button
        type="button"
        className="tools-item"
        disabled={busy}
        onClick={() => analyzeAllVisuals()}
      >
        <span>视觉亮度分析与双语歌词</span>
        <span className="mono">LRC</span>
      </button>

      <div className="tools-sep" />
      <div className="tools-section-label">SEQUENCE</div>
      <button
        type="button"
        className="tools-item"
        onClick={() => {
          setShowTools(false);
          selectIntro();
        }}
      >
        <span>开场白与全局默认转场</span>
        <span className="mono">00</span>
      </button>
    </div>
  );
}
