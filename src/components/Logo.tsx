/**
 * StoneSender logo lockup (design system, concept 3A-1): the framed spindle and stone, drawn
 * inline so the frame and bit follow the theme (`mark-ink` via currentColor). The stone and
 * chips are always spindle orange. Paths copied from the design system's mark SVG.
 */
import { cn } from '@/lib/utils';

export function LogoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 64" aria-hidden="true" className={cn('text-mark-ink', className)}>
      <rect x="4" y="4" width="56" height="56" rx="18" fill="none" stroke="currentColor" strokeWidth="4.5" />
      <g transform="translate(7.7 8.4) scale(0.76)">
        <rect x="27" y="4" width="10" height="16" rx="2" fill="currentColor" />
        <rect x="28" y="22" width="8" height="12" fill="currentColor" />
        <path d="M28 27 L36 23 M28 32 L36 28" stroke="var(--surface-raised)" strokeWidth="1.6" />
        <polygon points="28,34 36,34 32,39" fill="currentColor" />
        <path d="M10 50 C10 43 20 41 32 41 C46 41 54 44 54 50 C54 56 46 58 32 58 C18 58 10 56 10 50 Z" fill="var(--brand)" />
        <polygon points="17,35 22,33 21,38" fill="var(--brand)" />
        <polygon points="43,32 48,35 43,37" fill="var(--brand)" />
        <polygon points="13,41 16,39 16,42" fill="var(--brand)" />
      </g>
    </svg>
  );
}

/** Mark + wordmark ("Stone" in mark-ink, "Sender" in brand-text), Space Grotesk 600. */
export function Logo({ showWordmark = true }: { showWordmark?: boolean }) {
  return (
    <div className="flex items-center gap-2.5">
      <LogoMark className="size-7 shrink-0" />
      {showWordmark && (
        <span className="hidden font-display text-lg leading-6 font-semibold tracking-[-0.02em] text-mark-ink lg:inline">
          Stone<span className="text-brand-text">Sender</span>
        </span>
      )}
    </div>
  );
}
