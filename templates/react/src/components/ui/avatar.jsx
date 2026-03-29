import React from "react";
import { cn } from "../../lib/utils";

function Avatar({ className, ...props }) {
  return <span className={cn("relative flex h-10 w-10 shrink-0 overflow-hidden rounded-full", className)} {...props} />;
}

function AvatarImage({ src, alt, className, ...props }) {
  const [error, setError] = React.useState(false);
  if (error || !src) return null;
  return <img src={src} alt={alt || ""} className={cn("aspect-square h-full w-full object-cover", className)} onError={() => setError(true)} {...props} />;
}

function AvatarFallback({ className, children, ...props }) {
  return (
    <span className={cn("flex h-full w-full items-center justify-center rounded-full bg-[var(--color-surface)] text-sm font-medium text-[var(--color-text-muted)]", className)} {...props}>
      {children}
    </span>
  );
}

export { Avatar, AvatarImage, AvatarFallback };
