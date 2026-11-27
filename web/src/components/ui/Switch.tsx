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
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        data-testid={testId}
        className={checked ? 'te-switch on' : 'te-switch'}
        onClick={() => onChange(!checked)}
      />
      <span className={checked ? 'switch-led on' : 'switch-led'} />
    </div>
  );
}
