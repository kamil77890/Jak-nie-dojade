import type { ReactNode } from "react";
import { AlertTriangle, Refresh } from "./Icons";

export function LoadingBlock({ label = "Ładujemy…" }: { label?: string }) {
  return (
    <div className="loading-block" role="status" aria-live="polite">
      <span className="spinner" aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}

export function ErrorPanel({
  title = "Coś się zatrzymało",
  message,
  onRetry,
  action,
}: {
  title?: string;
  message: string;
  onRetry?: () => void;
  action?: ReactNode;
}) {
  return (
    <section className="feedback feedback--error" role="alert">
      <span className="feedback-icon" aria-hidden="true">
        <AlertTriangle size={22} />
      </span>
      <div className="feedback-copy">
        <h2>{title}</h2>
        <p>{message}</p>
        <div className="feedback-actions">
          {onRetry ? (
            <button type="button" className="button button--ghost" onClick={onRetry}>
              <Refresh size={16} />
              Spróbuj jeszcze raz
            </button>
          ) : null}
          {action}
        </div>
      </div>
    </section>
  );
}

export function EmptyPanel({
  title,
  message,
  action,
}: {
  title: string;
  message: string;
  action?: ReactNode;
}) {
  return (
    <section className="feedback feedback--empty">
      <div className="feedback-copy">
        <h2>{title}</h2>
        <p>{message}</p>
        {action ? <div className="feedback-actions">{action}</div> : null}
      </div>
    </section>
  );
}

export function InlineAlert({
  children,
  tone = "error",
}: {
  children: ReactNode;
  tone?: "error" | "warning" | "info";
}) {
  return (
    <p className={`inline-alert inline-alert--${tone}`} role="alert">
      <AlertTriangle size={17} />
      <span>{children}</span>
    </p>
  );
}
