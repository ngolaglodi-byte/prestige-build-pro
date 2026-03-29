import React, { useState, useRef } from "react";
import { cn } from "../../lib/utils";

function Tooltip({ children, content, side = "top", className }) {
  const [visible, setVisible] = useState(false);
  const timeout = useRef(null);

  const show = () => { clearTimeout(timeout.current); timeout.current = setTimeout(() => setVisible(true), 200); };
  const hide = () => { clearTimeout(timeout.current); setVisible(false); };

  const positions = {
    top: "bottom-full left-1/2 -translate-x-1/2 mb-2",
    bottom: "top-full left-1/2 -translate-x-1/2 mt-2",
    left: "right-full top-1/2 -translate-y-1/2 mr-2",
    right: "left-full top-1/2 -translate-y-1/2 ml-2",
  };

  return (
    <span className="relative inline-flex" onMouseEnter={show} onMouseLeave={hide} onFocus={show} onBlur={hide}>
      {children}
      {visible && (
        <span
          role="tooltip"
          className={cn(
            "absolute z-50 whitespace-nowrap rounded-[var(--radius-md)] bg-[var(--color-text)] px-3 py-1.5 text-xs text-white shadow-[var(--shadow-md)] animate-in pointer-events-none",
            positions[side],
            className
          )}
        >
          {content}
        </span>
      )}
    </span>
  );
}

export { Tooltip };
