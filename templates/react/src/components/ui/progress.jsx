import React from "react";
import { cn } from "../../lib/utils";

function Progress({ value = 0, className, ...props }) {
  return (
    <div className={cn("relative h-2 w-full overflow-hidden rounded-full bg-[var(--color-surface)]", className)} {...props}>
      <div
        className="h-full rounded-full bg-[var(--color-primary)] transition-all duration-300 ease-in-out"
        style={{ width: `${Math.min(100, Math.max(0, value))}%` }}
      />
    </div>
  );
}

export { Progress };
