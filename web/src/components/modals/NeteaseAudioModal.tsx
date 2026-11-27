import { useEffect, useState, type ChangeEvent } from 'react';
import { Badge } from '../ui/Badge';
import { TactileButton } from '../ui/TactileButton';
import { useStudioStore } from '../../state/useStudioStore';

export function NeteaseAudioModal() {
  const {
    showNeteaseAudioModal,
    setShowNeteaseAudioModal,
    neteaseAudioCfg,
    savingNeteaseAudioCfg,
    saveNeteaseAudioCfg,
    downloadNeteaseAudioBatch,
  } = useStudioStore();

  const [apiUrl, setApiUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [quality, setQuality] = useState('flac');
  const [scriptText, setScriptText] = useState('');

  useEffect(() => {
    if (showNeteaseAudioModal) {
      setApiUrl(neteaseAudioCfg.api_url || '');
      setQuality(neteaseAudioCfg.default_quality || 'flac');
      setApiKey('');
      setScriptText('');
    }
  }, [neteaseAudioCfg.api_url, neteaseAudioCfg.default_quality, showNeteaseAudioModal]);

  if (!showNeteaseAudioModal) return null;

  const qualityList =
    neteaseAudioCfg.qualities && neteaseAudioCfg.qualities.length > 0
      ? neteaseAudioCfg.qualities
      : ['standard', 'exhigh', 'lossless', 'flac', 'hires'];

  const handleFileImport = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    const ok = await saveNeteaseAudioCfg({
      script_text: text,
      default_quality: quality,
    });
    if (ok) {
      setScriptText('');
    }
    e.target.value = '';
  };

  const handleSave = async () => {
    const ok = await saveNeteaseAudioCfg({
      api_url: apiUrl.trim() || undefined,
      api_key: apiKey.trim() || undefined,
      default_quality: quality,
      script_text: scriptText.trim() || undefined,
    });
    if (ok) {
      setApiKey('');
      setScriptText('');
    }
  };

  return (
    <div
      className="modal-mask"
      data-testid="modal-netease-audio"
      onClick={(e) => {
        if (e.target === e.currentTarget) setShowNeteaseAudioModal(false);
      }}
    >
      <div className="modal-box">
        <div className="modal-head">
          <div className="panel-head-group">
            <span className="modal-title">NETEASE AUDIO SOURCE</span>
            <Badge
              tone={neteaseAudioCfg.configured ? 'green' : 'default'}
              led={neteaseAudioCfg.configured ? 'green' : 'amber'}
            >
              {neteaseAudioCfg.configured ? 'CONFIGURED' : 'UNCONFIGURED'}
            </Badge>
          </div>
          <TactileButton
            variant="ghost"
            size="xs"
            data-testid="modal-close-btn"
            onClick={() => setShowNeteaseAudioModal(false)}
          >
            ESC
          </TactileButton>
        </div>

        <div className="modal-body">
          <div className="field">
            <label className="field-label">IMPORT LX SCRIPT (.JS / .JSON)</label>
            <input
              type="file"
              accept=".js,.json,.txt"
              className="te-file"
              onChange={handleFileImport}
            />
          </div>

          <div className="field-grid-2">
            <div className="field">
              <label className="field-label">API URL</label>
              <input
                type="text"
                className="te-input mono"
                value={apiUrl}
                onChange={(e) => setApiUrl(e.target.value)}
                placeholder="https://..."
              />
            </div>
            <div className="field">
              <label className="field-label">
                API KEY {neteaseAudioCfg.api_key_masked ? `(${neteaseAudioCfg.api_key_masked})` : ''}
              </label>
              <input
                type="password"
                className="te-input mono"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="留空保持原密钥"
              />
            </div>
          </div>

          <div className="field">
            <label className="field-label">DEFAULT QUALITY</label>
            <select
              className="te-select mono"
              value={quality}
              onChange={(e) => setQuality(e.target.value)}
            >
              {qualityList.map((q) => (
                <option key={q} value={q}>
                  {q.toUpperCase()}
                </option>
              ))}
            </select>
          </div>

          <div className="field">
            <label className="field-label">PASTE LX SCRIPT TEXT (OPTIONAL)</label>
            <textarea
              rows={3}
              className="te-textarea mono"
              value={scriptText}
              onChange={(e) => setScriptText(e.target.value)}
              placeholder="粘贴音源脚本内容..."
            />
          </div>

          <div className="empty-card-actions">
            <TactileButton
              size="sm"
              disabled={!neteaseAudioCfg.configured}
              onClick={() => downloadNeteaseAudioBatch('audio', quality, true)}
            >
              补齐缺失无损音频
            </TactileButton>
            <TactileButton
              size="sm"
              disabled={!neteaseAudioCfg.configured}
              onClick={() => downloadNeteaseAudioBatch('video', quality, true)}
            >
              补齐缺失封面音频视频
            </TactileButton>
          </div>
        </div>

        <div className="modal-foot">
          <TactileButton
            variant="ghost"
            onClick={() => setShowNeteaseAudioModal(false)}
          >
            关闭
          </TactileButton>
          <TactileButton
            variant="accent"
            disabled={savingNeteaseAudioCfg}
            onClick={() => handleSave()}
          >
            {savingNeteaseAudioCfg ? '保存中...' : '保存音源配置'}
          </TactileButton>
        </div>
      </div>
    </div>
  );
}
