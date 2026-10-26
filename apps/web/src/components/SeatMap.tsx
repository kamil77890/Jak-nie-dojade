import { formatSeatLabel, type Seat, type Wagon } from "@pas/shared";
import { seatsInWagonLabel } from "../lib/format";

interface SeatMapProps {
  wagon: Wagon;
  takenSeats: Set<string>;
  onSeatClick: (seat: Seat) => void;
}

const ROW_LABELS = ["A", "B", "C", "D", "E"];

export function SeatMap({ wagon, takenSeats, onSeatClick }: SeatMapProps) {
  const rows: Seat[][] = [];
  for (let index = 0; index < wagon.seats.length; index += 4) {
    rows.push(wagon.seats.slice(index, index + 4));
  }

  const free = wagon.seats.filter((seat) => !takenSeats.has(seat.id)).length;
  const occupied = wagon.seats.length - free;

  return (
    <section className="train-card" aria-label={`Mapa wagonu ${wagon.number}`}>
      <div className="train-card-head">
        <div>
          <p className="eyebrow">Wnętrze wagonu</p>
          <h2>Wagon {wagon.number}</h2>
        </div>
        <div className="wagon-counts" aria-live="polite">
          <span>
            <strong>{free}</strong> wolnych
          </span>
          <span className="wagon-counts-divider" aria-hidden="true" />
          <span>
            <strong>{occupied}</strong> zajętych
          </span>
        </div>
      </div>

      <div className="wagon-frame">
        <div className="wagon-nose" aria-hidden="true">
          <span>← przód pociągu</span>
          <span className="wagon-door" />
        </div>

        <div className="seat-map" role="group" aria-label={`Miejsca w wagonie ${wagon.number}`}>
          {rows.map((row, rowIndex) => (
            <div className="seat-row" key={row[0]?.id ?? rowIndex}>
              <span className="row-letter" aria-hidden="true">
                {ROW_LABELS[rowIndex] ?? ""}
              </span>
              <div className="seat-pair">
                {row.slice(0, 2).map((seat) => (
                  <SeatButton
                    key={seat.id}
                    seat={seat}
                    occupied={takenSeats.has(seat.id)}
                    onSeatClick={onSeatClick}
                  />
                ))}
              </div>
              <span className="aisle" aria-hidden="true" />
              <div className="seat-pair">
                {row.slice(2).map((seat) => (
                  <SeatButton
                    key={seat.id}
                    seat={seat}
                    occupied={takenSeats.has(seat.id)}
                    onSeatClick={onSeatClick}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>

        <div className="wagon-legend">
          <span className="legend-item">
            <span className="legend-seat" aria-hidden="true" />
            wolne
          </span>
          <span className="legend-item">
            <span className="legend-seat legend-seat--occupied" aria-hidden="true" />
            zajęte
          </span>
          <span className="legend-item">
            <span className="legend-window" aria-hidden="true" />
            przy oknie
          </span>
          <span className="legend-note">{seatsInWagonLabel(wagon.seats.length)} w wagonie</span>
        </div>
      </div>
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
      className={`seat ${seat.position === "window" ? "seat--window" : ""} ${
        occupied ? "seat--occupied" : ""
      }`}
      onClick={() => onSeatClick(seat)}
      disabled={occupied}
      aria-label={label}
      title={occupied ? `${formatSeatLabel(seat.id)} — zajęte` : `${formatSeatLabel(seat.id)} — wybierz`}
    >
      <span className="seat-number">{seat.number}</span>
      {seat.position === "window" ? <span className="seat-edge" aria-hidden="true" /> : null}
    </button>
  );
}
