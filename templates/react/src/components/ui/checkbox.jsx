import React from "react";
import { cn } from "../../lib/utils";
import { Check } from "lucide-react";

function Checkbox({ checked, onCheckedChange, className, disabled, id, ...props }) {
  return (
    <button
      role="checkbox"
      aria-checked={checked}
      id={id}
      disabled={disabled}
      className={cn(
        "peer h-4 w-4 shrink-0 rounded-[var(--radius-sm)] border border-[var(--color-border)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)] focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 transition-colors",
        checked ? "bg-[var(--color-primary)] border-[var(--color-primary)] text-white" : "bg-white",
        className
      )}
      onClick={() => onCheckedChange?.(!checked)}
      {...props}
    >
      {checked && <Check size={12} className="mx-auto" />}
    </button>
  );
}

export { Checkbox };
