import React, { useState, useRef, useEffect } from "react";
import { cn } from "../../lib/utils";

function Menubar({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("flex h-10 items-center space-x-1 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-white p-1", className)}>
      {children}
    </div>
  );
}

function MenubarMenu({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, []);
  return (
    <div ref={ref} className="relative">
      {React.Children.map(children, (child: any) => child ? React.cloneElement(child, { open, setOpen }) : null)}
    </div>
  );
}

function MenubarTrigger({ children, className, open, setOpen }: any) {
  return (
    <button onClick={() => setOpen?.(!open)} className={cn("flex cursor-pointer select-none items-center rounded-[var(--radius-sm)] px-3 py-1.5 text-sm font-medium outline-none", open ? "bg-[var(--color-surface)] text-[var(--color-text)]" : "text-[var(--color-text-muted)] hover:text-[var(--color-text)]", className)}>
      {children}
    </button>
  );
}

function MenubarContent({ children, className, open }: any) {
  if (!open) return null;
  return (
    <div className={cn("absolute left-0 top-full z-50 mt-1 min-w-[12rem] overflow-hidden rounded-[var(--radius-md)] border border-[var(--color-border)] bg-white p-1 shadow-[var(--shadow-md)] animate-in", className)}>
      {children}
    </div>
  );
}

function MenubarItem({ children, className, onClick }: { children: React.ReactNode; className?: string; onClick?: () => void }) {
  return (
    <button onClick={onClick} className={cn("relative flex w-full cursor-pointer select-none items-center rounded-[var(--radius-sm)] px-2 py-1.5 text-sm outline-none hover:bg-[var(--color-surface)] transition-colors", className)}>
      {children}
    </button>
  );
}

function MenubarSeparator({ className }: { className?: string }) {
  return <div className={cn("-mx-1 my-1 h-px bg-[var(--color-border)]", className)} />;
}

export { Menubar, MenubarMenu, MenubarTrigger, MenubarContent, MenubarItem, MenubarSeparator };
