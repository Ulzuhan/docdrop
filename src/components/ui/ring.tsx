interface Props {
  /** 0..1, how much of the ring is filled. */
  fraction: number;
  size?: number;
  stroke?: number;
  tone?: "danger" | "ice" | "ok";
  /** Short text in the middle ("22h"). */
  label?: string;
  /** Spoken description of the whole thing. */
  title: string;
}

/** A circular gauge: remaining life of a file, or progress of a decryption. */
export function Ring({ fraction, size = 44, stroke = 3.5, tone, label, title }: Props) {
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const filled = Math.max(0, Math.min(1, fraction));
  return (
    <div
      className="ring"
      data-tone={tone}
      style={{ width: size, height: size }}
      role="img"
      aria-label={title}
      title={title}
    >
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden>
        <circle className="ring-track" cx={size / 2} cy={size / 2} r={radius} fill="none" strokeWidth={stroke} />
        <circle
          className="ring-bar"
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          strokeWidth={stroke}
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - filled)}
        />
      </svg>
      {label && (
        <span className="ring-label" aria-hidden>
          {label}
        </span>
      )}
    </div>
  );
}
