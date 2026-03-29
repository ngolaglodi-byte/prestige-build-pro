import React, { useState, useRef, useEffect } from "react";
import { cn } from "../../lib/utils";

function Popover({ children }) {
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

function PopoverTrigger({ children, setOpen, open, className, ...props }) {
  return (
    <button className={className} onClick={() => setOpen?.(!open)} aria-expanded={open} {...props}>
      {children}
    </button>
  );
}

function PopoverContent({ children, open, className, align = "center" }) {
  if (!open) return null;
  const alignClass = align === "start" ? "left-0" : align === "end" ? "right-0" : "left-1/2 -translate-x-1/2";
  return (
    <div className={cn(
      "absolute z-50 mt-2 w-72 rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-white p-4 shadow-[var(--shadow-lg)] animate-in",
      alignClass,
      className
    )}>
      {children}
    </div>
  );
}

export { Popover, PopoverTrigger, PopoverContent };
