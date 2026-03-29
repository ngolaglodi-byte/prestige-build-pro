import React, { useState } from "react";
import { cn } from "@/lib/utils";
import { ChevronDown } from "lucide-react";

function NavigationMenu({ children, className }: { children: React.ReactNode; className?: string }) {
  return <nav className={cn("relative z-10 flex max-w-max flex-1 items-center justify-center", className)}>{children}</nav>;
}

function NavigationMenuList({ children, className }: { children: React.ReactNode; className?: string }) {
  return <ul className={cn("group flex flex-1 list-none items-center justify-center space-x-1", className)}>{children}</ul>;
}

function NavigationMenuItem({ children, className }: { children: React.ReactNode; className?: string }) {
  return <li className={cn("relative", className)}>{children}</li>;
}

function NavigationMenuTrigger({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <button className={cn("group inline-flex h-10 w-max items-center justify-center rounded-[var(--radius-md)] bg-white px-4 py-2 text-sm font-medium transition-colors hover:bg-[var(--color-surface)] focus:bg-[var(--color-surface)] focus:outline-none", className)}>
      {children}
      <ChevronDown className="relative top-[1px] ml-1 h-3 w-3 transition duration-200 group-data-[state=open]:rotate-180" />
    </button>
  );
}

function NavigationMenuContent({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("absolute left-0 top-full mt-1.5 w-auto min-w-[12rem] rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-white p-4 shadow-[var(--shadow-lg)] animate-in", className)}>
      {children}
    </div>
  );
}

function NavigationMenuLink({ href, children, className }: { href: string; children: React.ReactNode; className?: string }) {
  return (
    <a href={href} className={cn("block select-none space-y-1 rounded-[var(--radius-md)] p-3 leading-none no-underline outline-none transition-colors hover:bg-[var(--color-surface)] focus:bg-[var(--color-surface)]", className)}>
      {children}
    </a>
  );
}

export { NavigationMenu, NavigationMenuList, NavigationMenuItem, NavigationMenuTrigger, NavigationMenuContent, NavigationMenuLink };
