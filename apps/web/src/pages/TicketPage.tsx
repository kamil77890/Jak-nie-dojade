import { formatDuration, formatEventDate, formatSeatLabel, getSeat, type Ticket } from "@pas/shared";
import { type ReactNode, useRef, useState } from "react";
import { Link, useLocation, useParams } from "react-router";
import { EmptyPanel } from "../components/Feedback";
import { CheckCircle, Mail, Printer, Shield } from "../components/Icons";
import { splitRelation, timeFromIso, trainLabel, weekdayPl } from "../lib/format";
import { EASE, gsap, scrambleText, useGsap } from "../lib/motion";
import { loadTicket } from "../lib/session";
import { useDocumentTitle } from "../hooks/useCountdown";
import { PurchaseSteps } from "../components/PurchaseSteps";

export function TicketPage() {
  const { reservationId = "" } = useParams();
  const location = useLocation();
  const root = useRef<HTMLDivElement>(null);
  const [ticket] = useState<Ticket | null>(() => {
    const state = location.state as { ticket?: Ticket } | null;
    return state?.ticket ?? loadTicket(reservationId);
  });

  useDocumentTitle(ticket ? `Bilet ${ticket.code}` : "Bilet");

  useGsap(
    root,
    () => {
      const timeline = gsap.timeline({ defaults: { ease: EASE } });
      timeline
        .from(".intro", { y: 30, opacity: 0, duration: 1.1, stagger: 0.08 })
        .from(".ticket-card", { y: 80, rotateX: 28, opacity: 0, duration: 1.6, transformOrigin: "50% 100%" }, "-=0.9")
        .add(() => {
          const code = root.current?.querySelector<HTMLElement>(".ticket-code");
          if (code && ticket) scrambleText(code, ticket.code);
        }, "-=0.8");
    },
    [],
  );

  if (!ticket) {
    return (
      <div className="mx-auto max-w-[760px] px-4 py-16 sm:px-8">
        <EmptyPanel
          title="Nie mamy biletu w tej karcie"
          message="Bilet zapisujemy w tej karcie przeglądarki po płatności. Sprawdź status płatności — jeśli jest opłacona, pokażemy kod."
          action={
            <Link className="btn btn-primary" to={`/reservations/${reservationId}/payment/success`} viewTransition>
              Sprawdź status płatności
            </Link>
          }
        />
      </div>
    );
  }

  const { event } = ticket;
  const { from, to } = splitRelation(event.relation);
  const position = getSeat(event.id, ticket.seatId)?.position;

  return (
    <div ref={root} className="mx-auto max-w-[860px] px-4 pb-24 pt-12 sm:px-8 [perspective:1400px]">
      <PurchaseSteps current={5} />
      <header>
        <p className="intro no-print inline-flex items-center gap-2 rounded-full bg-accent/15 px-3 py-1 text-[14px] font-semibold text-accent-ink">
          <CheckCircle size={16} />
          Zakup potwierdzony
        </p>
        <h1 className="intro mt-5 text-[clamp(48px,7vw,88px)] font-extrabold leading-[0.92] tracking-[-0.02em] condensed">
          Bilet wydany
        </h1>
        <p className="intro mt-4 max-w-[56ch] text-[17px] text-muted">
          Pokaż kod konduktorowi. Potwierdzenie wysyłamy na {ticket.email}, ale bilet jest ważny już
          teraz.
        </p>
      </header>

      <article
        className="ticket-card mt-10 overflow-hidden rounded-[28px] bg-white text-[#0b0d10] shadow-[0_40px_80px_-40px_rgb(0_0_0/0.45)] [--c-ink:#0b0d10] [--c-line:rgb(11_13_16/0.12)] [--c-muted:#5a616c] [--color-ink:#0b0d10] [--color-line:rgb(11_13_16/0.12)] [--color-muted:#5a616c] print:shadow-none print:ring-2 print:ring-black"
        aria-label={`Bilet ${ticket.code}`}
      >
        <header className="flex items-center justify-between bg-[#0b0d10] px-7 py-4 text-white">
          <span className="font-semibold">Bilet jednorazowy</span>
          <span className="rounded-md bg-accent px-2 py-0.5 text-[14px] font-bold text-black condensed">
            {trainLabel(event.id)}
          </span>
        </header>

        <h2 className="px-7 pt-7 text-[19px] font-bold leading-tight condensed">{event.relation}</h2>
        <div className="grid gap-6 px-7 pb-7 pt-5 sm:grid-cols-2">
          {[
            ["Odjazd", event.departureTime, from],
            ["Przyjazd", event.arrivalTime, to],
          ].map(([label, time, station]) => (
            <div key={label}>
              <p className="text-[14px] font-semibold text-muted">{label}</p>
              <p className="text-[clamp(56px,8vw,84px)] font-extrabold leading-[0.95] narrow">{time}</p>
              <p className="text-[19px] font-bold">{station}</p>
            </div>
          ))}
        </div>

        <dl className="grid grid-cols-2 gap-px border-y border-line bg-line sm:grid-cols-3">
          <Cell label="Miejsce" big className="col-span-2">
            {formatSeatLabel(ticket.seatId)}
          </Cell>
          <Cell label="Data">
            {weekdayPl(event.date)}, <span>{formatEventDate(event.date)}</span>
          </Cell>
          <Cell label="Podróżny">{ticket.customerName}</Cell>
          <Cell label="E-mail" className="max-sm:col-span-2 break-all">
            {ticket.email}
          </Cell>
          <Cell label="W podróży">{formatDuration(event.departureTime, event.arrivalTime)}</Cell>
          <Cell label="Wydano">{timeFromIso(ticket.issuedAt)}</Cell>
          <Cell label="Położenie">{position === "window" ? "przy oknie" : position === "aisle" ? "przy korytarzu" : "—"}</Cell>
          <Cell label="Pociąg">{trainLabel(event.id)}</Cell>
        </dl>

        <div className="ticket-perforation flex flex-wrap items-end justify-between gap-4 px-7 pb-8 pt-7">
          <span className="text-[14px] font-semibold text-muted">Kod biletu</span>
          <strong className="ticket-code text-[clamp(44px,7.4vw,76px)] font-extrabold leading-none tracking-[0.04em] narrow">
            {ticket.code}
          </strong>
        </div>
      </article>

      <div className="intro no-print mt-8 flex flex-wrap gap-3">
        <Link className="btn btn-primary" to="/" viewTransition>
          Wróć do odjazdów
        </Link>
        <button type="button" className="btn btn-ghost" onClick={() => window.print()}>
          <Printer size={17} />
          Drukuj / zapisz PDF
        </button>
      </div>

      <section className="intro no-print mt-10 flex gap-4 border-t border-line pt-8 text-[15px] text-muted">
        <Mail size={22} className="mt-0.5 shrink-0 text-ink" />
        <div>
          <h2 className="text-[19px] font-bold text-ink condensed">Potwierdzenie wyślemy kolejką</h2>
          <p className="mt-1 max-w-[60ch]">
            Bilet jest ważny już teraz. Wiadomość na <strong className="font-semibold text-ink">{ticket.email}</strong>{" "}
            czeka w kolejce i ma własne retry oraz limit prób. Awaria poczty nie cofa biletu.
          </p>
        </div>
      </section>

      <p className="mt-6 flex items-center gap-2 text-[14px] text-muted">
        <Shield size={15} className="shrink-0" />
        Opłacony kartą przez Stripe w trybie testowym — żadne prawdziwe pieniądze nie zostały pobrane.
      </p>
    </div>
  );
}

function Cell({
  label,
  children,
  big = false,
  className = "",
}: {
  label: string;
  children: ReactNode;
  big?: boolean;
  className?: string;
}) {
  return (
    <div className={`bg-white px-7 py-4 ${className}`}>
      <dt className="text-[14px] font-semibold text-muted">{label}</dt>
      <dd className={big ? "mt-1 text-[clamp(30px,4.4vw,44px)] font-extrabold leading-none narrow" : "mt-1 font-semibold"}>
        {children}
      </dd>
    </div>
  );
}
