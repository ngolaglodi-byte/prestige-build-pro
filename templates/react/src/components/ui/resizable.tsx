import React, { useState, useRef, useCallback } from "react";
import { cn } from "@/lib/utils";
import { GripVertical } from "lucide-react";

interface ResizablePanelGroupProps {
  direction?: "horizontal" | "vertical";
  children: React.ReactNode;
  className?: string;
}

function ResizablePanelGroup({ direction = "horizontal", children, className }: ResizablePanelGroupProps) {
  return (
    <div className={cn("flex h-full w-full", direction === "horizontal" ? "flex-row" : "flex-col", className)}>
      {children}
    </div>
  );
}

function ResizablePanel({ children, className, defaultSize = 50 }: { children: React.ReactNode; className?: string; defaultSize?: number }) {
  return (
    <div className={cn("flex-1 overflow-auto", className)} style={{ flexBasis: `${defaultSize}%` }}>
      {children}
    </div>
  );
}

function ResizableHandle({ className }: { className?: string }) {
  return (
    <div className={cn("relative flex w-px items-center justify-center bg-[var(--color-border)] after:absolute after:inset-y-0 after:left-1/2 after:w-1 after:-translate-x-1/2 hover:bg-[var(--color-primary)] transition-colors cursor-col-resize", className)}>
      <div className="z-10 flex h-4 w-3 items-center justify-center rounded-sm border border-[var(--color-border)] bg-white">
        <GripVertical className="h-2.5 w-2.5 text-[var(--color-text-muted)]" />
      </div>
    </div>
  );
}

export { ResizablePanelGroup, ResizablePanel, ResizableHandle };
