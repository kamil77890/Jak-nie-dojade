import type { MailMessageView } from "@pas/shared";

export interface TicketMail {
  to: string;
  subject: string;
  text: string;
  reservationId: string;
}

export interface SendResult {
  id: string;
  duplicate: boolean;
}

export interface Mailer {
  send(message: TicketMail, idempotencyKey: string): Promise<SendResult>;
}

export class MailDeliveryError extends Error {
  constructor(
    message: string,
    public readonly retryable: boolean,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "MailDeliveryError";
  }
}

interface MockMailControl {
  mode: string;
  sent: number;
  lastModeChangeAt: string | null;
}

/**
 * Prawdziwy fetch do zewnętrznego dostawcy. Timeout jest częścią klienta,
 * a nie „gdzieś w infra” — dzięki temu request nie wisi bez końca.
 */
export class HttpMailer implements Mailer {
  constructor(
    private readonly url: string,
    private readonly timeoutMs: number,
  ) {}

  async send(message: TicketMail, idempotencyKey: string): Promise<SendResult> {
    let response: Response;
    try {
      response = await fetch(this.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": idempotencyKey,
          "x-pas-source": "api-worker",
        },
        body: JSON.stringify(message),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      const isTimeout =
        error instanceof Error &&
        (error.name === "TimeoutError" || error.name === "AbortError");
      throw new MailDeliveryError(
        isTimeout ? `Timeout po ${this.timeoutMs} ms` : `Błąd sieci: ${String(error)}`,
        true,
      );
    }

    if (!response.ok) {
      const retryable = response.status === 429 || response.status >= 500;
      throw new MailDeliveryError(
        `Dostawca e-mail odpowiedział ${response.status}`,
        retryable,
        response.status,
      );
    }

    try {
      const body = (await response.json()) as { id?: string; duplicate?: boolean };
      return { id: body.id ?? "unknown", duplicate: Boolean(body.duplicate) };
    } catch {
      return { id: "unknown", duplicate: false };
    }
  }
}

/** Klient panelu /lab — tylko odczyt i sterowanie mockiem. */
export class MailAdmin {
  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs = 500,
  ) {}

  async control(): Promise<MockMailControl | null> {
    return this.getJson<MockMailControl>("/control");
  }

  async messages(limit = 20): Promise<MailMessageView[] | null> {
    return this.getJson<MailMessageView[]>(`/messages?limit=${limit}`);
  }

  async setMode(mode: string): Promise<MockMailControl | null> {
    return this.postJson<MockMailControl>("/control", { mode });
  }

  async reset(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/reset`, {
        method: "POST",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  private async getJson<T>(path: string): Promise<T | null> {
    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!response.ok) return null;
      return (await response.json()) as T;
    } catch {
      return null;
    }
  }

  private async postJson<T>(path: string, body: unknown): Promise<T | null> {
    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!response.ok) return null;
      return (await response.json()) as T;
    } catch {
      return null;
    }
  }
}
