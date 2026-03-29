import React from "react";
import { cn } from "../../lib/utils";

interface ToggleProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  pressed?: boolean;
  onPressedChange?: (pressed: boolean) => void;
  variant?: "default" | "outline";
  size?: "default" | "sm" | "lg";
}

const variants = {
  default: "bg-transparent",
  outline: "border border-[var(--color-border)] bg-transparent",
};

const sizes = {
  default: "h-10 px-3",
  sm: "h-9 px-2.5",
  lg: "h-11 px-5",
};

function Toggle({ className, variant = "default", size = "default", pressed, onPressedChange, children, ...props }: ToggleProps) {
  return (
    <button
      aria-pressed={pressed}
      data-state={pressed ? "on" : "off"}
      className={cn(
        "inline-flex items-center justify-center rounded-[var(--radius-md)] text-sm font-medium transition-colors hover:bg-[var(--color-surface)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)] focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50",
        variants[variant], sizes[size],
        pressed && "bg-[var(--color-surface)] text-[var(--color-text)]",
        className
      )}
      onClick={() => onPressedChange?.(!pressed)}
      {...props}
    >
      {children}
    </button>
  );
}

export { Toggle };
