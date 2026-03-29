import React from "react";
import { cn } from "../../lib/utils";

const variants = {
  default: "bg-[var(--color-primary)] text-white hover:bg-[var(--color-primary-hover)] shadow-sm",
  destructive: "bg-[var(--color-error)] text-white hover:bg-red-700 shadow-sm",
  outline: "border border-[var(--color-border)] bg-white hover:bg-[var(--color-surface)] text-[var(--color-text)]",
  secondary: "bg-[var(--color-surface)] text-[var(--color-text)] hover:bg-gray-200",
  ghost: "hover:bg-[var(--color-surface)] text-[var(--color-text)]",
  link: "text-[var(--color-primary)] underline-offset-4 hover:underline",
};

const sizes = {
  default: "h-10 px-4 py-2",
  sm: "h-9 rounded-md px-3 text-sm",
  lg: "h-11 rounded-md px-8 text-base",
  icon: "h-10 w-10",
};

const Button = React.forwardRef(({ className, variant = "default", size = "default", disabled, children, ...props }, ref) => {
  return (
    <button
      className={cn(
        "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-[var(--radius-md)] text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)] focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50",
        variants[variant],
        sizes[size],
        className
      )}
      ref={ref}
      disabled={disabled}
      {...props}
    >
      {children}
    </button>
  );
});
Button.displayName = "Button";

export { Button };
