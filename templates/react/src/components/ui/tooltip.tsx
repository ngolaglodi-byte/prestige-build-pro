import React from "react";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { cn } from "@/lib/utils";

const TooltipProvider = TooltipPrimitive.Provider;
const Tooltip = TooltipPrimitive.Root;
const TooltipTrigger = TooltipPrimitive.Trigger;

const TooltipContent = React.forwardRef(({ className, sideOffset = 4, ...props }, ref) => (
  <TooltipPrimitive.Content ref={ref} sideOffset={sideOffset} className={cn("z-50 overflow-hidden rounded-[var(--radius-md)] bg-[var(--color-text)] px-3 py-1.5 text-xs text-white shadow-[var(--shadow-md)] animate-in", className)} {...props} />
));

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider };
