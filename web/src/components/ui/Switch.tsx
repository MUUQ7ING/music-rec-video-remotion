import { TactileButton } from './TactileButton';

export interface SwitchProps {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  label?: string;
  testId?: string;
}

export function Switch({
  checked,
  onChange,
  disabled = false,
  label,
  testId,
}: SwitchProps) {
  return (
    <div className="switch-wrap">
      <TactileButton customLayout
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        data-testid={testId}
        className={checked ? 'te-switch on' : 'te-switch'}
        style={{ background: 'var(--bg-well)', boxShadow: 'var(--shadow-inset)' }}
        onClick={() => onChange(!checked)}
      />
      <span className={checked ? 'switch-led on' : 'switch-led'} />
    </div>
  );
}
