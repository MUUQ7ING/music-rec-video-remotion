import { useMemo } from 'react';
import { TactileButton } from '../ui/TactileButton';
import { useStudioStore } from '../../state/useStudioStore';
import { buildQrSvgData } from '../../utils/qr';

export function BiliAuthModal() {
  const {
    showBiliModal,
    closeBiliModal,
    biliUser,
    biliQrLoading,
    biliQrUrl,
    biliQrMessage,
    generateBiliQr,
    logoutBili,
  } = useStudioStore();

  const qrSvg = useMemo(
    () => (biliQrUrl ? buildQrSvgData(biliQrUrl, 1) : null),
    [biliQrUrl],
  );

  if (!showBiliModal) return null;

  return (
    <div
      className="modal-mask"
      data-testid="modal-bili-auth"
      onClick={(e) => {
        if (e.target === e.currentTarget) closeBiliModal();
      }}
    >
      <div className="modal-box">
        <div className="modal-head">
          <span className="modal-title">BILIBILI QR AUTH</span>
          <TactileButton
            variant="ghost"
            size="xs"
            data-testid="modal-close-btn"
            onClick={() => closeBiliModal()}
          >
            ESC
          </TactileButton>
        </div>

        <div className="modal-body" style={{ alignItems: 'center', textAlign: 'center' }}>
          {biliUser.logged_in ? (
            <>
              <div className="te-badge green">
                <span className="te-led green" />
                <span>CONNECTED · {biliUser.uname}</span>
              </div>
              {biliUser.vip_label ? (
                <div className="mono">{biliUser.vip_label}</div>
              ) : null}
              <TactileButton variant="danger" onClick={() => logoutBili()}>
                退出登录
              </TactileButton>
            </>
          ) : (
            <>
              <div className="qr-frame">
                {biliQrLoading ? (
                  <span className="mono">LOADING...</span>
                ) : qrSvg ? (
                  <svg
                    viewBox={`0 0 ${qrSvg.viewBoxSize} ${qrSvg.viewBoxSize}`}
                    shapeRendering="crispEdges"
                    aria-label="Bilibili Login QR Code"
                  >
                    <rect
                      width={qrSvg.viewBoxSize}
                      height={qrSvg.viewBoxSize}
                      fill="#ffffff"
                    />
                    <path d={qrSvg.pathD} fill="#141413" />
                  </svg>
                ) : (
                  <span className="mono">NO QR</span>
                )}
              </div>
              <div className="mono">{biliQrMessage}</div>
              <TactileButton onClick={() => generateBiliQr()}>
                刷新二维码
              </TactileButton>
            </>
          )}
        </div>

        <div className="modal-foot">
          <TactileButton variant="ghost" onClick={() => closeBiliModal()}>
            关闭
          </TactileButton>
        </div>
      </div>
    </div>
  );
}
