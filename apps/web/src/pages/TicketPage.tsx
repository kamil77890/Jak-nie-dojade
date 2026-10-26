import {
  formatDuration,
  formatEventDate,
  formatSeatLabel,
  type Ticket,
} from "@pas/shared";
import { useState } from "react";
import { Link, useLocation, useParams } from "react-router";
import { EmptyPanel } from "../components/Feedback";
import { CheckCircle, Mail, Printer, Shield, Ticket as TicketIcon } from "../components/Icons";
import { timeFromIso, trainLabel, weekdayPl } from "../lib/format";
import { loadTicket } from "../lib/session";
import { useDocumentTitle } from "../hooks/useCountdown";

export function TicketPage() {
  const { reservationId = "" } = useParams();
  const location = useLocation();
  const [ticket] = useState<Ticket | null>(() => {
    const state = location.state as { ticket?: Ticket } | null;
    return state?.ticket ?? loadTicket(reservationId);
  });

  useDocumentTitle("Twój bilet");

  if (!ticket) {
    return (
      <div className="page page--narrow">
        <EmptyPanel
          title="Nie mamy biletu w tej karcie"
          message="Bilet zapisujemy w sessionStorage po zakupie. Jeśli otworzyłeś link w nowej karcie, wróć do rezerwacji albo kup bilet jeszcze raz."
          action={
            <Link className="button button--primary" to="/">
              Wróć do rozkładu
            </Link>
          }
        />
      </div>
    );
  }

  return (
    <div className="page ticket-page">
      <section className="ticket-page-head">
        <p className="eyebrow">
          Karta C · bilet · {trainLabel(ticket.event.id)} · {weekdayPl(ticket.event.date)}
        </p>
        <h1>
          Bilet <em>gotowy.</em>
        </h1>
        <p>
          {formatSeatLabel(ticket.seatId)} — to miejsce jest Twoje. Pokaż kod przy wejściu na peron
          — potwierdzenie e-mail poleci osobno, w tle.
        </p>
      </section>

      <article className="ticket" aria-label={`Bilet ${ticket.code}`}>
        <div className="ticket-main">
          <div className="ticket-topline">
            <span className="stub-kicker">
              <TicketIcon size={17} />
              PAS · bilet
            </span>
            <span className="ticket-train">{trainLabel(ticket.event.id)}</span>
          </div>

          <h2 className="ticket-relation">{ticket.event.relation}</h2>
          <p className="ticket-date">{formatEventDate(ticket.event.date)}</p>

          <div className="ticket-route">
            <div>
              <span className="stub-label">Odjazd</span>
              <strong>{ticket.event.departureTime}</strong>
            </div>
            <span className="ticket-rail" aria-hidden="true">
              <span />
            </span>
            <div>
              <span className="stub-label">Przyjazd</span>
              <strong>{ticket.event.arrivalTime}</strong>
            </div>
            <span className="ticket-duration">
              {formatDuration(ticket.event.departureTime, ticket.event.arrivalTime)}
            </span>
          </div>

          <dl className="ticket-grid">
            <div>
              <dt>Miejsce</dt>
              <dd>{formatSeatLabel(ticket.seatId)}</dd>
            </div>
            <div>
              <dt>Podróżny</dt>
              <dd>{ticket.customerName}</dd>
            </div>
            <div>
              <dt>E-mail</dt>
              <dd>{ticket.email}</dd>
            </div>
            <div>
              <dt>Wydano</dt>
              <dd>{timeFromIso(ticket.issuedAt)}</dd>
            </div>
          </dl>

          <div className="ticket-code">
            <span className="stub-label">Kod biletu</span>
            <strong>{ticket.code}</strong>
            <small>Zachowaj ten kod. Jest dowodem rezerwacji miejsca.</small>
          </div>
        </div>

        <div className="ticket-stub" aria-hidden="true">
          <span className="ticket-stamp">wydany</span>
          <div className="barcode" />
          <span className="ticket-stub-code">{ticket.code}</span>
          <p>Wagon i miejsce</p>
          <strong>{formatSeatLabel(ticket.seatId)}</strong>
          <p>Trasa</p>
          <strong>{trainLabel(ticket.event.id)}</strong>
          <p className="ticket-stub-bottom">PAS / S01 / ETAP I</p>
        </div>
      </article>

      <div className="ticket-actions">
        <Link className="button button--primary" to="/">
          Wróć do rozkładu
        </Link>
        <button type="button" className="button button--ghost" onClick={() => window.print()}>
          <Printer size={17} />
          Drukuj / zapisz PDF
        </button>
      </div>

      <section className="delivery-note">
        <span className="delivery-icon" aria-hidden="true">
          <Mail size={22} />
        </span>
        <div>
          <p className="eyebrow">Praca w tle · E06</p>
          <h2>Potwierdzenie wyślemy kolejką</h2>
          <p>
            Bilet jest ważny już teraz. Wiadomość na <strong>{ticket.email}</strong> czeka w kolejce
            i ma własne retry oraz limit prób. Awaria poczty nie cofa biletu.
          </p>
        </div>
        <span className="delivery-status">
          <CheckCircle size={16} />
          bilet wydany
        </span>
      </section>

      <p className="ticket-footnote">
        <Shield size={15} />
        Płatność online dojdzie w Etapie II. Ten bilet jest bezpłatną rezerwacją miejsca w demo.
      </p>
    </div>
  );
}
