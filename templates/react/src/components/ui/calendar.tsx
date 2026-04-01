import * as React from "react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { ChevronLeft, ChevronRight } from "lucide-react"

interface CalendarProps {
  selected?: Date
  onSelect?: (date: Date | undefined) => void
  className?: string
  mode?: "single" | "range"
}

export function Calendar({ selected, onSelect, className, mode = "single" }: CalendarProps) {
  const [currentMonth, setCurrentMonth] = React.useState(selected || new Date())

  const year = currentMonth.getFullYear()
  const month = currentMonth.getMonth()

  const firstDay = new Date(year, month, 1).getDay()
  const daysInMonth = new Date(year, month + 1, 0).getDate()

  const monthNames = ["Janvier", "Février", "Mars", "Avril", "Mai", "Juin", "Juillet", "Août", "Septembre", "Octobre", "Novembre", "Décembre"]
  const dayNames = ["Lu", "Ma", "Me", "Je", "Ve", "Sa", "Di"]

  const prevMonth = () => setCurrentMonth(new Date(year, month - 1, 1))
  const nextMonth = () => setCurrentMonth(new Date(year, month + 1, 1))

  const days: (number | null)[] = []
  const startDay = firstDay === 0 ? 6 : firstDay - 1
  for (let i = 0; i < startDay; i++) days.push(null)
  for (let i = 1; i <= daysInMonth; i++) days.push(i)

  const isSelected = (day: number) => {
    if (!selected || !day) return false
    return selected.getDate() === day && selected.getMonth() === month && selected.getFullYear() === year
  }

  const isToday = (day: number) => {
    const today = new Date()
    return today.getDate() === day && today.getMonth() === month && today.getFullYear() === year
  }

  return (
    <div className={cn("p-3", className)}>
      <div className="flex items-center justify-between mb-4">
        <Button variant="outline" size="icon" className="h-7 w-7" onClick={prevMonth}>
          <ChevronLeft className="h-4 w-4" />
        </Button>
        <span className="text-sm font-medium">{monthNames[month]} {year}</span>
        <Button variant="outline" size="icon" className="h-7 w-7" onClick={nextMonth}>
          <ChevronRight className="h-4 w-4" />
        </Button>
      </div>
      <div className="grid grid-cols-7 gap-1 mb-2">
        {dayNames.map(d => (
          <div key={d} className="text-center text-xs text-muted-foreground font-medium py-1">{d}</div>
        ))}
      </div>
      <div className="grid grid-cols-7 gap-1">
        {days.map((day, i) => (
          <div key={i} className="text-center">
            {day ? (
              <button
                onClick={() => onSelect?.(new Date(year, month, day))}
                className={cn(
                  "h-8 w-8 rounded-md text-sm inline-flex items-center justify-center transition-colors",
                  isSelected(day) && "bg-primary text-primary-foreground",
                  isToday(day) && !isSelected(day) && "bg-accent text-accent-foreground font-bold",
                  !isSelected(day) && !isToday(day) && "hover:bg-accent hover:text-accent-foreground"
                )}
              >
                {day}
              </button>
            ) : <span className="h-8 w-8" />}
          </div>
        ))}
      </div>
    </div>
  )
}
