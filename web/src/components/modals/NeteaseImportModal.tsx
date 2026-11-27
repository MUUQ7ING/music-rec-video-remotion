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
  } = useStudioStore();

  const [url, setUrl] = useState('');
  const [limit, setLimit] = useState(10);
  const [append, setAppend] = useState(false);

  if (!showNeteaseModal) return null;

  const handleSubmit = async () => {
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
            <input
              type="text"
              className="te-input mono"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://music.163.com/#/playlist?id=..."
            />
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
                <span>追加到现有列表</span>
                <Switch checked={append} onChange={setAppend} label="追加到现有列表" />
              </div>
            </div>
          </div>
        </div>

        <div className="modal-foot">
          <TactileButton
            variant="ghost"
            onClick={() => setShowNeteaseModal(false)}
          >
            取消
          </TactileButton>
          <TactileButton
            variant="accent"
            disabled={importingNetease || !url.trim()}
            onClick={() => handleSubmit()}
          >
            {importingNetease ? '导入中...' : '确认导入'}
          </TactileButton>
        </div>
      </div>
    </div>
  );
}
