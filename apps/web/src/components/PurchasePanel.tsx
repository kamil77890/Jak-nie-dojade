import { formatPrice, type ReservationView } from "@pas/shared";
import { useState } from "react";
import { ApiRequestError, startCheckout } from "../lib/api";
import { describeApiError, RESERVATION_EXPIRED_MESSAGE } from "../lib/errors";
import { checkoutKey } from "../lib/session";
import { AlertTriangle, Mail, Shield, Ticket as TicketIcon } from "./Icons";

/** Przejście na stronę Stripe'a. Osobno, żeby testy mogły je podmienić. */
export const redirectTo = {
  assign: (url: string) => window.location.assign(url),
};

export function PurchasePanel({
  reservation,
  expired,
  cancelled = false,
  onPaid,
  onExpired,
}: {
  reservation: ReservationView;
  expired: boolean;
  /** Klient wrócił ze Stripe'a przez „Wstecz” / anulowanie. */
  cancelled?: boolean;
  /** Serwer mówi, że rezerwacja jest już opłacona — bilet czeka. */
  onPaid: () => void;
  /** Serwer odrzucił płatność jako wygasłą, choć licznik w przeglądarce jeszcze trwa. */
  onExpired?: () => void;
}) {
  const [loading, setLoading] = useState(false);
  const [forcedExpired, setForcedExpired] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isExpired = expired || forcedExpired;
  const price = formatPrice(reservation.amount);

  async function handlePay() {
    if (loading || isExpired) return;
    setLoading(true);
    setError(null);

    try {
      const { url } = await startCheckout(reservation.reservationId, checkoutKey(reservation.reservationId));
      redirectTo.assign(url);
      // Przycisk zostaje w stanie „Przechodzimy…”, dopóki przeglądarka nie zmieni strony.
    } catch (caught) {
      setLoading(false);
      if (caught instanceof ApiRequestError && caught.code === "RESERVATION_PAID") {
        onPaid();
        return;
      }
      if (caught instanceof ApiRequestError && caught.code === "RESERVATION_EXPIRED") {
        setForcedExpired(true);
        onExpired?.();
      }
      setError(describeApiError(caught));
    }
  }

  return (
    <section className={`purchase-panel ${isExpired ? "purchase-panel--expired" : ""}`}>
      <div className="purchase-panel-head">
        <p className="eyebrow">Karta A · płatność</p>
        <span className="purchase-panel-badge">Stripe · test</span>
      </div>

      {isExpired ? (
        <div className="expiry-callout" role="alert">
          <AlertTriangle size={22} />
          <div>
            <h2>{RESERVATION_EXPIRED_MESSAGE}</h2>
            <p>Wybierz inne miejsce — albo to samo, jeśli wciąż jest wolne.</p>
          </div>
        </div>
      ) : (
        <>
          <h2 className="purchase-panel-title">
            {cancelled ? "Płatność przerwana." : "Do zapłaty"} <span className="purchase-panel-price">{price}</span>
          </h2>
          <p className="purchase-panel-lead">
            {cancelled
              ? "Nic nie pobraliśmy. Miejsce wciąż jest Twoje — możesz zapłacić jeszcze raz, dopóki licznik biegnie."
              : "Klikniesz „Zapłać”, przejdziesz na stronę płatności Stripe'a, a po zapłacie wrócisz po bilet z kodem."}
          </p>
        </>
      )}

      <button
        type="button"
        className="button button--primary button--wide button--xl"
        onClick={() => void handlePay()}
        disabled={loading || isExpired}
        aria-busy={loading}
      >
        {loading ? (
          <>
            <span className="spinner spinner--dark" aria-hidden="true" />
            Przechodzimy do płatności…
          </>
        ) : (
          <>
            <TicketIcon size={20} />
            {isExpired ? "Rezerwacja wygasła" : cancelled ? `Zapłać ponownie ${price}` : `Zapłać ${price}`}
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
          Po czasie nie przyjmujemy płatności. Wróć do mapy i zarezerwuj miejsce ponownie.
        </p>
      ) : (
        <>
          <p className="purchase-note">
            <Shield size={16} />
            Tryb testowy: karta 4242 4242 4242 4242, dowolna przyszła data i CVC. Prawdziwe pieniądze
            nie są pobierane.
          </p>
          <p className="purchase-note">
            <Mail size={16} />
            Po płatności potwierdzenie e-mail wyślemy w tle. Bilet zobaczysz od razu.
          </p>
        </>
      )}
    </section>
  );
}
