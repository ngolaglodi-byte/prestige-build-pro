import React, { useState, useRef, useEffect } from "react";
import { cn } from "../../lib/utils";

function DropdownMenu({ children }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    const handler = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  return (
    <div ref={ref} className="relative inline-block">
      {React.Children.map(children, (child) =>
        child ? React.cloneElement(child, { open, setOpen }) : null
      )}
    </div>
  );
}

function DropdownMenuTrigger({ children, open, setOpen, className }) {
  return (
    <button className={className} onClick={() => setOpen?.(!open)} aria-expanded={open}>
      {children}
    </button>
  );
}

function DropdownMenuContent({ children, open, className, align = "end" }) {
  if (!open) return null;
  return (
    <div className={cn(
      "absolute z-50 mt-2 min-w-[8rem] overflow-hidden rounded-[var(--radius-md)] border border-[var(--color-border)] bg-white p-1 shadow-[var(--shadow-md)] animate-in",
      align === "end" ? "right-0" : "left-0",
      className
    )}>
      {children}
    </div>
  );
}

function DropdownMenuItem({ children, className, onClick, disabled }) {
  return (
    <button
      className={cn(
        "relative flex w-full cursor-pointer select-none items-center rounded-[var(--radius-sm)] px-2 py-1.5 text-sm text-[var(--color-text)] outline-none transition-colors hover:bg-[var(--color-surface)] focus:bg-[var(--color-surface)]",
        disabled && "pointer-events-none opacity-50",
        className
      )}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  );
}

function DropdownMenuSeparator({ className }) {
  return <div className={cn("-mx-1 my-1 h-px bg-[var(--color-border)]", className)} />;
}

export { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator };
