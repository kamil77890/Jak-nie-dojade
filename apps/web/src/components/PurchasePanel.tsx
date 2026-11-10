import { formatPrice, type ReservationView } from "@pas/shared";
import { useState } from "react";
import { Link } from "react-router";
import { ApiRequestError, startCheckout } from "../lib/api";
import { describeApiError, RESERVATION_EXPIRED_MESSAGE } from "../lib/errors";
import { checkoutKey } from "../lib/session";
import { ArrowRight, Mail, Shield } from "./Icons";

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

  if (isExpired) {
    return (
      <section>
        <div className="rounded-2xl border border-danger/30 bg-danger/8 p-6" role="alert">
          <h2 className="text-[24px] font-extrabold leading-tight text-danger condensed">
            {RESERVATION_EXPIRED_MESSAGE}
          </h2>
          <p className="mb-5 mt-2 text-muted">
            Po czasie nie przyjmujemy płatności. Wybierz miejsce jeszcze raz — inne albo to samo, jeśli
            wciąż jest wolne.
          </p>
          <Link className="btn btn-dark w-full" to={`/events/${reservation.event.id}`} viewTransition>
            Wróć do planu wagonu
          </Link>
        </div>
      </section>
    );
  }

  return (
    <section className="purchase-panel">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 className="text-[clamp(22px,2.2vw,28px)] font-bold leading-tight condensed">
          {cancelled ? "Płatność przerwana." : "Do zapłaty"}
        </h2>
        <p className="purchase-panel-price text-[clamp(36px,4vw,48px)] font-extrabold leading-none narrow">{price}</p>
      </div>
      <p className="mb-5 mt-2 text-[15px] text-muted">
        {cancelled
          ? "Nic nie pobraliśmy. Miejsce wciąż jest Twoje — możesz zapłacić jeszcze raz, dopóki licznik biegnie."
          : "Klikniesz „Zapłać”, przejdziesz na stronę płatności Stripe'a, a po zapłacie wrócisz po bilet z kodem."}
      </p>

      <button
        type="button"
        className="btn btn-primary group min-h-[64px] w-full text-[19px]"
        onClick={() => void handlePay()}
        disabled={loading}
        aria-busy={loading}
      >
        {loading ? (
          <>
            <span className="size-4 animate-spin rounded-full border-2 border-current border-r-transparent" aria-hidden="true" />
            Przechodzimy do płatności…
          </>
        ) : (
          <>
            {cancelled ? `Zapłać ponownie ${price}` : `Zapłać ${price}`}
            <ArrowRight size={20} className="transition-transform duration-300 group-hover:translate-x-1" />
          </>
        )}
      </button>

      {error ? (
        <p className="mt-3 font-semibold text-danger" role="alert">
          {error}
        </p>
      ) : null}

      <ul className="mt-4 space-y-2 text-[14px] text-muted">
        <li className="flex gap-2">
          <Shield size={16} className="mt-0.5 shrink-0" />
          <span>
            Tryb testowy Stripe: karta 4242 4242 4242 4242, dowolna przyszła data i CVC. Prawdziwe
            pieniądze nie są pobierane.
          </span>
        </li>
        <li className="flex gap-2">
          <Mail size={16} className="mt-0.5 shrink-0" />
          <span>Po płatności potwierdzenie e-mail wyślemy w tle. Bilet zobaczysz od razu.</span>
        </li>
      </ul>
    </section>
  );
}
