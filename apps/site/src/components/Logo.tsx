import { LOGO_MARK } from '@bridge/shared/brand';

/** The Bridge mark from LOGO_MARK: an ink tile that inverts in dark mode (DESIGN.md "Logo"). */
export function Logo({ size = 24 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${LOGO_MARK.size} ${LOGO_MARK.size}`}
      aria-hidden="true"
      focusable="false"
      className="flex-none"
    >
      <rect
        width={LOGO_MARK.size}
        height={LOGO_MARK.size}
        rx={LOGO_MARK.radius}
        fill="var(--inverse-bg)"
      />
      <g
        fill="none"
        stroke="var(--inverse-fg)"
        strokeWidth={LOGO_MARK.strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {LOGO_MARK.paths.map((d) => (
          <path key={d} d={d} />
        ))}
      </g>
    </svg>
  );
}
