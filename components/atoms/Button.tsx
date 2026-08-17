"use client";

import React from "react";

/* Type-check stand-in for the Beautiful UI reference components in
 * docs/reference/beautiful-ui/. Not wired to the app's design tokens yet —
 * see docs/reference/beautiful-ui/ for the pending token-mapping work. */

export type ButtonVariant = "primary" | "secondary" | "accent" | "success" | "danger";
type ButtonSize = "sm" | "md";

export type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
};

export function Button({
  variant = "primary",
  size = "md",
  className = "",
  type = "button",
  ...props
}: ButtonProps) {
  return (
    <button
      type={type}
      className={`btn btn-${variant} btn-${size} ${className}`.trim()}
      {...props}
    />
  );
}
