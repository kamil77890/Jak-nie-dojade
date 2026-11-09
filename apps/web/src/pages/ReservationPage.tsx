import { formatCountdown, formatSeatLabel, type ReservationView } from "@pas/shared";
import { useEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router";
import { EmptyPanel } from "../components/Feedback";
import { ArrowLeft, ArrowRight } from "../components/Icons";
import { PurchasePanel } from "../components/PurchasePanel";
import { TripSummary } from "../components/TripSummary";
import { getReservationStatus } from "../lib/api";
import { RESERVATION_EXPIRED_MESSAGE } from "../lib/errors";
import { timeFromIso } from "../lib/format";
import { EASE, gsap, useGsap } from "../lib/motion";
import { loadReservation, loadTicket } from "../lib/session";
import { useCountdown, useDocumentTitle } from "../hooks/useCountdown";
import { PurchaseSteps } from "../components/PurchaseSteps";

const RING_RADIUS = 46;
const RING_LENGTH = 2 * Math.PI * RING_RADIUS;

/** Ekran rezerwacji z płatnością. `cancelled` — klient wrócił ze Stripe'a przez cancel_url. */
export function ReservationPage({ cancelled = false }: { cancelled?: boolean }) {
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

  // Bilet z tej rezerwacji już jest — np. po „Wstecz” z ekranu biletu.
  const [ticket] = useState(() => loadTicket(reservationId));
  // 409 z serwera ma pierwszeństwo przed licznikiem w przeglądarce.
  const [serverExpired, setServerExpired] = useState(false);

  const paymentPath = `/reservations/${reservationId}/payment/success`;

  // Serwer jest źródłem prawdy: po „Wstecz” ze Stripe'a rezerwacja może być już
  // opłacona (wtedy bilet) albo wygasła (wtedy bez ponownej płatności).
  useEffect(() => {
    if (!reservation || ticket) return;
    let alive = true;
    getReservationStatus(reservationId)
      .then((current) => {
        if (!alive) return;
        if (current.status === "paid") navigate(paymentPath, { replace: true });
        if (current.status === "expired") setServerExpired(true);
      })
      .catch(() => {
        // Bez statusu zostaje licznik; płatność i tak sprawdzi serwer.
      });
    return () => {
      alive = false;
    };
  }, [reservationId, reservation, ticket, navigate, paymentPath]);

  const countdown = useCountdown(reservation?.expiresAt ?? new Date(0).toISOString());
  const expired = countdown.expired || serverExpired;
  const remainingMs = serverExpired ? 0 : countdown.remainingMs;
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
          title="Ta karta nie pamięta rezerwacji"
          message="Adres zawiera identyfikator, ale dane rezerwacji trzymamy tylko w karcie, w której ją zrobiono. Wróć do odjazdów i wybierz miejsce jeszcze raz."
          action={
            <Link className="btn btn-primary" to="/" viewTransition>
              Wróć do odjazdów
            </Link>
          }
        />
      </div>
    );
  }

  if (ticket) {
    return (
      <div className="mx-auto max-w-[760px] px-4 py-16 sm:px-8">
        <EmptyPanel
          title="Bilet jest już kupiony"
          message={`Ta rezerwacja zakończyła się zakupem. Kod biletu: ${ticket.code}.`}
          action={
            <Link className="btn btn-primary" to={`/reservations/${reservationId}/ticket`} viewTransition>
              Pokaż bilet
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

  return (
    <div ref={root} className="mx-auto max-w-[1320px] px-4 pb-24 pt-10 sm:px-8">
      <PurchaseSteps current={4} />
      <Link
        className="inline-flex items-center gap-2 text-[15px] font-semibold text-muted transition-colors hover:text-ink"
        to={`/events/${reservation.event.id}`}
        viewTransition
      >
        <ArrowLeft size={16} />
        Plan wagonu
      </Link>

      <div className="mt-6 grid items-start gap-4 sm:mt-8 sm:gap-6 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)] lg:gap-8">
        <section className="card flex flex-col items-center px-6 py-6 text-center sm:px-10 sm:py-14" aria-labelledby="hold-title">
          <h1 id="hold-title" className={`intro text-[clamp(24px,2.6vw,32px)] font-bold leading-tight condensed ${expired ? "text-danger" : ""}`}>
            {expired ? "Rezerwacja wygasła" : `${seatLabel} czeka na Ciebie`}
          </h1>

          {/* Telefon: mniejszy pierścień, żeby „Zapłać” było na pierwszym ekranie, pod licznikiem (jak na main). */}
          <div className="hold-ring relative mt-4 aspect-square w-full max-w-[200px] sm:mt-8 sm:max-w-[400px]">
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
                  className={`text-[52px] sm:text-[clamp(84px,11vw,140px)] font-extrabold leading-none tracking-[-0.02em] narrow ${
                    expired ? "text-muted/50" : urgent ? "text-danger" : ""
                  }`}
                  role="timer"
                  aria-live="off"
                  aria-label="Pozostały czas"
                >
                  {formatCountdown(remainingMs)}
                </div>
                <p className="mt-1 text-[14px] text-muted sm:mt-2 sm:text-[15px]">{expired ? "po czasie" : "zostało"}</p>
              </div>
            </div>
          </div>

          <p className="intro mt-4 max-w-[40ch] text-[15px] text-muted sm:mt-8 sm:text-[16px]">
            {expired
              ? `${RESERVATION_EXPIRED_MESSAGE} Możesz wybrać inne — albo to samo, jeśli wciąż jest wolne.`
              : `Trzymamy miejsce do ${timeFromIso(reservation.expiresAt)}. Potem wraca do sprzedaży.`}
          </p>
        </section>

        <div className="intro card space-y-8 p-6 sm:p-10">
          <PurchasePanel
            reservation={reservation}
            expired={expired}
            cancelled={cancelled}
            onPaid={() => navigate(paymentPath)}
            onExpired={() => setServerExpired(true)}
          />
          <div>
            <TripSummary
              event={reservation.event}
              seatId={reservation.seatId}
              passenger={reservation.customerName}
              price={["Do zapłaty", reservation.amount]}
            />
            <dl className="grid grid-cols-[120px_minmax(0,1fr)] gap-4 border-t border-line py-3 text-[16px]">
              <dt className="text-muted">Rezerwacja</dt>
              <dd className="font-medium mono">{reservation.reservationId.slice(0, 8)}…</dd>
            </dl>
          </div>
          <p className="text-[15px] text-muted">Potwierdzenie wyślemy na {reservation.email}.</p>
          <div className="border-t border-line pt-6 text-[15px] text-muted">
            <p>
              <strong className="font-semibold text-ink">Licznik to tylko podpowiedź.</strong> Przeglądarka
              pokazuje, ile zostało. O ważności decyduje API: po czasie nie otworzy płatności (409), a
              spóźnioną zapłatę zwróci zamiast wydać bilet.
            </p>
            <Link className="mt-2 inline-flex items-center gap-1 font-semibold text-ink underline underline-offset-4" to="/lab" viewTransition>
              Podejrzyj kolejkę i bezpiecznik
              <ArrowRight size={14} />
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
