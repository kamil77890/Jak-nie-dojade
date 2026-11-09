// @vitest-environment jsdom
import { installDom } from "./dom";
import { fireEvent, render, screen } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { PurchaseSteps } from "../src/components/PurchaseSteps";
import { ReadabilityMenu } from "../src/components/ReadabilityMenu";

installDom();

describe("nowy wygląd — pasek kroków zakupu", () => {
  it("oznacza bieżący krok i zrobione kroki", () => {
    const html = renderToStaticMarkup(<PurchaseSteps current={3} />);
    expect(html.match(/<li/g)).toHaveLength(5);
    expect(html).toMatch(/data-state="current" aria-current="step"><span[^>]*>3<\/span><span class="purchase-step-label">Dane/);
    expect(html.match(/data-state="done"/g)).toHaveLength(2);
    expect(html.match(/, zrobione/g)).toHaveLength(2);
  });
});

describe("nowy wygląd — rozmiar tekstu i kontrast", () => {
  afterEach(() => {
    localStorage.clear();
    delete document.documentElement.dataset.textSize;
    delete document.documentElement.dataset.contrast;
  });

  it("otwiera panel, zapisuje wybór i ustawia atrybuty na <html>", () => {
    render(<ReadabilityMenu overHero={false} />);
    const button = screen.getByRole("button", { name: /czytelność/i });
    expect(button.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(button);
    expect(button.getAttribute("aria-expanded")).toBe("true");

    fireEvent.click(screen.getByRole("radio", { name: "Tekst większy" }));
    fireEvent.click(screen.getByRole("radio", { name: "Wysoki" }));

    expect(document.documentElement.dataset.textSize).toBe("lg");
    expect(document.documentElement.dataset.contrast).toBe("high");
    expect(localStorage.getItem("pas.textSize")).toBe("lg");
    expect(localStorage.getItem("pas.contrast")).toBe("high");
    expect(button.textContent).toBe("A+");

    fireEvent.click(screen.getByRole("radio", { name: "Tekst zwykły" }));
    expect(document.documentElement.dataset.textSize).toBeUndefined();
  });

  it("zamyka panel klawiszem Escape i oddaje fokus przyciskowi", () => {
    render(<ReadabilityMenu overHero={false} />);
    const button = screen.getByRole("button", { name: /czytelność/i });
    fireEvent.click(button);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(button);
  });
});
