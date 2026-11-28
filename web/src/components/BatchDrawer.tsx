import { TactileButton } from './ui/TactileButton';
import { useEffect, useRef, useState } from 'react';
import { fetchYoutubeCookiesApi, importYoutubeCookiesApi } from '../api/client';
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

  const cookieInput = useRef<HTMLInputElement>(null);
  const [cookiesReady, setCookiesReady] = useState(false);
  const [importingCookies, setImportingCookies] = useState(false);
  const [cookieMessage, setCookieMessage] = useState('');

  useEffect(() => {
    if (!showTools) return;
    let active = true;
    fetchYoutubeCookiesApi().then(data => {
      if (active) setCookiesReady(data.configured);
    }).catch(() => {});
    return () => { active = false; };
  }, [showTools]);

  if (!showTools) return null;

  const busy = Boolean(status.is_downloading || status.is_rendering);

  return (
    <div className="tools-menu" data-testid="batch-menu-panel">
      <div className="tools-section-label">IMPORT &amp; AUTH</div>
      <TactileButton customLayout
        type="button"
        className="tools-item"
        onClick={() => {
          setShowTools(false);
          setShowNeteaseModal(true);
        }}
      >
        <span>导入网易云歌单</span>
        <span className="mono">NETEASE</span>
      </TactileButton>
      <TactileButton customLayout
        type="button"
        className="tools-item"
        onClick={() => openBiliModal()}
      >
        <span>B站扫码登录</span>
        <span className={biliUser.logged_in ? 'te-led green' : 'te-led amber'} />
      </TactileButton>
      <TactileButton customLayout
        type="button"
        className="tools-item"
        onClick={() => openNeteaseAudioModal()}
      >
        <span>网易云音源设置</span>
        <span className={neteaseAudioCfg.configured ? 'te-led green' : 'te-led amber'} />
      </TactileButton>

      <TactileButton customLayout type="button" className="tools-item" disabled={busy || importingCookies} onClick={() => cookieInput.current?.click()}>
        <span>{importingCookies ? '正在导入…' : '导入 YouTube Cookies'}</span>
        <span className={cookiesReady ? 'te-led green' : 'te-led off'} aria-label={cookiesReady ? '已导入' : '未导入'} />
      </TactileButton>
      <input hidden ref={cookieInput} type="file" accept=".txt,text/plain" aria-label="YouTube cookies.txt" onChange={async event => {
        const input = event.currentTarget;
        const file = input.files?.[0];
        input.value = '';
        if (!file) return;
        setImportingCookies(true);
        setCookieMessage('');
        try {
          const result = await importYoutubeCookiesApi(file);
          setCookiesReady(result.configured);
          setCookieMessage('已导入，可重新下载 YouTube 视频。');
        } catch (error) {
          setCookieMessage(error instanceof Error ? error.message : '导入失败');
        } finally {
          setImportingCookies(false);
        }
      }} />
      {cookieMessage && <div className="tools-section-label" role="status">{cookieMessage}</div>}

      <div className="tools-sep" />
      <div className="tools-section-label">BATCH PIPELINE</div>
      <TactileButton customLayout
        type="button"
        className="tools-item"
        disabled={busy}
        onClick={() => downloadAll()}
      >
        <span>↓ 批量下载全部曲目</span>
        <span className="mono">MV</span>
      </TactileButton>
      <TactileButton customLayout
        type="button"
        className="tools-item"
        disabled={busy}
        onClick={() => runPreprocess()}
      >
        <span>素材预处理 (封面 / -14 LUFS)</span>
        <span className="mono">NORM</span>
      </TactileButton>
      <TactileButton customLayout
        type="button"
        className="tools-item"
        disabled={busy}
        onClick={() => analyzeAllVisuals()}
      >
        <span>视觉亮度分析与双语歌词</span>
        <span className="mono">LRC</span>
      </TactileButton>

      <div className="tools-sep" />
      <div className="tools-section-label">SEQUENCE</div>
      <TactileButton customLayout
        type="button"
        className="tools-item"
        onClick={() => {
          setShowTools(false);
          selectIntro();
        }}
      >
        <span>开场白与全局默认转场</span>
        <span className="mono">00</span>
      </TactileButton>
    </div>
  );
}
