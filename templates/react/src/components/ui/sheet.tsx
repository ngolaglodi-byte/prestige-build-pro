import React from "react";
import * as SheetPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { cn } from "../../lib/utils";

const Sheet = SheetPrimitive.Root;
const SheetTrigger = SheetPrimitive.Trigger;
const SheetClose = SheetPrimitive.Close;
const SheetPortal = SheetPrimitive.Portal;

const SheetOverlay = React.forwardRef(({ className, ...props }, ref) => (
  <SheetPrimitive.Overlay ref={ref} className={cn("fixed inset-0 z-50 bg-black/50 backdrop-blur-sm data-[state=open]:animate-in data-[state=closed]:animate-out", className)} {...props} />
));

const sideVariants = {
  top: "inset-x-0 top-0 border-b",
  bottom: "inset-x-0 bottom-0 border-t",
  left: "inset-y-0 left-0 h-full w-3/4 border-r sm:max-w-sm",
  right: "inset-y-0 right-0 h-full w-3/4 border-l sm:max-w-sm",
};

const SheetContent = React.forwardRef(({ side = "right", className, children, ...props }, ref) => (
  <SheetPortal>
    <SheetOverlay />
    <SheetPrimitive.Content ref={ref} className={cn("fixed z-50 gap-4 bg-white p-6 shadow-[var(--shadow-lg)] transition ease-in-out data-[state=open]:animate-in data-[state=open]:duration-300", sideVariants[side], className)} {...props}>
      {children}
      <SheetPrimitive.Close className="absolute right-4 top-4 rounded-sm opacity-70 transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]">
        <X className="h-4 w-4" />
        <span className="sr-only">Fermer</span>
      </SheetPrimitive.Close>
    </SheetPrimitive.Content>
  </SheetPortal>
));

const SheetHeader = ({ className, ...props }) => <div className={cn("flex flex-col space-y-2 text-center sm:text-left", className)} {...props} />;
const SheetFooter = ({ className, ...props }) => <div className={cn("flex flex-col-reverse sm:flex-row sm:justify-end sm:space-x-2", className)} {...props} />;
const SheetTitle = React.forwardRef(({ className, ...props }, ref) => <SheetPrimitive.Title ref={ref} className={cn("text-lg font-semibold text-[var(--color-text)]", className)} {...props} />);
const SheetDescription = React.forwardRef(({ className, ...props }, ref) => <SheetPrimitive.Description ref={ref} className={cn("text-sm text-[var(--color-text-muted)]", className)} {...props} />);

export { Sheet, SheetPortal, SheetOverlay, SheetTrigger, SheetClose, SheetContent, SheetHeader, SheetFooter, SheetTitle, SheetDescription };
