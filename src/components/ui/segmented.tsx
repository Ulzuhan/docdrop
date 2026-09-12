import { useRef, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";

export interface SegmentedOption<T> {
  value: T;
  label: ReactNode;
  /** Spoken name when the label alone would not do ("∞" → "No limit"). */
  ariaLabel?: string;
  icon?: ReactNode;
}

interface Props<T> {
  id: string;
  label?: string;
  icon?: ReactNode;
  options: SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
}

/**
 * A radio group drawn as a segmented control with a sliding thumb. Arrow keys
 * move the selection, as in a native radio group.
 */
export function Segmented<T extends string | number | boolean>({
  id,
  label,
  icon,
  options,
  value,
  onChange,
}: Props<T>) {
  const group = useRef<HTMLDivElement>(null);
  const index = Math.max(
    0,
    options.findIndex((option) => Object.is(option.value, value))
  );
  const labelId = `${id}-label`;

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const step =
      event.key === "ArrowRight" || event.key === "ArrowDown"
        ? 1
        : event.key === "ArrowLeft" || event.key === "ArrowUp"
          ? -1
          : 0;
    let next = index;
    if (step !== 0) next = (index + step + options.length) % options.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = options.length - 1;
    else return;
    event.preventDefault();
    onChange(options[next].value);
    const buttons = group.current?.querySelectorAll<HTMLButtonElement>("[role=radio]");
    buttons?.[next]?.focus();
  }

  return (
    <div>
      {label && (
        <span id={labelId} className="field-label">
          {icon}
          {label}
        </span>
      )}
      <div
        ref={group}
        role="radiogroup"
        aria-labelledby={label ? labelId : undefined}
        className="seg"
        style={{ "--n": options.length, "--i": index } as CSSProperties}
        onKeyDown={onKeyDown}
      >
        <span className="seg-thumb" aria-hidden />
        {options.map((option, i) => (
          <button
            key={String(option.value)}
            type="button"
            role="radio"
            aria-checked={i === index}
            aria-label={option.ariaLabel}
            tabIndex={i === index ? 0 : -1}
            className="seg-opt"
            onClick={() => onChange(option.value)}
          >
            {option.icon}
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}
