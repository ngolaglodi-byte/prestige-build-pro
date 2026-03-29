import React, { useState, useRef, useEffect } from "react";
import { cn } from "@/lib/utils";

function ContextMenu({ children }: { children: React.ReactNode }) {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const close = () => setPos(null);
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, []);

  return (
    <div ref={ref} onContextMenu={(e) => { e.preventDefault(); setPos({ x: e.clientX, y: e.clientY }); }}>
      {React.Children.map(children, (child: any) => child ? React.cloneElement(child, { pos }) : null)}
    </div>
  );
}

function ContextMenuTrigger({ children, pos }: any) {
  return <>{children}</>;
}

function ContextMenuContent({ children, className, pos }: any) {
  if (!pos) return null;
  return (
    <div className={cn("fixed z-50 min-w-[8rem] overflow-hidden rounded-[var(--radius-md)] border border-[var(--color-border)] bg-white p-1 shadow-[var(--shadow-md)] animate-in", className)} style={{ left: pos.x, top: pos.y }}>
      {children}
    </div>
  );
}

function ContextMenuItem({ children, className, onClick }: { children: React.ReactNode; className?: string; onClick?: () => void }) {
  return (
    <button onClick={onClick} className={cn("relative flex w-full cursor-pointer select-none items-center rounded-[var(--radius-sm)] px-2 py-1.5 text-sm outline-none hover:bg-[var(--color-surface)] transition-colors", className)}>
      {children}
    </button>
  );
}

function ContextMenuSeparator({ className }: { className?: string }) {
  return <div className={cn("-mx-1 my-1 h-px bg-[var(--color-border)]", className)} />;
}

export { ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem, ContextMenuSeparator };
