import { useMemo, useState } from "react";
import { formatDateISO } from "../../booking/availability";
import "./reservation.css";

interface DateStepProps {
  availableDates: string[];
  loading: boolean;
  selectedDate: string | null;
  onSelect: (dateISO: string) => void;
}

const WEEKDAY_LABELS = ["L", "M", "M", "J", "V", "S", "D"];

function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

function addMonths(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth() + n, 1);
}

function monthLabel(d: Date): string {
  const label = new Intl.DateTimeFormat("fr-FR", { month: "long", year: "numeric" }).format(d);
  return label.charAt(0).toUpperCase() + label.slice(1);
}

export function DateStep({ availableDates, loading, selectedDate, onSelect }: DateStepProps) {
  const [visibleMonth, setVisibleMonth] = useState(() => startOfMonth(new Date()));
  const availableSet = useMemo(() => new Set(availableDates), [availableDates]);

  const canGoPrev = visibleMonth > startOfMonth(new Date());
  const nextMonthStart = addMonths(visibleMonth, 1);
  const canGoNext = availableDates.some((d) => new Date(`${d}T00:00:00`) >= nextMonthStart);

  const cells = useMemo(() => {
    const firstDay = startOfMonth(visibleMonth);
    const leadingBlanks = (firstDay.getDay() + 6) % 7; // Monday-start offset
    const daysInMonth = new Date(firstDay.getFullYear(), firstDay.getMonth() + 1, 0).getDate();

    const list: Array<{ date: Date; dateISO: string } | null> = [];
    for (let i = 0; i < leadingBlanks; i++) list.push(null);
    for (let day = 1; day <= daysInMonth; day++) {
      const date = new Date(firstDay.getFullYear(), firstDay.getMonth(), day);
      list.push({ date, dateISO: formatDateISO(date) });
    }
    return list;
  }, [visibleMonth]);

  return (
    <div className="rsv-step">
      <p className="eyebrow">Étape 02</p>
      <h1 className="rsv-step__title">Choisissez une date.</h1>

      {loading ? (
        <p className="rsv-step__loading">Chargement des disponibilités…</p>
      ) : (
        <div className="rsv-calendar">
          <div className="rsv-calendar__nav">
            <button type="button" onClick={() => setVisibleMonth((m) => addMonths(m, -1))} disabled={!canGoPrev} aria-label="Mois précédent">
              ←
            </button>
            <span className="rsv-calendar__month">{monthLabel(visibleMonth)}</span>
            <button type="button" onClick={() => setVisibleMonth((m) => addMonths(m, 1))} disabled={!canGoNext} aria-label="Mois suivant">
              →
            </button>
          </div>

          <div className="rsv-calendar__weekdays">
            {WEEKDAY_LABELS.map((w, i) => (
              <span key={`${w}-${i}`}>{w}</span>
            ))}
          </div>

          <div className="rsv-calendar__grid">
            {cells.map((cell, i) => {
              if (!cell) return <span key={`blank-${i}`} className="rsv-calendar__cell rsv-calendar__cell--blank" />;
              const available = availableSet.has(cell.dateISO);
              const selected = cell.dateISO === selectedDate;
              return (
                <button
                  key={cell.dateISO}
                  type="button"
                  className={`rsv-calendar__cell ${available ? "rsv-calendar__cell--available" : ""} ${selected ? "rsv-calendar__cell--selected" : ""}`}
                  disabled={!available}
                  onClick={() => onSelect(cell.dateISO)}
                  aria-pressed={selected}
                >
                  {cell.date.getDate()}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
