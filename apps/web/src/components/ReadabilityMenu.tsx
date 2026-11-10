import { useEffect, useId, useRef, useState } from "react";
import { useReadability, type Contrast, type TextSize } from "../lib/readability";

const SIZES: Array<[TextSize, string, string]> = [
  ["md", "A", "zwykły"],
  ["lg", "A+", "większy"],
  ["xl", "A++", "największy"],
];

const CONTRASTS: Array<[Contrast, string]> = [
  ["normal", "Zwykły"],
  ["high", "Wysoki"],
];

/** Przycisk „Aa” w nagłówku: rozmiar tekstu i kontrast (wzór: Portal Pasażera, PKP Intercity). */
export function ReadabilityMenu({ overHero }: { overHero: boolean }) {
  const { textSize, contrast, setTextSize, setContrast } = useReadability();
  const [open, setOpen] = useState(false);
  const wrapper = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const changed = textSize !== "md" || contrast === "high";
  const buttonLabel = textSize === "lg" ? "A+" : textSize === "xl" ? "A++" : "Aa";

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!wrapper.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        button.current?.focus();
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div ref={wrapper} className="relative">
      <button
        ref={button}
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        aria-controls={panelId}
        aria-label="Czytelność: rozmiar tekstu i kontrast"
        title="Czytelność"
        data-size={textSize}
        className={`readability-button ${changed ? "is-changed" : ""} ${overHero && !changed ? "text-white hover:bg-white/15" : ""}`}
      >
        {buttonLabel}
      </button>

      <div id={panelId} hidden={!open} className="readability-panel" role="group" aria-label="Czytelność">
        <fieldset>
          <legend>Rozmiar tekstu</legend>
          <div className="readability-options grid-cols-3">
            {SIZES.map(([value, label, description]) => (
              <label key={value} className="readability-option" data-size={value}>
                <input
                  type="radio"
                  name={`${panelId}-size`}
                  value={value}
                  checked={textSize === value}
                  onChange={() => setTextSize(value)}
                  className="sr-only"
                />
                <span aria-hidden="true">{label}</span>
                <span className="sr-only">{`Tekst ${description}`}</span>
              </label>
            ))}
          </div>
        </fieldset>
        <fieldset className="mt-4">
          <legend>Kontrast</legend>
          <div className="readability-options grid-cols-2">
            {CONTRASTS.map(([value, label]) => (
              <label key={value} className="readability-option">
                <input
                  type="radio"
                  name={`${panelId}-contrast`}
                  value={value}
                  checked={contrast === value}
                  onChange={() => setContrast(value)}
                  className="sr-only"
                />
                <span>{label}</span>
              </label>
            ))}
          </div>
        </fieldset>
      </div>
    </div>
  );
}
