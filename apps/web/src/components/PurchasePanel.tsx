import type { ReservationView, Ticket } from "@pas/shared";
import { useState } from "react";
import { ApiRequestError, purchaseReservation } from "../lib/api";
import { describeApiError } from "../lib/errors";
import { saveTicket } from "../lib/session";
import { AlertTriangle, Mail, Ticket as TicketIcon } from "./Icons";

export function PurchasePanel({
  reservation,
  expired,
  onPurchased,
}: {
  reservation: ReservationView;
  expired: boolean;
  onPurchased: (ticket: Ticket) => void;
}) {
  const [loading, setLoading] = useState(false);
  const [forcedExpired, setForcedExpired] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isExpired = expired || forcedExpired;

  async function handlePurchase() {
    if (loading || isExpired) return;
    setLoading(true);
    setError(null);

    try {
      const { code } = await purchaseReservation(reservation.reservationId);
      const ticket: Ticket = {
        code,
        reservationId: reservation.reservationId,
        event: reservation.event,
        seatId: reservation.seatId,
        customerName: reservation.customerName,
        email: reservation.email,
        issuedAt: new Date().toISOString(),
      };
      saveTicket(ticket);
      onPurchased(ticket);
    } catch (caught) {
      if (caught instanceof ApiRequestError && caught.code === "RESERVATION_EXPIRED") {
        setForcedExpired(true);
      }
      setError(describeApiError(caught));
    } finally {
      setLoading(false);
    }
  }

  return (
    <section className={`purchase-panel ${isExpired ? "purchase-panel--expired" : ""}`}>
      <div className="purchase-panel-head">
        <p className="eyebrow">Karta C · zakup</p>
        <span className="purchase-panel-badge">bez płatności</span>
      </div>

      {isExpired ? (
        <div className="expiry-callout" role="alert">
          <AlertTriangle size={22} />
          <div>
            <h2>Rezerwacja wygasła</h2>
            <p>Miejsce wróciło do puli. Wybierz inne — albo to samo, jeśli wciąż jest wolne.</p>
          </div>
        </div>
      ) : (
        <>
          <h2 className="purchase-panel-title">Wszystko gotowe.</h2>
          <p className="purchase-panel-lead">
            Kliknij „Kupuję bilet”, a wydamy kod. Płatność online dojdzie w kolejnym etapie projektu —
            teraz liczy się miejsce i bilet.
          </p>
        </>
      )}

      <button
        type="button"
        className="button button--primary button--wide button--xl"
        onClick={() => void handlePurchase()}
        disabled={loading || isExpired}
        aria-busy={loading}
      >
        {loading ? (
          <>
            <span className="spinner spinner--dark" aria-hidden="true" />
            Wydajemy bilet…
          </>
        ) : (
          <>
            <TicketIcon size={20} />
            {isExpired ? "Rezerwacja wygasła" : "Kupuję bilet"}
          </>
        )}
      </button>

      {error && !isExpired ? (
        <p className="purchase-error" role="alert">
          {error}
        </p>
      ) : null}

      {isExpired ? (
        <p className="purchase-note">
          <AlertTriangle size={16} />
          Po czasie nie wydajemy biletu. Wróć do mapy i zarezerwuj miejsce ponownie.
        </p>
      ) : (
        <p className="purchase-note">
          <Mail size={16} />
          Potwierdzenie e-mail wyślemy w tle. Bilet jest ważny od razu — nawet jeśli poczta chwilę
          potrwa.
        </p>
      )}
    </section>
  );
}
