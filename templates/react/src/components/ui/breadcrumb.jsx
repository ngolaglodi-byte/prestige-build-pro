import React from "react";
import { cn } from "../../lib/utils";
import { ChevronRight } from "lucide-react";

function Breadcrumb({ children, className, ...props }) {
  return (
    <nav aria-label="fil d'ariane" className={className} {...props}>
      <ol className="flex flex-wrap items-center gap-1.5 text-sm text-[var(--color-text-muted)]">
        {children}
      </ol>
    </nav>
  );
}

function BreadcrumbItem({ children, className, ...props }) {
  return <li className={cn("inline-flex items-center gap-1.5", className)} {...props}>{children}</li>;
}

function BreadcrumbLink({ href, children, className, ...props }) {
  return (
    <a href={href} className={cn("transition-colors hover:text-[var(--color-text)]", className)} {...props}>
      {children}
    </a>
  );
}

function BreadcrumbPage({ children, className, ...props }) {
  return <span aria-current="page" className={cn("font-normal text-[var(--color-text)]", className)} {...props}>{children}</span>;
}

function BreadcrumbSeparator({ className }) {
  return <li role="presentation" className={className}><ChevronRight size={14} /></li>;
}

export { Breadcrumb, BreadcrumbItem, BreadcrumbLink, BreadcrumbPage, BreadcrumbSeparator };
