import { cn } from "../../lib/utils";

function Skeleton({ className, ...props }) {
  return (
    <div className={cn("animate-pulse rounded-[var(--radius-md)] bg-gray-200", className)} {...props} />
  );
}

export { Skeleton };
