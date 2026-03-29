import React, { createContext, useContext, useState } from "react";
import { cn } from "../../lib/utils";

const ToggleGroupContext = createContext<{ value: string; onChange: (v: string) => void }>({ value: "", onChange: () => {} });

interface ToggleGroupProps {
  type?: "single" | "multiple";
  value?: string;
  onValueChange?: (value: string) => void;
  children: React.ReactNode;
  className?: string;
}

function ToggleGroup({ value: controlled, onValueChange, children, className }: ToggleGroupProps) {
  const [internal, setInternal] = useState("");
  const value = controlled !== undefined ? controlled : internal;
  const onChange = (v: string) => { setInternal(v); onValueChange?.(v); };
  return (
    <ToggleGroupContext.Provider value={{ value, onChange }}>
      <div className={cn("flex items-center justify-center gap-1", className)}>{children}</div>
    </ToggleGroupContext.Provider>
  );
}

function ToggleGroupItem({ value, children, className }: { value: string; children: React.ReactNode; className?: string }) {
  const ctx = useContext(ToggleGroupContext);
  const active = ctx.value === value;
  return (
    <button
      aria-pressed={active}
      className={cn(
        "inline-flex items-center justify-center rounded-[var(--radius-md)] px-3 h-10 text-sm font-medium transition-colors hover:bg-[var(--color-surface)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]",
        active && "bg-[var(--color-surface)] text-[var(--color-text)]",
        className
      )}
      onClick={() => ctx.onChange(value)}
    >
      {children}
    </button>
  );
}

export { ToggleGroup, ToggleGroupItem };
