import {
  formatCountdown,
  formatEventDate,
  formatSeatLabel,
  type ReservationView,
  type Ticket,
} from "@pas/shared";
import { useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router";
import { EmptyPanel } from "../components/Feedback";
import { PurchasePanel } from "../components/PurchasePanel";
import { RouteStub } from "../components/RouteStub";
import { ArrowLeft, Clock, Shield } from "../components/Icons";
import { timeFromIso, trainLabel, weekdayPl } from "../lib/format";
import { loadReservation } from "../lib/session";
import { useCountdown, useDocumentTitle } from "../hooks/useCountdown";

export function ReservationPage() {
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
  const { remainingMs, expired } = useCountdown(reservation?.expiresAt ?? new Date(0).toISOString());

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

  const urgency = expired ? "is-expired" : remainingMs < 30_000 ? "is-danger" : remainingMs < 120_000 ? "is-warning" : "";
  const progress = Math.max(0, Math.min(100, (remainingMs / totalMs) * 100));

  function handlePurchased(ticket: Ticket) {
    navigate(`/reservations/${reservationId}/ticket`, { state: { ticket } });
  }

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
            ? "Rezerwacja wygasła, a miejsce wróciło do puli. Możesz wybrać inne — albo to samo, jeśli wciąż jest wolne."
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
            onPurchased={handlePurchased}
          />

          <section className="aside-card">
            <p className="eyebrow">Zasada serwera</p>
            <h2>Licznik to tylko podpowiedź</h2>
            <p>
              Przeglądarka pokazuje, ile zostało. O ważności decyduje API: zakup po czasie dostaje
              409 i nie wydaje biletu.
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
