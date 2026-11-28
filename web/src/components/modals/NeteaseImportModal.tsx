import { importProjectsApi } from '../../api/client';
import { useState } from 'react';
import { Switch } from '../ui/Switch';
import { TactileButton } from '../ui/TactileButton';
import { useStudioStore } from '../../state/useStudioStore';

export function NeteaseImportModal() {
  const {
    showNeteaseModal,
    setShowNeteaseModal,
    importingNetease,
    importNetease,
    savePlaylist,
  } = useStudioStore();

  const [url, setUrl] = useState('');
  const [limit, setLimit] = useState(10);
  const [append, setAppend] = useState(false);
  const [separate, setSeparate] = useState(false);
  const [savingProjects, setSavingProjects] = useState(false);
  const [projectError, setProjectError] = useState('');

  if (!showNeteaseModal) return null;

  const handleSubmit = async () => {
    if (separate) {
      setSavingProjects(true);
      setProjectError('');
      try {
        if (!await savePlaylist({ silent: true })) {
          setProjectError('当前项目保存失败，请重试');
          return;
        }
        await importProjectsApi(url.split(/\s+/), limit);
        window.location.reload();
      } catch (error) {
        setProjectError(error instanceof Error ? error.message : '项目导入失败');
      } finally {
        setSavingProjects(false);
      }
      return;
    }
    const ok = await importNetease(url, limit, append);
    if (ok) {
      setUrl('');
    }
  };

  return (
    <div
      className="modal-mask"
      data-testid="modal-netease-import"
      onClick={(e) => {
        if (e.target === e.currentTarget) setShowNeteaseModal(false);
      }}
    >
      <div className="modal-box">
        <div className="modal-head">
          <span className="modal-title">IMPORT NETEASE PLAYLIST</span>
          <TactileButton
            variant="ghost"
            size="xs"
            data-testid="modal-close-btn"
            onClick={() => setShowNeteaseModal(false)}
          >
            ESC
          </TactileButton>
        </div>

        <div className="modal-body">
          <div className="field">
            <label className="field-label">PLAYLIST URL OR ID</label>
            {separate ? (
              <textarea className="te-textarea" rows={4} value={url} onChange={event => setUrl(event.target.value)} placeholder="每行一个歌单链接或 ID" />
            ) : <input
              type="text"
              className="te-input mono"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://music.163.com/#/playlist?id=..."
            />}
          </div>

          <div className="field-grid-2">
            <div className="field">
              <label className="field-label">TRACK LIMIT</label>
              <input
                type="number"
                min="1"
                max="100"
                className="te-input mono"
                value={limit}
                onChange={(e) => setLimit(parseInt(e.target.value, 10) || 10)}
              />
            </div>

            <div className="field">
              <label className="field-label">MODE</label>
              <div className="switch-row">
                <span>每个歌单建成独立项目</span>
                <Switch checked={separate} onChange={setSeparate} label="每个歌单建成独立项目" />
              </div>
              {!separate && <div className="switch-row">
                <span>追加到现有列表</span>
                <Switch checked={append} onChange={setAppend} label="追加到现有列表" />
              </div>}
            </div>
          </div>
        </div>

        {projectError && <p role="alert">{projectError}</p>}
        <div className="modal-foot">
          <TactileButton
            variant="ghost"
            onClick={() => setShowNeteaseModal(false)}
          >
            取消
          </TactileButton>
          <TactileButton
            variant="accent"
            disabled={importingNetease || savingProjects || !url.trim()}
            onClick={() => handleSubmit()}
          >
            {importingNetease || savingProjects ? '导入中...' : '确认导入'}
          </TactileButton>
        </div>
      </div>
    </div>
  );
}
