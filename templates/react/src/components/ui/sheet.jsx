import React, { useEffect } from "react";
import { cn } from "../../lib/utils";
import { X } from "lucide-react";

const sideClasses = {
  right: "inset-y-0 right-0 h-full w-3/4 sm:max-w-sm translate-x-0 data-[state=closed]:translate-x-full",
  left: "inset-y-0 left-0 h-full w-3/4 sm:max-w-sm translate-x-0 data-[state=closed]:-translate-x-full",
  top: "inset-x-0 top-0 w-full h-auto data-[state=closed]:-translate-y-full",
  bottom: "inset-x-0 bottom-0 w-full h-auto data-[state=closed]:translate-y-full",
};

function Sheet({ open, onOpenChange, children }) {
  useEffect(() => {
    if (open) document.body.style.overflow = "hidden";
    else document.body.style.overflow = "";
    return () => { document.body.style.overflow = ""; };
  }, [open]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50">
      <div className="fixed inset-0 bg-black/50 backdrop-blur-sm" onClick={() => onOpenChange?.(false)} />
      {children}
    </div>
  );
}

function SheetContent({ children, className, side = "right", onClose, ...props }) {
  useEffect(() => {
    const handler = (e) => { if (e.key === "Escape") onClose?.(); };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose]);

  return (
    <div
      className={cn(
        "fixed z-50 gap-4 bg-white p-6 shadow-[var(--shadow-lg)] transition-transform duration-300 ease-in-out",
        sideClasses[side],
        className
      )}
      {...props}
    >
      {onClose && (
        <button onClick={onClose} className="absolute right-4 top-4 rounded-sm opacity-70 hover:opacity-100" aria-label="Fermer">
          <X size={16} />
        </button>
      )}
      {children}
    </div>
  );
}

function SheetHeader({ className, ...props }) {
  return <div className={cn("flex flex-col space-y-2 mb-4", className)} {...props} />;
}

function SheetTitle({ className, ...props }) {
  return <h2 className={cn("text-lg font-semibold text-[var(--color-text)]", className)} {...props} />;
}

function SheetDescription({ className, ...props }) {
  return <p className={cn("text-sm text-[var(--color-text-muted)]", className)} {...props} />;
}

export { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription };
