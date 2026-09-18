"use client";

/**
 * CeloTasker — button primitive (Step 1).
 *
 * One radius system (rounded-control), one border language, three intents.
 * Press feedback comes from the global `button:active` nudge in globals.css,
 * so no component invents its own motion.
 *
 * The class vocabulary lives in ./buttonClasses — a plain, server-safe module
 * (no "use client") — so Server Components style links with the exact same
 * treatment without importing from this client module.
 */
import type { ButtonHTMLAttributes } from "react";
import { buttonClasses, type ButtonSize, type ButtonVariant } from "./buttonClasses";

export type { ButtonSize, ButtonVariant } from "./buttonClasses";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

export function Button({
  variant = "primary",
  size = "md",
  className,
  type = "button",
  ...rest
}: ButtonProps) {
  return (
    <button type={type} className={buttonClasses(variant, size, className)} {...rest} />
  );
}