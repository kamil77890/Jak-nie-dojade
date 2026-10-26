import type { ReservationView, Ticket } from "@pas/shared";
import { useState } from "react";
import { Link } from "react-router";
import { ApiRequestError, purchaseReservation } from "../lib/api";
import { describeApiError } from "../lib/errors";
import { saveTicket } from "../lib/session";
import { ArrowRight } from "./Icons";

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

  if (isExpired) {
    return (
      <section className="rounded-2xl border border-danger/30 bg-danger/8 p-6" role="alert">
        <h2 className="text-[24px] font-extrabold leading-tight text-danger condensed">
          Rezerwacja wygasła, miejsce wróciło do puli
        </h2>
        <p className="mb-5 mt-2 text-muted">Po czasie nie wydajemy biletu. Wybierz miejsce jeszcze raz.</p>
        <Link className="btn btn-dark w-full" to={`/events/${reservation.event.id}`} viewTransition>
          Wróć do planu wagonu
        </Link>
      </section>
    );
  }

  return (
    <section>
      <button
        type="button"
        className="btn btn-primary group min-h-[64px] w-full text-[19px]"
        onClick={() => void handlePurchase()}
        disabled={loading}
        aria-busy={loading}
      >
        {loading ? (
          <>
            <span className="size-4 animate-spin rounded-full border-2 border-current border-r-transparent" aria-hidden="true" />
            Wydajemy bilet…
          </>
        ) : (
          <>
            Kupuję bilet
            <ArrowRight size={20} className="transition-transform duration-300 group-hover:translate-x-1" />
          </>
        )}
      </button>
      <p className="mt-3 text-[14px] text-muted">
        Bez płatności w tym etapie. Kod biletu zobaczysz od razu po kliknięciu.
      </p>

      {error ? (
        <p className="mt-3 font-semibold text-danger" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
