import { Segmented as AndeusSegmented } from '@andeus/ui';

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  testId?: string;
}

export interface SegmentedProps<T extends string> {
  options: Array<SegmentedOption<T>>;
  value: T;
  onChange: (value: T) => void;
  className?: string;
}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  className = '',
}: SegmentedProps<T>) {
  return (
    <div className={`andeus-tabs ${className}`}>
      <AndeusSegmented
        size="s"
        value={value}
        onChange={onChange}
        options={options.map(option => ({
          value: option.value,
          label: <span data-testid={option.testId}>{option.label}</span>,
        }))}
      />
    </div>
  );
}
