import React, { useState } from "react";
import { cn } from "../../lib/utils";

function Tabs({ defaultValue, children, className, onValueChange }) {
  const [active, setActive] = useState(defaultValue);
  const handleChange = (val) => { setActive(val); onValueChange?.(val); };

  return (
    <div className={className} data-active-tab={active}>
      {React.Children.map(children, (child) =>
        child ? React.cloneElement(child, { activeTab: active, onTabChange: handleChange }) : null
      )}
    </div>
  );
}

function TabsList({ className, children, activeTab, onTabChange }) {
  return (
    <div className={cn("inline-flex h-10 items-center justify-center rounded-[var(--radius-md)] bg-[var(--color-surface)] p-1 gap-1", className)}>
      {React.Children.map(children, (child) =>
        child ? React.cloneElement(child, { activeTab, onTabChange }) : null
      )}
    </div>
  );
}

function TabsTrigger({ value, children, className, activeTab, onTabChange }) {
  const isActive = activeTab === value;
  return (
    <button
      className={cn(
        "inline-flex items-center justify-center whitespace-nowrap rounded-[var(--radius-sm)] px-3 py-1.5 text-sm font-medium transition-all",
        isActive ? "bg-white text-[var(--color-text)] shadow-[var(--shadow-sm)]" : "text-[var(--color-text-muted)] hover:text-[var(--color-text)]",
        className
      )}
      onClick={() => onTabChange?.(value)}
    >
      {children}
    </button>
  );
}

function TabsContent({ value, children, className, activeTab }) {
  if (activeTab !== value) return null;
  return <div className={cn("mt-2 animate-in", className)}>{children}</div>;
}

export { Tabs, TabsList, TabsTrigger, TabsContent };
