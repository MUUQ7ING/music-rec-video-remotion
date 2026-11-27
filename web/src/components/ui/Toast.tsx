import { TactileButton } from './TactileButton';

export interface ToastProps {
  message: string | null;
  tone?: 'info' | 'error';
  actionLabel?: string;
  actionTestId?: string;
  onAction?: () => void;
  onDismiss?: () => void;
}

export function Toast({
  message,
  tone = 'info',
  actionLabel,
  actionTestId,
  onAction,
  onDismiss,
}: ToastProps) {
  if (!message) return null;
  return (
    <div
      className={tone === 'error' ? 'toast error' : 'toast'}
      role="status"
      aria-live="polite"
      data-testid="toast-notice"
    >
      <div className="toast-lead">
        <span className={tone === 'error' ? 'te-led red toast-led' : 'te-led accent toast-led'} />
        <span className="toast-msg">{message}</span>
      </div>
      <div className="toast-actions">
        {actionLabel && onAction ? (
          <TactileButton
            variant="accent"
            size="xs"
            data-testid={actionTestId}
            onClick={onAction}
          >
            {actionLabel}
          </TactileButton>
        ) : null}
        {onDismiss ? (
          <TactileButton
            variant="ghost"
            size="xs"
            aria-label="Dismiss"
            onClick={onDismiss}
          >
            ×
          </TactileButton>
        ) : null}
      </div>
    </div>
  );
}
