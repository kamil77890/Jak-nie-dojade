import { formatCountdown, formatSeatLabel, type ReservationView, type Ticket } from "@pas/shared";
import { useRef, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router";
import { EmptyPanel } from "../components/Feedback";
import { ArrowLeft } from "../components/Icons";
import { PurchasePanel } from "../components/PurchasePanel";
import { TripSummary } from "../components/TripSummary";
import { timeFromIso } from "../lib/format";
import { EASE, gsap, useGsap } from "../lib/motion";
import { loadReservation } from "../lib/session";
import { useCountdown, useDocumentTitle } from "../hooks/useCountdown";

const RING_RADIUS = 46;
const RING_LENGTH = 2 * Math.PI * RING_RADIUS;

export function ReservationPage() {
  const { reservationId = "" } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const root = useRef<HTMLDivElement>(null);

  const [reservation] = useState<ReservationView | null>(() => {
    const state = location.state as { reservation?: ReservationView } | null;
    return state?.reservation ?? loadReservation(reservationId);
  });
  const [totalMs] = useState(() =>
    reservation ? Math.max(1, new Date(reservation.expiresAt).getTime() - Date.now()) : 1,
  );

  const { remainingMs, expired } = useCountdown(reservation?.expiresAt ?? new Date(0).toISOString());
  useDocumentTitle(reservation && !expired ? `${formatCountdown(remainingMs)} do końca rezerwacji` : "Rezerwacja");

  useGsap(
    root,
    () => {
      gsap.from(".hold-ring", { scale: 0.86, opacity: 0, duration: 1.4, ease: EASE });
      gsap.from(".intro", { y: 36, opacity: 0, duration: 1.2, stagger: 0.08, ease: EASE, delay: 0.1 });
    },
    [],
  );

  if (!reservation) {
    return (
      <div className="mx-auto max-w-[760px] px-4 py-16 sm:px-8">
        <EmptyPanel
          title="Nie widzimy tej rezerwacji"
          message="Dane rezerwacji zapisujemy tylko w karcie, w której ją zrobiono. Wróć do odjazdów i wybierz miejsce jeszcze raz."
          action={
            <Link className="btn btn-primary" to="/" viewTransition>
              Wróć do odjazdów
            </Link>
          }
        />
      </div>
    );
  }

  const urgent = !expired && remainingMs < 60_000;
  const progress = Math.max(0, Math.min(1, remainingMs / totalMs));
  const seatLabel = formatSeatLabel(reservation.seatId);
  const ringColor = expired ? "var(--c-line)" : urgent ? "var(--c-danger)" : "var(--color-accent)";

  function handlePurchased(ticket: Ticket) {
    navigate(`/reservations/${reservationId}/ticket`, { state: { ticket }, viewTransition: true });
  }

  return (
    <div ref={root} className="mx-auto max-w-[1320px] px-4 pb-24 pt-10 sm:px-8">
      <Link
        className="inline-flex items-center gap-2 text-[15px] font-semibold text-muted transition-colors hover:text-ink"
        to={`/events/${reservation.event.id}`}
        viewTransition
      >
        <ArrowLeft size={16} />
        Plan wagonu
      </Link>

      <div className="mt-8 grid items-start gap-6 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)] lg:gap-8">
        <section className="card flex flex-col items-center px-6 py-10 text-center sm:px-10 sm:py-14" aria-labelledby="hold-title">
          <h1 id="hold-title" className={`intro text-[clamp(24px,2.6vw,32px)] font-bold leading-tight condensed ${expired ? "text-danger" : ""}`}>
            {expired ? "Rezerwacja wygasła" : `${seatLabel} czeka na Ciebie`}
          </h1>

          <div className="hold-ring relative mt-8 aspect-square w-full max-w-[400px]">
            <svg viewBox="0 0 100 100" className="size-full -rotate-90" aria-hidden="true">
              <circle cx="50" cy="50" r={RING_RADIUS} fill="none" stroke="var(--c-raised)" strokeWidth="3" />
              <circle
                cx="50"
                cy="50"
                r={RING_RADIUS}
                fill="none"
                stroke={ringColor}
                strokeWidth="3"
                strokeLinecap="round"
                strokeDasharray={RING_LENGTH}
                strokeDashoffset={RING_LENGTH * (1 - progress)}
                style={{ transition: "stroke-dashoffset 250ms linear, stroke 600ms ease" }}
              />
            </svg>
            <div className="absolute inset-0 grid place-items-center">
              <div>
                <div
                  className={`text-[clamp(84px,11vw,140px)] font-extrabold leading-none tracking-[-0.02em] narrow ${
                    expired ? "text-muted/50" : urgent ? "text-danger" : ""
                  }`}
                  role="timer"
                  aria-live="off"
                  aria-label="Pozostały czas"
                >
                  {formatCountdown(remainingMs)}
                </div>
                <p className="mt-2 text-[15px] text-muted">{expired ? "po czasie" : "zostało"}</p>
              </div>
            </div>
          </div>

          <p className="intro mt-8 max-w-[40ch] text-[16px] text-muted">
            {expired
              ? "Miejsce wróciło do puli. Wybierz je ponownie, jeśli nadal jest wolne."
              : `Trzymamy miejsce do ${timeFromIso(reservation.expiresAt)}. Potem wraca do sprzedaży.`}
          </p>
        </section>

        <div className="intro card space-y-8 p-7 sm:p-10">
          <PurchasePanel reservation={reservation} expired={expired} onPurchased={handlePurchased} />
          <TripSummary event={reservation.event} seatId={reservation.seatId} passenger={reservation.customerName} />
          <p className="text-[15px] text-muted">Potwierdzenie wyślemy na {reservation.email}.</p>
        </div>
      </div>
    </div>
  );
}
