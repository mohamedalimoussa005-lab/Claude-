import type { TimeSlot } from "../../booking/types";
import { formatTime } from "../../booking/availability";
import "./reservation.css";

interface TimeStepProps {
  slots: TimeSlot[];
  loading: boolean;
  selectedTime: string | null;
  onSelect: (time: string) => void;
}

export function TimeStep({ slots, loading, selectedTime, onSelect }: TimeStepProps) {
  return (
    <div className="rsv-step">
      <p className="eyebrow">Étape 03</p>
      <h1 className="rsv-step__title">Choisissez un horaire.</h1>

      {loading ? (
        <p className="rsv-step__loading">Chargement des créneaux…</p>
      ) : slots.length === 0 ? (
        <p className="rsv-step__loading">Aucun créneau ce jour-là — choisissez une autre date.</p>
      ) : (
        <div className="rsv-time-grid">
          {slots.map((slot) => {
            const time = formatTime(new Date(slot.start));
            return (
              <button
                key={slot.start}
                type="button"
                className={`rsv-time-slot ${selectedTime === time ? "rsv-time-slot--selected" : ""}`}
                onClick={() => onSelect(time)}
                aria-pressed={selectedTime === time}
              >
                {time}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
