import type { ReactNode } from "react";
import { AlertTriangle, Refresh } from "./Icons";

export function LoadingBlock({ label = "Ładujemy…" }: { label?: string }) {
  return (
    <div className="flex items-center gap-3 py-16 font-semibold text-muted" role="status" aria-live="polite">
      <span className="size-5 animate-spin rounded-full border-2 border-current border-r-transparent" aria-hidden="true" />
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
    <section className="card flex gap-5 p-7 sm:p-9" role="alert">
      <span className="grid size-12 shrink-0 place-items-center rounded-2xl bg-danger/12 text-danger" aria-hidden="true">
        <AlertTriangle size={22} />
      </span>
      <div>
        <h2 className="text-[clamp(26px,3vw,34px)] font-extrabold leading-tight condensed">{title}</h2>
        <p className="mt-2 max-w-[60ch] text-muted">{message}</p>
        <div className="mt-6 flex flex-wrap gap-3">
          {onRetry ? (
            <button type="button" className="btn btn-ghost" onClick={onRetry}>
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
    <section className="card p-7 sm:p-9">
      <h2 className="text-[clamp(26px,3vw,34px)] font-extrabold leading-tight condensed">{title}</h2>
      <p className="mt-2 max-w-[60ch] text-muted">{message}</p>
      {action ? <div className="mt-6 flex flex-wrap gap-3">{action}</div> : null}
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
  const color = tone === "error" ? "border-danger/40 text-danger" : "border-line text-ink";
  return (
    <p className={`my-4 flex items-start gap-3 rounded-2xl border bg-surface px-4 py-3 text-[15px] font-medium ${color}`} role="alert">
      <AlertTriangle size={17} className="mt-0.5 shrink-0" />
      <span>{children}</span>
    </p>
  );
}
