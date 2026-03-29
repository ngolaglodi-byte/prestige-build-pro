import React, { useState } from "react";
import { cn } from "../../lib/utils";
import { Calendar, ChevronLeft, ChevronRight } from "lucide-react";

function DatePicker({ value, onChange, placeholder = "Sélectionner une date", className }) {
  const [open, setOpen] = useState(false);
  const [viewDate, setViewDate] = useState(value ? new Date(value) : new Date());

  const year = viewDate.getFullYear();
  const month = viewDate.getMonth();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const firstDay = new Date(year, month, 1).getDay();
  const startOffset = firstDay === 0 ? 6 : firstDay - 1; // Monday start

  const monthNames = ["Janvier", "Février", "Mars", "Avril", "Mai", "Juin", "Juillet", "Août", "Septembre", "Octobre", "Novembre", "Décembre"];
  const dayNames = ["Lu", "Ma", "Me", "Je", "Ve", "Sa", "Di"];

  const prevMonth = () => setViewDate(new Date(year, month - 1, 1));
  const nextMonth = () => setViewDate(new Date(year, month + 1, 1));

  const selectDate = (day) => {
    const d = new Date(year, month, day);
    const iso = d.toISOString().split("T")[0];
    onChange?.(iso);
    setOpen(false);
  };

  const selected = value ? new Date(value) : null;
  const isSelected = (day) => selected && selected.getFullYear() === year && selected.getMonth() === month && selected.getDate() === day;
  const isToday = (day) => { const t = new Date(); return t.getFullYear() === year && t.getMonth() === month && t.getDate() === day; };

  const displayValue = value ? new Date(value).toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric" }) : placeholder;

  return (
    <div className="relative inline-block">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className={cn(
          "flex h-10 w-full items-center justify-between rounded-[var(--radius-md)] border border-[var(--color-border)] bg-white px-3 py-2 text-sm text-[var(--color-text)] ring-offset-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)] focus-visible:ring-offset-2",
          !value && "text-[var(--color-text-muted)]",
          className
        )}
      >
        <span>{displayValue}</span>
        <Calendar size={16} className="text-[var(--color-text-muted)]" />
      </button>
      {open && (
        <div className="absolute z-50 mt-2 w-auto rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-white p-3 shadow-[var(--shadow-lg)] animate-in">
          <div className="flex items-center justify-between mb-2">
            <button onClick={prevMonth} className="p-1 hover:bg-[var(--color-surface)] rounded" aria-label="Mois précédent"><ChevronLeft size={16} /></button>
            <span className="text-sm font-medium">{monthNames[month]} {year}</span>
            <button onClick={nextMonth} className="p-1 hover:bg-[var(--color-surface)] rounded" aria-label="Mois suivant"><ChevronRight size={16} /></button>
          </div>
          <div className="grid grid-cols-7 gap-1 text-center">
            {dayNames.map((d) => <div key={d} className="text-xs font-medium text-[var(--color-text-muted)] py-1">{d}</div>)}
            {Array.from({ length: startOffset }).map((_, i) => <div key={`e${i}`} />)}
            {Array.from({ length: daysInMonth }, (_, i) => i + 1).map((day) => (
              <button
                key={day}
                onClick={() => selectDate(day)}
                className={cn(
                  "h-8 w-8 rounded-[var(--radius-sm)] text-sm transition-colors hover:bg-[var(--color-surface)]",
                  isSelected(day) && "bg-[var(--color-primary)] text-white hover:bg-[var(--color-primary-hover)]",
                  isToday(day) && !isSelected(day) && "border border-[var(--color-primary)] text-[var(--color-primary)]"
                )}
              >
                {day}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export { DatePicker };
