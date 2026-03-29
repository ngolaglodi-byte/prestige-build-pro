import React from "react";
import { cn } from "../../lib/utils";

const variantStyles = {
  default: "bg-white border-[var(--color-border)] text-[var(--color-text)]",
  success: "bg-green-50 border-[var(--color-success)] text-green-800",
  destructive: "bg-red-50 border-[var(--color-error)] text-red-800",
};

export function Toaster({ toasts = [], onDismiss }) {
  if (toasts.length === 0) return null;

  return (
    <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 w-full max-w-sm">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={cn(
            "rounded-[var(--radius-lg)] border p-4 shadow-[var(--shadow-lg)] animate-in slide-in-from-bottom-2 transition-all",
            variantStyles[t.variant] || variantStyles.default
          )}
          role="alert"
        >
          <div className="flex items-start justify-between gap-2">
            <div>
              {t.title && <p className="text-sm font-semibold">{t.title}</p>}
              {t.description && <p className="text-sm opacity-90 mt-1">{t.description}</p>}
            </div>
            <button
              onClick={() => onDismiss?.(t.id)}
              className="text-current opacity-50 hover:opacity-100 text-lg leading-none"
              aria-label="Fermer"
            >
              &times;
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
