import { formatSeatLabel, type Seat, type Wagon } from "@pas/shared";
import { useRef } from "react";
import { EASE, gsap, useGsap } from "../lib/motion";

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
    <section ref={root} className="card overflow-hidden p-5 sm:p-10" aria-label={`Plan wagonu ${wagon.number}`}>
      <p className="mb-12 text-center text-[15px] text-muted" aria-live="polite">
        <strong className="text-ink">{free}</strong> wolnych, <strong className="text-ink">{wagon.seats.length - free}</strong>{" "}
        zajętych
      </p>

      <div className="wagon-body">
        <span className="text-[13px] font-semibold text-muted [writing-mode:vertical-rl] max-[720px]:[writing-mode:initial] min-[721px]:rotate-180" aria-hidden="true">
          kierunek jazdy
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

      <ul className="mt-12 flex flex-wrap justify-center gap-x-7 gap-y-3 text-[14px] text-muted" aria-label="Legenda">
        <li className="inline-flex items-center gap-2">
          <span className="h-[18px] w-[22px] rounded-[5px] border-2 border-ink/70 bg-surface" aria-hidden="true" />
          wolne
        </li>
        <li className="inline-flex items-center gap-2">
          <span
            className="h-[18px] w-[22px] rounded-[5px] border-2 border-line"
            style={{ background: "repeating-linear-gradient(135deg, var(--c-raised) 0 3px, transparent 3px 6px)" }}
            aria-hidden="true"
          />
          zajęte
        </li>
        <li className="inline-flex items-center gap-2">
          <span className="h-[5px] w-[22px] rounded-full bg-glass" aria-hidden="true" />
          przy oknie
        </li>
        <li className="inline-flex items-center gap-2">
          <span className="flex items-center gap-[3px]" aria-hidden="true">
            <span className="h-[14px] w-[8px] rounded-[3px] border-2 border-ink/50" />
            <span className="h-[14px] w-[8px] rounded-[3px] border-2 border-ink/50" />
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
