import React from "react";
import { cn } from "@/lib/utils";

const variants = {
  default: "bg-white border-[var(--color-border)] text-[var(--color-text)]",
  destructive: "bg-red-50 border-[var(--color-error)] text-red-800",
  success: "bg-green-50 border-[var(--color-success)] text-green-800",
  warning: "bg-amber-50 border-[var(--color-warning)] text-amber-800",
};

function Alert({ className, variant = "default", ...props }) {
  return <div role="alert" className={cn("relative w-full rounded-[var(--radius-lg)] border p-4", variants[variant], className)} {...props} />;
}

function AlertTitle({ className, ...props }) {
  return <h5 className={cn("mb-1 font-medium leading-none tracking-tight", className)} {...props} />;
}

function AlertDescription({ className, ...props }) {
  return <div className={cn("text-sm opacity-90", className)} {...props} />;
}

export { Alert, AlertTitle, AlertDescription };
