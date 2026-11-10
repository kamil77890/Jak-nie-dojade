import { useCallback, useEffect, useState } from "react";

export type TextSize = "md" | "lg" | "xl";
export type Contrast = "normal" | "high";

const SIZE_KEY = "pas.textSize";
const CONTRAST_KEY = "pas.contrast";

function read(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    // Tryb prywatny może blokować localStorage — zostają ustawienia domyślne.
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Bez zapisu ustawienie i tak działa w tej karcie.
  }
}

/** Ten sam odczyt co skrypt w index.html, który ustawia atrybuty przed pierwszym malowaniem. */
export function readTextSize(): TextSize {
  const saved = read(SIZE_KEY);
  return saved === "lg" || saved === "xl" ? saved : "md";
}

export function readContrast(): Contrast {
  return read(CONTRAST_KEY) === "high" ? "high" : "normal";
}

/** Rozmiar tekstu i kontrast: atrybuty na <html>, wygląd robi CSS. */
export function useReadability() {
  const [textSize, setTextSizeState] = useState<TextSize>(() => readTextSize());
  const [contrast, setContrastState] = useState<Contrast>(() => readContrast());

  useEffect(() => {
    const root = document.documentElement;
    if (textSize === "md") delete root.dataset.textSize;
    else root.dataset.textSize = textSize;
  }, [textSize]);

  useEffect(() => {
    const root = document.documentElement;
    if (contrast === "high") root.dataset.contrast = "high";
    else delete root.dataset.contrast;
  }, [contrast]);

  const setTextSize = useCallback((next: TextSize) => {
    write(SIZE_KEY, next);
    setTextSizeState(next);
  }, []);

  const setContrast = useCallback((next: Contrast) => {
    write(CONTRAST_KEY, next);
    setContrastState(next);
  }, []);

  return { textSize, contrast, setTextSize, setContrast };
}
