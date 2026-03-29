import React, { useState, useRef, useCallback } from "react";
import { cn } from "../../lib/utils";

function Slider({ value: controlledValue, onValueChange, min = 0, max = 100, step = 1, defaultValue = 50, className, disabled }) {
  const [internalValue, setInternalValue] = useState(defaultValue);
  const value = controlledValue !== undefined ? controlledValue : internalValue;
  const percent = ((value - min) / (max - min)) * 100;

  const handleChange = (e) => {
    const v = Number(e.target.value);
    setInternalValue(v);
    onValueChange?.(v);
  };

  return (
    <div className={cn("relative flex w-full touch-none select-none items-center", disabled && "opacity-50", className)}>
      <div className="relative h-2 w-full rounded-full bg-[var(--color-surface)]">
        <div className="absolute h-full rounded-full bg-[var(--color-primary)]" style={{ width: `${percent}%` }} />
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={handleChange}
        disabled={disabled}
        className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={value}
      />
      <div
        className="absolute h-5 w-5 rounded-full border-2 border-[var(--color-primary)] bg-white shadow-[var(--shadow-sm)] transition-transform focus-visible:outline-none pointer-events-none"
        style={{ left: `calc(${percent}% - 10px)` }}
      />
    </div>
  );
}

export { Slider };
