import React, { useState, useRef } from "react";
import { cn } from "../../lib/utils";

interface InputOTPProps {
  length?: number;
  value?: string;
  onChange?: (value: string) => void;
  className?: string;
}

function InputOTP({ length = 6, value: controlled, onChange, className }: InputOTPProps) {
  const [internal, setInternal] = useState("");
  const value = controlled !== undefined ? controlled : internal;
  const refs = useRef<(HTMLInputElement | null)[]>([]);

  const handleChange = (index: number, char: string) => {
    const newValue = value.split("");
    newValue[index] = char.slice(-1);
    const result = newValue.join("").slice(0, length);
    setInternal(result);
    onChange?.(result);
    if (char && index < length - 1) refs.current[index + 1]?.focus();
  };

  const handleKeyDown = (index: number, e: React.KeyboardEvent) => {
    if (e.key === "Backspace" && !value[index] && index > 0) {
      refs.current[index - 1]?.focus();
    }
  };

  return (
    <div className={cn("flex items-center gap-2", className)}>
      {Array.from({ length }, (_, i) => (
        <input
          key={i}
          ref={(el) => { refs.current[i] = el; }}
          type="text"
          inputMode="numeric"
          maxLength={1}
          value={value[i] || ""}
          onChange={(e) => handleChange(i, e.target.value)}
          onKeyDown={(e) => handleKeyDown(i, e)}
          className="h-10 w-10 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-white text-center text-sm font-medium shadow-[var(--shadow-sm)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]"
        />
      ))}
    </div>
  );
}

export { InputOTP };
