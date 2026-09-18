/**
 * CeloTasker — shared button class vocabulary.
 *
 * Server-safe on purpose: a plain module with no "use client" directive, so
 * Server Components (the landing page) and Client Components (the Button
 * primitive, navigation) share ONE class vocabulary and the radius/border
 * language cannot drift. The Button primitive in ./Button consumes this exact
 * function; anchors that must look like buttons import it directly from here,
 * never from the client-bound ./Button module.
 */
export type ButtonVariant = "primary" | "secondary" | "quiet";
export type ButtonSize = "md" | "sm";

const BASE =
  "inline-flex shrink-0 items-center justify-center gap-2 rounded-control " +
  "font-medium transition-colors duration-150 disabled:cursor-not-allowed " +
  "disabled:opacity-55";

/** Deep Celo green is the only filled treatment in the product. */
const VARIANTS: Record<ButtonVariant, string> = {
  primary:
    "border border-celo bg-celo text-paper-raised hover:border-celo-deep hover:bg-celo-deep",
  secondary:
    "border border-line-strong bg-paper-raised text-ink hover:border-ink-faint hover:bg-paper-sunken",
  quiet: "border border-transparent text-ink-soft hover:bg-paper-sunken hover:text-ink",
};

const SIZES: Record<ButtonSize, string> = {
  md: "h-10 px-4 text-[14px]",
  sm: "h-8 px-3 text-[13px]",
};

/**
 * The same treatment for anchors that must look like a button (links, not
 * actions). Exported so navigation never re-invents the button styles and the
 * radius/border language cannot drift.
 */
export function buttonClasses(
  variant: ButtonVariant = "primary",
  size: ButtonSize = "md",
  className?: string
): string {
  return [BASE, VARIANTS[variant], SIZES[size], className].filter(Boolean).join(" ");
}
