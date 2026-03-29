import React, { useState } from "react";
import { cn } from "../../lib/utils";
import { ChevronDown } from "lucide-react";

function Accordion({ children, className, type = "single" }) {
  const [openItems, setOpenItems] = useState(new Set());
  const toggle = (value) => {
    setOpenItems((prev) => {
      const next = new Set(prev);
      if (next.has(value)) { next.delete(value); }
      else { if (type === "single") next.clear(); next.add(value); }
      return next;
    });
  };
  return (
    <div className={className}>
      {React.Children.map(children, (child) =>
        child ? React.cloneElement(child, { openItems, toggle }) : null
      )}
    </div>
  );
}

function AccordionItem({ value, children, className, openItems, toggle }) {
  return (
    <div className={cn("border-b border-[var(--color-border)]", className)}>
      {React.Children.map(children, (child) =>
        child ? React.cloneElement(child, { value, isOpen: openItems?.has(value), toggle }) : null
      )}
    </div>
  );
}

function AccordionTrigger({ children, className, value, isOpen, toggle }) {
  return (
    <button
      className={cn("flex w-full items-center justify-between py-4 font-medium text-[var(--color-text)] transition-all hover:underline text-left", className)}
      onClick={() => toggle?.(value)}
      aria-expanded={isOpen}
    >
      {children}
      <ChevronDown size={16} className={cn("shrink-0 transition-transform duration-200", isOpen && "rotate-180")} />
    </button>
  );
}

function AccordionContent({ children, className, isOpen }) {
  if (!isOpen) return null;
  return (
    <div className={cn("overflow-hidden text-sm text-[var(--color-text-muted)] pb-4 animate-in", className)}>
      {children}
    </div>
  );
}

export { Accordion, AccordionItem, AccordionTrigger, AccordionContent };
