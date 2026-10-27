import {
  formatCountdown,
  formatEventDate,
  formatPrice,
  formatSeatLabel,
  type ReservationView,
} from "@pas/shared";
import { useEffect, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router";
import { EmptyPanel } from "../components/Feedback";
import { PurchasePanel } from "../components/PurchasePanel";
import { RouteStub } from "../components/RouteStub";
import { ArrowLeft, Clock, Shield } from "../components/Icons";
import { getReservationStatus } from "../lib/api";
import { RESERVATION_EXPIRED_MESSAGE } from "../lib/errors";
import { timeFromIso, trainLabel, weekdayPl } from "../lib/format";
import { loadReservation, loadTicket } from "../lib/session";
import { useCountdown, useDocumentTitle } from "../hooks/useCountdown";

/** Ekran rezerwacji z płatnością. `cancelled` — klient wrócił ze Stripe'a przez cancel_url. */
export function ReservationPage({ cancelled = false }: { cancelled?: boolean }) {
  const { reservationId = "" } = useParams();
  const location = useLocation();
  const navigate = useNavigate();

  const [reservation] = useState<ReservationView | null>(() => {
    const state = location.state as { reservation?: ReservationView } | null;
    return state?.reservation ?? loadReservation(reservationId);
  });
  const [totalMs] = useState(() =>
    reservation ? Math.max(1, new Date(reservation.expiresAt).getTime() - Date.now()) : 1,
  );

  useDocumentTitle("Twoja rezerwacja");
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

  if (!reservation) {
    return (
      <div className="page page--narrow">
        <EmptyPanel
          title="Ta karta nie pamięta rezerwacji"
          message="Adres zawiera identyfikator, ale dane rezerwacji trzymamy w sessionStorage tej karty. Wróć do rozkładu i wybierz miejsce jeszcze raz."
          action={
            <Link className="button button--primary" to="/">
              Wróć do rozkładu
            </Link>
          }
        />
      </div>
    );
  }

  if (ticket) {
    return (
      <div className="page page--narrow">
        <EmptyPanel
          title="Bilet jest już kupiony"
          message={`Ta rezerwacja zakończyła się zakupem. Kod biletu: ${ticket.code}.`}
          action={
            <Link className="button button--primary" to={`/reservations/${reservationId}/ticket`}>
              Pokaż bilet
            </Link>
          }
        />
      </div>
    );
  }

  const urgency = expired ? "is-expired" : remainingMs < 30_000 ? "is-danger" : remainingMs < 120_000 ? "is-warning" : "";
  const progress = Math.max(0, Math.min(100, (remainingMs / totalMs) * 100));


  return (
    <div className="page">
      <Link className="back-link" to={`/events/${reservation.event.id}`}>
        <ArrowLeft size={16} />
        Mapa wagonu
      </Link>

      <section className="reservation-hero">
        <p className="eyebrow">
          Karta B + C · rezerwacja · {trainLabel(reservation.event.id)} ·{" "}
          {weekdayPl(reservation.event.date)}
        </p>
        <h1>
          {expired ? (
            <>
              Czas <em>minął.</em>
            </>
          ) : (
            <>
              Miejsce jest <em>Twoje.</em>
            </>
          )}
        </h1>
        <p className="reservation-lead">
          {expired
            ? `${RESERVATION_EXPIRED_MESSAGE} Możesz wybrać inne — albo to samo, jeśli wciąż jest wolne.`
            : `${formatSeatLabel(reservation.seatId)} czeka na Ciebie na kursie ${reservation.event.relation}.`}
        </p>
        <p className="reservation-date">{formatEventDate(reservation.event.date)}</p>
      </section>

      <div className="reservation-layout">
        <div className="reservation-main">
          <section className={`hold-card ${urgency}`} aria-label="Licznik rezerwacji">
            <div className="hold-top">
              <span className="hold-label">
                <Clock size={15} />
                {expired ? "Rezerwacja wygasła" : "Miejsce trzymane jeszcze"}
              </span>
              <span className={`live-pill ${expired ? "live-pill--off" : ""}`}>
                <span aria-hidden="true" />
                {expired ? "po czasie" : "na żywo"}
              </span>
            </div>

            <div className="hold-timer" role="timer" aria-live="off">
              {formatCountdown(remainingMs)}
            </div>

            <div className="hold-bar" aria-hidden="true">
              <span style={{ width: `${progress}%` }} />
            </div>

            <div className="hold-foot">
              <span>Ważne do {timeFromIso(reservation.expiresAt)}</span>
              <span>{expired ? "miejsce wróciło do puli" : "termin pilnuje serwer"}</span>
            </div>
          </section>

          {expired ? (
            <p className="expiry-banner" role="alert">
              <Shield size={18} />
              Po czasie nie wydamy biletu. Wybierz miejsce jeszcze raz — to samo może być już wolne.
            </p>
          ) : null}

          <RouteStub
            event={reservation.event}
            seatId={reservation.seatId}
            passenger={reservation.customerName}
            label="Rezerwacja"
          />

          <section className="reservation-details">
            <p className="eyebrow">Szczegóły</p>
            <dl>
              <div>
                <dt>Podróżny</dt>
                <dd>{reservation.customerName}</dd>
              </div>
              <div>
                <dt>E-mail</dt>
                <dd>{reservation.email}</dd>
              </div>
              <div>
                <dt>Miejsce</dt>
                <dd>{formatSeatLabel(reservation.seatId)}</dd>
              </div>
              <div>
                <dt>Do zapłaty</dt>
                <dd>{formatPrice(reservation.amount)}</dd>
              </div>
              <div>
                <dt>Rezerwacja</dt>
                <dd className="mono">{reservation.reservationId.slice(0, 8)}…</dd>
              </div>
            </dl>
            <p className="details-note">
              Bilet jest ważny na całą trasę. Możesz zamknąć tę kartę i wrócić z historii — dane
              rezerwacji zostają w tej sesji przeglądarki.
            </p>
          </section>
        </div>

        <div className="reservation-aside">
          <PurchasePanel
            reservation={reservation}
            expired={expired}
            cancelled={cancelled}
            onPaid={() => navigate(paymentPath)}
            onExpired={() => setServerExpired(true)}
          />

          <section className="aside-card">
            <p className="eyebrow">Zasada serwera</p>
            <h2>Licznik to tylko podpowiedź</h2>
            <p>
              Przeglądarka pokazuje, ile zostało. O ważności decyduje API: po czasie nie otworzy
              płatności (409), a spóźnioną zapłatę zwróci zamiast wydać bilet.
            </p>
            <Link className="text-link" to="/lab">
              Podejrzyj kolejkę i bezpiecznik
              <span aria-hidden="true">↗</span>
            </Link>
          </section>
        </div>
      </div>
    </div>
  );
}
