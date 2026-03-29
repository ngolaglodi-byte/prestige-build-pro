import React, { useState } from "react";
import { cn } from "../../lib/utils";

function Collapsible({ open: controlledOpen, onOpenChange, defaultOpen = false, children, className }) {
  const [internalOpen, setInternalOpen] = useState(defaultOpen);
  const isOpen = controlledOpen !== undefined ? controlledOpen : internalOpen;
  const toggle = () => {
    const next = !isOpen;
    setInternalOpen(next);
    onOpenChange?.(next);
  };

  return (
    <div className={className}>
      {React.Children.map(children, (child) =>
        child ? React.cloneElement(child, { isOpen, toggle }) : null
      )}
    </div>
  );
}

function CollapsibleTrigger({ children, className, toggle, isOpen, ...props }) {
  return (
    <button className={className} onClick={toggle} aria-expanded={isOpen} {...props}>
      {children}
    </button>
  );
}

function CollapsibleContent({ children, className, isOpen }) {
  if (!isOpen) return null;
  return <div className={cn("animate-in", className)}>{children}</div>;
}

export { Collapsible, CollapsibleTrigger, CollapsibleContent };
