import type { JobView, MailMessageView, OpsSnapshot, OpsStatus } from "@pas/shared";
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router";
import { ErrorPanel, InlineAlert, LoadingBlock } from "../components/Feedback";
import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  CheckCircle,
  Mail,
  Queue,
  Refresh,
  Shield,
  Clock,
} from "../components/Icons";
import {
  ApiRequestError,
  getOpsSnapshot,
  purchaseReservation,
  resetMailbox,
  retryJob,
  setMailMode,
} from "../lib/api";
import { describeApiError } from "../lib/errors";
import { timeFromIso } from "../lib/format";
import { useDocumentTitle } from "../hooks/useCountdown";

const MAIL_MODES = [
  { id: "healthy", label: "Zdrowy" },
  { id: "slow", label: "Wolny 3 s" },
  { id: "down", label: "Awaria" },
  { id: "flaky", label: "Szarpanie" },
] as const;

const JOB_STATE_LABEL: Record<JobView["state"], string> = {
  ready: "gotowy",
  retry: "ponowna próba",
  done: "zrobiony",
  dlq: "DLQ",
};

const BREAKER_LABEL: Record<OpsStatus["breaker"]["state"], string> = {
  closed: "zamknięty",
  open: "otwarty",
  half_open: "półotwarty",
};

interface ProbeResult {
  notFound: number;
  limited: number;
  overloaded: number;
  other: number;
}

export function LabPage() {
  useDocumentTitle("Laboratorium niezawodności");

  const [snapshot, setSnapshot] = useState<OpsSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [probe, setProbe] = useState<ProbeResult | null>(null);

  const load = useCallback(async (initial = false) => {
    if (initial) setLoading(true);
    try {
      const next = await getOpsSnapshot();
      setSnapshot(next);
      setError(null);
      setPollError(null);
      setLastUpdated(Date.now());
    } catch (caught) {
      const message = describeApiError(caught);
      if (initial) setError(message);
      else setPollError(message);
    } finally {
      if (initial) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(true);
  }, [load]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void load(false);
    }, 4_000);

    const onVisibility = () => {
      if (document.visibilityState === "visible") void load(false);
    };
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [load]);

  async function runAction(key: string, action: () => Promise<unknown>) {
    if (busy) return;
    setBusy(key);
    setActionError(null);
    try {
      await action();
      await load(false);
    } catch (caught) {
      setActionError(describeApiError(caught));
    } finally {
      setBusy(null);
    }
  }

  async function runRateProbe() {
    if (busy) return;
    setBusy("probe");
    setActionError(null);
    setProbe(null);

    const statuses = await Promise.all(
      Array.from({ length: 30 }, async () => {
        try {
          await purchaseReservation("00000000-0000-0000-0000-000000000000");
          return 200;
        } catch (caught) {
          return caught instanceof ApiRequestError ? caught.status : 0;
        }
      }),
    );

    const count = (status: number) => statuses.filter((value) => value === status).length;
    setProbe({
      notFound: count(404),
      limited: count(429),
      overloaded: count(503),
      other: statuses.length - count(404) - count(429) - count(503),
    });

    await load(false);
    setBusy(null);
  }

  if (loading && !snapshot) {
    return (
      <div className="page">
        <LoadingBlock label="Zbieramy próbkę z bezpieczników, kolejki i pul…" />
      </div>
    );
  }

  if (error && !snapshot) {
    return (
      <div className="page page--narrow">
        <ErrorPanel
          title="Laboratorium nie odpowiada"
          message={`${error} Panel działa, gdy API ma OPS_ENABLED=true.`}
          onRetry={() => void load(true)}
          action={
            <Link className="button button--ghost" to="/">
              Wróć do rozkładu
            </Link>
          }
        />
      </div>
    );
  }

  if (!snapshot) return null;

  const { status, jobs, mail } = snapshot;
  const breakerTone =
    status.breaker.state === "closed"
      ? "ok"
      : status.breaker.state === "half_open"
        ? "warn"
        : "danger";

  return (
    <div className="page lab-page">
      <Link className="back-link" to="/">
        <ArrowLeft size={16} />
        Rozkład jazdy
      </Link>

      <section className="lab-hero">
        <p className="eyebrow">
          <span className="eyebrow-rule" aria-hidden="true" />
          E04 · E05 · E06
        </p>
        <h1>
          Laboratorium <em>niezawodności.</em>
        </h1>
        <p>
          Tu widać, co się dzieje, gdy dostawca poczty pada, ruch rośnie, a praca musi poczekać.
          Kasa nadal wydaje bilety — tylko część rzeczy dzieje się w tle.
        </p>
        <div className="lab-chips" aria-label="Zakres praktyk">
          <span>timeout · retry · breaker</span>
          <span>limit · load shedding · bulkhead</span>
          <span>kolejka · ack · DLQ</span>
        </div>
      </section>

      <div className="lab-toolbar">
        <p className="refresh-stamp">
          {lastUpdated
            ? `Ostatnia próbka: ${new Date(lastUpdated).toLocaleTimeString("pl-PL")}`
            : "Czekamy na pierwszą próbkę"}
        </p>
        <div className="lab-toolbar-actions">
          <button
            type="button"
            className="button button--ghost button--small"
            onClick={() => void runAction("refresh", async () => undefined)}
            disabled={busy !== null}
          >
            <Refresh size={15} className={busy === "refresh" ? "spin" : ""} />
            Odśwież
          </button>
        </div>
      </div>

      {pollError ? (
        <InlineAlert tone="warning">
          Nie udało się odświeżyć próbki: {pollError} Pokazujemy ostatni znany stan.
        </InlineAlert>
      ) : null}
      {actionError ? <InlineAlert>{actionError}</InlineAlert> : null}

      <div className="lab-grid">
        <section className="lab-card">
          <header className="lab-card-head">
            <span className="lab-index">E04</span>
            <div>
              <p className="eyebrow">Zależność</p>
              <h2>Dostawca e-mail</h2>
            </div>
            <span className={`state-badge state-badge--${breakerTone}`}>
              <span aria-hidden="true" />
              {BREAKER_LABEL[status.breaker.state]}
            </span>
          </header>

          <div className="lab-metrics">
            <div>
              <span>Timeout</span>
              <strong>{status.config.mailTimeoutMs} ms</strong>
            </div>
            <div>
              <span>Retry</span>
              <strong>{status.config.mailRetryAttempts} próby</strong>
            </div>
            <div>
              <span>Błędy z rzędu</span>
              <strong>{status.breaker.failures}</strong>
            </div>
            <div>
              <span>Wysłane</span>
              <strong>{status.mail.sent}</strong>
            </div>
          </div>

          <div className="mode-switch" role="group" aria-label="Tryb dostawcy e-mail">
            {MAIL_MODES.map((mode) => (
              <button
                key={mode.id}
                type="button"
                className={`mode-button ${status.mail.mode === mode.id ? "is-active" : ""}`}
                onClick={() =>
                  void runAction(`mode:${mode.id}`, () => setMailMode(mode.id))
                }
                disabled={Boolean(busy) || !status.mail.available}
                aria-pressed={status.mail.mode === mode.id}
              >
                {busy === `mode:${mode.id}` ? <span className="spinner" aria-hidden="true" /> : null}
                {mode.label}
              </button>
            ))}
          </div>

          <p className="lab-hint">
            {status.mail.available
              ? "Mock dostawcy odpowiada. Zmieniaj tryb i kup bilet, żeby zobaczyć timeout, retry i otwarcie bezpiecznika."
              : "Mock e-mail nie odpowiada. Uruchom `pnpm dev:mail`, żeby sterować zależnością."}
          </p>

          {!status.mail.available ? <InlineAlert tone="warning">Brak połączenia z mockiem poczty.</InlineAlert> : null}
          {status.breaker.lastError ? (
            <p className="lab-last-error">
              <AlertTriangle size={15} />
              {status.breaker.lastError}
            </p>
          ) : null}
        </section>

        <section className="lab-card">
          <header className="lab-card-head">
            <span className="lab-index">E05</span>
            <div>
              <p className="eyebrow">Przeciążenie</p>
              <h2>Ochrona kasy</h2>
            </div>
            <span className="state-badge state-badge--neutral">
              <Activity size={14} />
              {status.guards.inFlight} / {status.guards.maxInFlight}
            </span>
          </header>

          <div className="lab-metrics">
            <div>
              <span>Load shedding 503</span>
              <strong>{status.guards.loadShedRejected}</strong>
            </div>
            <div>
              <span>Rate limit 429</span>
              <strong>{status.guards.rateLimited}</strong>
            </div>
            <div>
              <span>Pula odczytów</span>
              <strong>
                {status.guards.readPool.active}/{status.guards.readPool.concurrency}
              </strong>
              <small>{status.guards.readPool.queued} w kolejce</small>
            </div>
            <div>
              <span>Pula zapisów</span>
              <strong>
                {status.guards.writePool.active}/{status.guards.writePool.concurrency}
              </strong>
              <small>{status.guards.writePool.queued} w kolejce</small>
            </div>
          </div>

          <div className="pool-bars" aria-hidden="true">
            <PoolBar
              label="odczyt"
              active={status.guards.readPool.active}
              queued={status.guards.readPool.queued}
              capacity={status.guards.readPool.concurrency}
            />
            <PoolBar
              label="zapis"
              active={status.guards.writePool.active}
              queued={status.guards.writePool.queued}
              capacity={status.guards.writePool.concurrency}
            />
          </div>

          <button
            type="button"
            className="button button--ghost button--small"
            onClick={() => void runRateProbe()}
            disabled={Boolean(busy)}
          >
            {busy === "probe" ? <span className="spinner" aria-hidden="true" /> : <Activity size={15} />}
            Test limitu: 30 prób zakupu
          </button>

          {probe ? (
            <p className="probe-result" role="status">
              <span>404 — {probe.notFound}</span>
              <span className="probe-limited">429 — {probe.limited}</span>
              <span>503 — {probe.overloaded}</span>
              <span>inne — {probe.other}</span>
            </p>
          ) : (
            <p className="lab-hint">
              Test wysyła 30 zakupów nieistniejącej rezerwacji. Nie tworzy danych, ale pokazuje, jak
              limit zamienia nadmiar w 429.
            </p>
          )}
        </section>

        <section className="lab-card">
          <header className="lab-card-head">
            <span className="lab-index">E06</span>
            <div>
              <p className="eyebrow">Praca w tle</p>
              <h2>Kolejka e-maili</h2>
            </div>
            <span className="state-badge state-badge--neutral">
              <Queue size={14} />
              {status.queue.total} {status.queue.total === 1 ? "job" : "joby"}
            </span>
          </header>

          <div className="queue-counts">
            <div>
              <span>gotowe</span>
              <strong>{status.queue.ready}</strong>
            </div>
            <div>
              <span>retry</span>
              <strong>{status.queue.retry}</strong>
            </div>
            <div>
              <span>zrobione</span>
              <strong>{status.queue.done}</strong>
            </div>
            <div className={status.queue.dlq > 0 ? "queue-dlq" : ""}>
              <span>DLQ</span>
              <strong>{status.queue.dlq}</strong>
            </div>
          </div>

          <div className="worker-row">
            <span className={`worker-dot ${status.worker.enabled ? "is-on" : ""}`} aria-hidden="true" />
            <span>
              worker {status.worker.enabled ? "działa" : "wyłączony"} · przetworzone{" "}
              {status.worker.processed} · błędy {status.worker.failed}
            </span>
          </div>

          <p className="lab-hint">
            Zakup i dodanie joba to jedna transakcja. Worker potwierdza dopiero po wysyłce, a
            dostawca dostaje ten sam Idempotency-Key przy każdej próbie.
          </p>
          {status.worker.lastRunAt ? (
            <p className="lab-last-error">
              <CheckCircle size={15} />
              Ostatnia praca: {timeFromIso(status.worker.lastRunAt)}
            </p>
          ) : null}
        </section>
      </div>

      <section className="lab-section" aria-labelledby="jobs-title">
        <div className="section-head section-head--compact">
          <div>
            <p className="eyebrow">Kolejka · claim → praca → ack</p>
            <h2 id="jobs-title">Ostatnie joby</h2>
          </div>
          <p className="section-meta">
            {status.queue.dlq > 0 ? `${status.queue.dlq} w dead letter queue` : "bez DLQ"}
          </p>
        </div>

        {jobs.length === 0 ? (
          <p className="lab-empty">
            Kolejka jest pusta. Kup bilet, żeby zobaczyć job „e-mail z biletem”.
          </p>
        ) : (
          <div className="jobs-table-wrap">
            <table className="jobs-table">
              <thead>
                <tr>
                  <th>Zadanie</th>
                  <th>Rezerwacja</th>
                  <th>Próby</th>
                  <th>Stan</th>
                  <th>Ostatni błąd</th>
                  <th>
                    <span className="sr-only">Akcje</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {jobs.map((job) => (
                  <tr key={job.id}>
                    <td>
                      <span className="job-task">{jobLabel(job.task)}</span>
                      <small className="job-id">{job.id.slice(0, 8)}</small>
                    </td>
                    <td className="mono">{jobReservationId(job)}</td>
                    <td>{job.totalTried}</td>
                    <td>
                      <span className={`job-state job-state--${job.state}`}>
                        {JOB_STATE_LABEL[job.state]}
                      </span>
                    </td>
                    <td className="job-error" title={job.lastError ?? undefined}>
                      {job.lastError ?? "—"}
                    </td>
                    <td>
                      {job.state === "dlq" ? (
                        <button
                          type="button"
                          className="button button--tiny"
                          onClick={() => void runAction(`job:${job.id}`, () => retryJob(job.id))}
                          disabled={Boolean(busy)}
                        >
                          {busy === `job:${job.id}` ? "…" : "Ponów"}
                        </button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="lab-section" aria-labelledby="mail-title">
        <div className="section-head section-head--compact">
          <div>
            <p className="eyebrow">Mock dostawcy · idempotency</p>
            <h2 id="mail-title">Skrzynka</h2>
          </div>
          <button
            type="button"
            className="button button--ghost button--small"
            onClick={() => void runAction("reset", resetMailbox)}
            disabled={Boolean(busy) || !mail.available}
          >
            {busy === "reset" ? <span className="spinner" aria-hidden="true" /> : <Mail size={15} />}
            Wyczyść skrzynkę
          </button>
        </div>

        {!mail.available ? (
          <p className="lab-empty">
            Mock poczty nie działa. Uruchom <code>pnpm dev:mail</code> i odśwież próbkę.
          </p>
        ) : mail.messages.length === 0 ? (
          <p className="lab-empty">
            Skrzynka jest pusta. Kup bilet — worker wyśle potwierdzenie, a Ty zobaczysz je tutaj.
          </p>
        ) : (
          <div className="mail-list">
            {mail.messages.map((message) => (
              <MailItem key={message.id} message={message} />
            ))}
          </div>
        )}
      </section>

      <section className="lab-scenarios" aria-labelledby="scenarios-title">
        <div className="section-head section-head--compact">
          <div>
            <p className="eyebrow">Trzy scenariusze demo</p>
            <h2 id="scenarios-title">Co warto kliknąć</h2>
          </div>
        </div>
        <div className="scenario-grid">
          <article className="scenario-card">
            <span className="scenario-number">01</span>
            <Shield size={20} />
            <h3>Dostawca pada</h3>
            <p>
              Ustaw „Awaria”, kup bilet i wróć tutaj. Zobaczysz retry, otwarty bezpiecznik i DLQ po
              pięciu próbach. Bilet zostanie wydany mimo wszystko.
            </p>
          </article>
          <article className="scenario-card">
            <span className="scenario-number">02</span>
            <AlertTriangle size={20} />
            <h3>Ruch rośnie</h3>
            <p>
              Kliknij test 30 zakupów. Część requestów dostanie 429 zamiast obciążać bazę. Przy
              większym tłoku load shedding odpowiada szybkim 503.
            </p>
          </article>
          <article className="scenario-card">
            <span className="scenario-number">03</span>
            <Clock size={20} />
            <h3>Poczta zwalnia</h3>
            <p>
              Ustaw „Wolny 3 s”. Timeout klienta to 1,2 s, więc zależność nie trzyma requestu.
              Worker ponowi wysyłkę, a bilet będzie już na ekranie.
            </p>
          </article>
        </div>
      </section>

      <details className="code-map">
        <summary>Gdzie to jest w kodzie</summary>
        <ul>
          <li>
            <code>apps/api/src/resilience.ts</code> — timeout/retry/breaker, token bucket i bulkhead
          </li>
          <li>
            <code>apps/api/src/app.ts</code> — load shedding, limity per route i pule odczytu/zapisu
          </li>
          <li>
            <code>apps/api/src/jobs.ts</code> — claim, ack, backoff i dead letter queue
          </li>
          <li>
            <code>apps/api/src/worker.ts</code> — worker e-maili i ten sam Idempotency-Key
          </li>
          <li>
            <code>apps/api/src/mail.ts</code> — klient zależności z AbortSignal.timeout
          </li>
        </ul>
      </details>
    </div>
  );
}

function PoolBar({
  label,
  active,
  queued,
  capacity,
}: {
  label: string;
  active: number;
  queued: number;
  capacity: number;
}) {
  const activeWidth = Math.min(100, (active / Math.max(1, capacity)) * 100);
  const queueWidth = Math.min(100 - activeWidth, (queued / Math.max(1, capacity)) * 100);
  return (
    <div className="pool-bar">
      <span className="pool-bar-label">{label}</span>
      <span className="pool-bar-track">
        <span className="pool-bar-active" style={{ width: `${activeWidth}%` }} />
        <span className="pool-bar-queue" style={{ width: `${queueWidth}%` }} />
      </span>
    </div>
  );
}

function MailItem({ message }: { message: MailMessageView }) {
  return (
    <details className="mail-item">
      <summary>
        <span className="mail-dot" aria-hidden="true">
          <Mail size={15} />
        </span>
        <span className="mail-summary">
          <strong>{message.subject}</strong>
          <small>
            {message.to} · {timeFromIso(message.sentAt)} · klucz {message.idempotencyKey.slice(0, 8)}
          </small>
        </span>
      </summary>
      <pre>{message.text}</pre>
    </details>
  );
}

function jobLabel(task: string): string {
  if (task === "send-ticket-email") return "e-mail z biletem";
  return task;
}

function jobReservationId(job: JobView): string {
  const input = job.input;
  if (input && typeof input === "object" && "reservationId" in input) {
    const value = input.reservationId;
    if (typeof value === "string") return `${value.slice(0, 8)}…`;
  }
  return "—";
}
