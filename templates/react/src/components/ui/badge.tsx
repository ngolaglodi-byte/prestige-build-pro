import React from "react";
import { cn } from "@/lib/utils";

const variants = {
  default: "bg-[var(--color-primary)] text-white",
  secondary: "bg-[var(--color-surface)] text-[var(--color-text)]",
  destructive: "bg-[var(--color-error)] text-white",
  outline: "border border-[var(--color-border)] text-[var(--color-text)]",
  success: "bg-[var(--color-success)] text-white",
};

function Badge({ className, variant = "default", ...props }) {
  return (
    <div className={cn("inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold transition-colors", variants[variant], className)} {...props} />
  );
}

export { Badge };
