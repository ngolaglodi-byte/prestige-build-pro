import React, { createContext, useContext, useState } from "react";
import { cn } from "../../lib/utils";

const RadioGroupContext = createContext({ value: "", onChange: () => {} });

function RadioGroup({ value: controlledValue, onValueChange, defaultValue = "", children, className }) {
  const [internalValue, setInternalValue] = useState(defaultValue);
  const value = controlledValue !== undefined ? controlledValue : internalValue;
  const onChange = (v) => { setInternalValue(v); onValueChange?.(v); };

  return (
    <RadioGroupContext.Provider value={{ value, onChange }}>
      <div role="radiogroup" className={cn("grid gap-2", className)}>
        {children}
      </div>
    </RadioGroupContext.Provider>
  );
}

function RadioGroupItem({ value, id, className, disabled }) {
  const ctx = useContext(RadioGroupContext);
  const checked = ctx.value === value;

  return (
    <button
      role="radio"
      aria-checked={checked}
      id={id}
      disabled={disabled}
      className={cn(
        "aspect-square h-4 w-4 rounded-full border border-[var(--color-border)] text-[var(--color-primary)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)] focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50",
        checked && "border-[var(--color-primary)]",
        className
      )}
      onClick={() => ctx.onChange(value)}
    >
      {checked && (
        <span className="flex items-center justify-center">
          <span className="h-2.5 w-2.5 rounded-full bg-current" />
        </span>
      )}
    </button>
  );
}

export { RadioGroup, RadioGroupItem };
