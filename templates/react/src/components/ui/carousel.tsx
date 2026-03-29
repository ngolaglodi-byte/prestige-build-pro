import React, { useState, useCallback } from "react";
import { cn } from "../../lib/utils";
import { ChevronLeft, ChevronRight } from "lucide-react";

interface CarouselProps {
  children: React.ReactNode;
  className?: string;
  autoPlay?: boolean;
  interval?: number;
}

function Carousel({ children, className, autoPlay = false, interval = 5000 }: CarouselProps) {
  const items = React.Children.toArray(children);
  const [current, setCurrent] = useState(0);
  const total = items.length;

  const prev = useCallback(() => setCurrent((c) => (c - 1 + total) % total), [total]);
  const next = useCallback(() => setCurrent((c) => (c + 1) % total), [total]);

  React.useEffect(() => {
    if (!autoPlay) return;
    const t = setInterval(next, interval);
    return () => clearInterval(t);
  }, [autoPlay, interval, next]);

  return (
    <div className={cn("relative overflow-hidden", className)}>
      <div className="flex transition-transform duration-300 ease-in-out" style={{ transform: `translateX(-${current * 100}%)` }}>
        {items.map((child, i) => (
          <div key={i} className="w-full flex-shrink-0">{child}</div>
        ))}
      </div>
      {total > 1 && (
        <>
          <button onClick={prev} className="absolute left-2 top-1/2 -translate-y-1/2 rounded-full bg-white/80 p-2 shadow-[var(--shadow-md)] hover:bg-white transition-colors" aria-label="Précédent">
            <ChevronLeft size={20} />
          </button>
          <button onClick={next} className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full bg-white/80 p-2 shadow-[var(--shadow-md)] hover:bg-white transition-colors" aria-label="Suivant">
            <ChevronRight size={20} />
          </button>
          <div className="absolute bottom-3 left-1/2 -translate-x-1/2 flex gap-1.5">
            {items.map((_, i) => (
              <button key={i} onClick={() => setCurrent(i)} className={cn("h-2 w-2 rounded-full transition-colors", i === current ? "bg-[var(--color-primary)]" : "bg-white/60")} aria-label={`Slide ${i + 1}`} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function CarouselItem({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn("p-1", className)}>{children}</div>;
}

export { Carousel, CarouselItem };
