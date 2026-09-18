/**
 * CeloTasker — "Task Relay" mark.
 *
 * Two offset task cards (requester/AI and human worker) joined by a relay
 * stroke. The convex bracket and the gap between the cards read as a "C" in
 * negative space. Geometric only — no robot, no coin, no Celo logo copy.
 *
 * Inherits `currentColor` so the mark takes the surrounding text color.
 */
export function TaskRelayMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 28 28"
      fill="none"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      {/* Requester / AI card — the origin of the work. */}
      <rect x="3" y="2.5" width="12" height="8.5" rx="2" fill="currentColor" />
      {/* Human worker card — the same task shape, one step along. */}
      <rect
        x="3"
        y="17"
        width="12"
        height="8.5"
        rx="2"
        fill="currentColor"
        opacity="0.45"
      />
      {/* Relay stroke: the delegated work between them. */}
      <path
        d="M19.5 6.75h1.1A4.4 4.4 0 0 1 25 11.15v5.7a4.4 4.4 0 0 1-4.4 4.4h-1.1"
        stroke="currentColor"
        strokeWidth="2.25"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** Mark plus wordmark, the unit used in navigation. */
export function TaskRelayLogo({ className }: { className?: string }) {
  return (
    <span className={className}>
      <TaskRelayMark className="h-[22px] w-[22px] text-celo" />
      <span className="text-[15px] font-semibold tracking-[-0.015em] text-ink">
        CeloTasker
      </span>
    </span>
  );
}