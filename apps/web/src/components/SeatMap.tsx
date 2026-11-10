import { formatSeatLabel, type Seat, type Wagon } from "@pas/shared";
import { useRef } from "react";
import { EASE, gsap, useGsap } from "../lib/motion";
import { ArrowLeft } from "./Icons";

interface SeatMapProps {
  wagon: Wagon;
  takenSeats: Set<string>;
  onSeatClick: (seat: Seat) => void;
}

/**
 * Plan wagonu z góry. Na szerokim ekranie rzędy idą w poziomie jak w prawdziwym
 * wagonie (okno u góry i u dołu, korytarz pośrodku), na telefonie — w pionie.
 */
export function SeatMap({ wagon, takenSeats, onSeatClick }: SeatMapProps) {
  const root = useRef<HTMLElement>(null);
  const rows: Seat[][] = [];
  for (let index = 0; index < wagon.seats.length; index += 4) {
    rows.push(wagon.seats.slice(index, index + 4));
  }

  const free = wagon.seats.filter((seat) => !takenSeats.has(seat.id)).length;

  // Po zmianie wagonu fotele wjeżdżają rząd po rzędzie.
  useGsap(
    root,
    () => {
      gsap.from(".seat-row", { y: 18, opacity: 0, duration: 0.9, stagger: 0.06, ease: EASE });
    },
    [wagon.id],
  );

  return (
    <section ref={root} className="seat-map-card card overflow-hidden p-5 sm:p-10" aria-label={`Plan wagonu ${wagon.number}`}>
      <p className="mb-12 text-center text-[15px] text-muted" aria-live="polite">
        <strong className="text-ink">{free}</strong> wolnych, <strong className="text-ink">{wagon.seats.length - free}</strong>{" "}
        zajętych
      </p>

      <div className="wagon-body">
        {/* Przód pociągu: po lewej na szerokim ekranie, u góry na telefonie (plan jest wtedy pionowy). */}
        <span className="travel-direction" aria-hidden="true">
          <span className="travel-direction-arrow">
            <ArrowLeft size={16} />
          </span>
          <span className="travel-direction-label">kierunek jazdy</span>
        </span>

        <div className="seat-map" role="group" aria-label={`Miejsca w wagonie ${wagon.number}`}>
          {rows.map((row, rowIndex) => (
            <div className="seat-row" key={row[0]?.id ?? rowIndex}>
              <div className="seat-pair">
                {row.slice(0, 2).map((seat) => (
                  <SeatButton key={seat.id} seat={seat} occupied={takenSeats.has(seat.id)} onSeatClick={onSeatClick} />
                ))}
              </div>
              <span className="aisle" aria-hidden="true" />
              <div className="seat-pair">
                {row.slice(2).map((seat) => (
                  <SeatButton key={seat.id} seat={seat} occupied={takenSeats.has(seat.id)} onSeatClick={onSeatClick} />
                ))}
              </div>
            </div>
          ))}
        </div>

        <span className="w-4 self-stretch border-l-[3px] border-ink/80 max-[720px]:h-3 max-[720px]:w-auto max-[720px]:border-l-0 max-[720px]:border-t-[3px]" aria-hidden="true" />
      </div>

      <ul className="seat-legend" aria-label="Legenda">
        <li>
          <span className="seat-legend-sample" aria-hidden="true" />
          wolne
        </li>
        <li>
          <span className="seat-legend-sample seat-legend-sample--taken" aria-hidden="true" />
          zajęte
        </li>
        <li>
          <span className="seat-legend-sample seat-legend-sample--window" aria-hidden="true" />
          przy oknie
        </li>
        <li>
          <span className="flex items-center gap-1" aria-hidden="true">
            <span className="seat-legend-sample !w-5" />
            <span className="h-7 border-l-2 border-dashed border-ink/30" />
            <span className="seat-legend-sample !w-5" />
          </span>
          przy korytarzu (miejsca 2 i 3 w rzędzie)
        </li>
      </ul>
    </section>
  );
}

function SeatButton({
  seat,
  occupied,
  onSeatClick,
}: {
  seat: Seat;
  occupied: boolean;
  onSeatClick: (seat: Seat) => void;
}) {
  const position = seat.position === "window" ? "przy oknie" : "przy korytarzu";
  const label = `${formatSeatLabel(seat.id)}, ${position}, ${occupied ? "zajęte" : "wolne"}`;

  return (
    <button
      type="button"
      className={`seat ${seat.position === "window" ? "seat--window" : "seat--aisle"} ${occupied ? "seat--occupied" : ""}`}
      onClick={() => onSeatClick(seat)}
      disabled={occupied}
      aria-label={label}
      title={occupied ? `${formatSeatLabel(seat.id)} — zajęte` : formatSeatLabel(seat.id)}
    >
      <span>{seat.number}</span>
    </button>
  );
}
