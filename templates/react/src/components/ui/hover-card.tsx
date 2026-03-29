import React, { useState, useRef } from "react";
import { cn } from "@/lib/utils";

function HoverCard({ children, className }: { children: React.ReactNode; className?: string }) {
  const [open, setOpen] = useState(false);
  const timeout = useRef<any>(null);
  const show = () => { clearTimeout(timeout.current); timeout.current = setTimeout(() => setOpen(true), 200); };
  const hide = () => { clearTimeout(timeout.current); timeout.current = setTimeout(() => setOpen(false), 150); };

  return (
    <div className={cn("relative inline-block", className)} onMouseEnter={show} onMouseLeave={hide}>
      {React.Children.map(children, (child: any) => child ? React.cloneElement(child, { open }) : null)}
    </div>
  );
}

function HoverCardTrigger({ children, open }: any) {
  return <>{children}</>;
}

function HoverCardContent({ children, className, open }: any) {
  if (!open) return null;
  return (
    <div className={cn("absolute z-50 w-64 rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-white p-4 shadow-[var(--shadow-lg)] animate-in", className)}>
      {children}
    </div>
  );
}

export { HoverCard, HoverCardTrigger, HoverCardContent };
