import React, { useState, useMemo } from "react";
import { cn } from "@/lib/utils";
import { Search } from "lucide-react";

function Command({ children, className }) {
  const [search, setSearch] = useState("");
  return (
    <div className={cn("flex h-full w-full flex-col overflow-hidden rounded-[var(--radius-lg)] bg-white border border-[var(--color-border)]", className)}>
      {React.Children.map(children, (child) =>
        child ? React.cloneElement(child, { search, setSearch }) : null
      )}
    </div>
  );
}

function CommandInput({ placeholder = "Rechercher...", className, search, setSearch }) {
  return (
    <div className="flex items-center border-b border-[var(--color-border)] px-3">
      <Search size={16} className="mr-2 shrink-0 text-[var(--color-text-muted)]" />
      <input
        className={cn("flex h-11 w-full rounded-md bg-transparent py-3 text-sm text-[var(--color-text)] outline-none placeholder:text-[var(--color-text-muted)]", className)}
        placeholder={placeholder}
        value={search || ""}
        onChange={(e) => setSearch?.(e.target.value)}
      />
    </div>
  );
}

function CommandList({ children, className, search }) {
  return (
    <div className={cn("max-h-[300px] overflow-y-auto overflow-x-hidden p-1", className)}>
      {React.Children.map(children, (child) =>
        child ? React.cloneElement(child, { search }) : null
      )}
    </div>
  );
}

function CommandGroup({ heading, children, className, search }) {
  return (
    <div className={cn("overflow-hidden p-1", className)}>
      {heading && <p className="px-2 py-1.5 text-xs font-medium text-[var(--color-text-muted)]">{heading}</p>}
      {React.Children.map(children, (child) =>
        child ? React.cloneElement(child, { search }) : null
      )}
    </div>
  );
}

function CommandItem({ children, className, onSelect, value, search }) {
  const text = value || (typeof children === "string" ? children : "");
  if (search && text && !text.toLowerCase().includes(search.toLowerCase())) return null;
  return (
    <button
      className={cn(
        "relative flex w-full cursor-pointer select-none items-center rounded-[var(--radius-sm)] px-2 py-1.5 text-sm text-[var(--color-text)] outline-none hover:bg-[var(--color-surface)] transition-colors",
        className
      )}
      onClick={() => onSelect?.(value || text)}
    >
      {children}
    </button>
  );
}

function CommandEmpty({ children, className, search }) {
  return <p className={cn("py-6 text-center text-sm text-[var(--color-text-muted)]", className)}>{children || "Aucun résultat."}</p>;
}

export { Command, CommandInput, CommandList, CommandGroup, CommandItem, CommandEmpty };
