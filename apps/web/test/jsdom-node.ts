import { JSDOM } from "jsdom";
import { populateGlobal } from "vitest/environments";

/**
 * DOM dla testu, który w jednym procesie trzyma też API. W środowisku `jsdom`
 * Vite przepisuje `new URL(..., import.meta.url)` w apps/api na adres
 * przeglądarkowy, więc taki plik działa w środowisku `node`, a DOM stawiamy
 * tu — tak samo jak robi to Vitest. Importuj jako pierwszy moduł.
 */
const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost:3000/",
  pretendToBeVisual: true,
});
populateGlobal(globalThis, dom.window, { bindFunctions: true });
