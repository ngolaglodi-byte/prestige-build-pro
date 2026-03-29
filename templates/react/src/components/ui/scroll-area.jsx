import React from "react";
import { cn } from "../../lib/utils";

function ScrollArea({ children, className, maxHeight = "400px", ...props }) {
  return (
    <div
      className={cn("relative overflow-hidden", className)}
      style={{ maxHeight }}
      {...props}
    >
      <div className="h-full overflow-y-auto overflow-x-hidden pr-2 scrollbar-thin scrollbar-thumb-gray-300 scrollbar-track-transparent">
        {children}
      </div>
    </div>
  );
}

export { ScrollArea };
