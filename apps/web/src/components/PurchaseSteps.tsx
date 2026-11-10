import { Check } from "./Icons";

const STEPS = ["Kurs", "Miejsce", "Dane", "Płatność", "Bilet"] as const;

export type PurchaseStep = 2 | 3 | 4 | 5;

/**
 * Pasek kroków zakupu (wzór: bilkom, PKP Intercity). Tylko wskaźnik — kroki nie są klikalne,
 * a bieżący krok wynika z ekranu, na którym jest pasek.
 */
export function PurchaseSteps({ current }: { current: PurchaseStep }) {
  return (
    <ol className="purchase-steps no-print" aria-label="Kroki zakupu">
      {STEPS.map((label, index) => {
        const step = index + 1;
        const state = step < current ? "done" : step === current ? "current" : "todo";
        return (
          <li key={label} className="purchase-step" data-state={state} aria-current={state === "current" ? "step" : undefined}>
            <span className="purchase-step-dot" aria-hidden="true">
              {state === "done" ? <Check size={15} strokeWidth={2.6} /> : step}
            </span>
            <span className="purchase-step-label">
              {label}
              {state === "done" && <span className="sr-only">, zrobione</span>}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
