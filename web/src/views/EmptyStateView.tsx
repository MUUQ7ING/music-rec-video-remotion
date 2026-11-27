import { useStudioStore } from '../state/useStudioStore';
import { Bay } from '../components/ui/Bay';
import { TactileButton } from '../components/ui/TactileButton';

export function EmptyStateView() {
  const { setShowNeteaseModal, addEmptySong } = useStudioStore();

  return (
    <div className="deck-body empty-stage" data-testid="empty-state">
      <Bay title="SEQUENCE EMPTY" className="empty-card" flush>
        <div className="empty-card-body">
          <div className="empty-card-title">NO TRACKS IN SEQUENCE</div>
          <div className="empty-card-desc">
            导入网易云歌单，或手动新增一条音视频曲目开始编辑与定剪。
          </div>
          <div className="empty-card-actions">
            <TactileButton
              variant="accent"
              data-testid="empty-import-btn"
              onClick={() => setShowNeteaseModal(true)}
            >
              导入网易云歌单
            </TactileButton>
            <TactileButton
              data-testid="empty-add-btn"
              onClick={() => addEmptySong()}
            >
              手动新增曲目
            </TactileButton>
          </div>
        </div>
      </Bay>
    </div>
  );
}
