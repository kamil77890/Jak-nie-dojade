import type { OpsStatus } from "@pas/shared";
import type { FastifyRequest } from "fastify";
import { Bulkhead } from "./resilience";

const leases = new WeakMap<FastifyRequest, Array<() => void>>();

/** Jedno miejsce na zwolnienie puli/limitu, niezależne od tego, jak kończy się request. */
export function addLease(request: FastifyRequest, release: () => void): void {
  const current = leases.get(request);
  if (current) {
    current.push(release);
  } else {
    leases.set(request, [release]);
  }
}

export function releaseLeases(request: FastifyRequest): void {
  const current = leases.get(request);
  if (!current) return;
  leases.delete(request);
  for (const release of current) {
    try {
      release();
    } catch {
      // Zwolnienie nie może wywrócić odpowiedzi.
    }
  }
}

export class GuardState {
  inFlight = 0;
  loadShedRejected = 0;
  rateLimited = 0;

  constructor(
    readonly maxInFlight: number,
    readonly readPool: Bulkhead,
    readonly writePool: Bulkhead,
  ) {}

  snapshot(): OpsStatus["guards"] {
    return {
      inFlight: this.inFlight,
      maxInFlight: this.maxInFlight,
      loadShedRejected: this.loadShedRejected,
      rateLimited: this.rateLimited,
      readPool: this.readPool.snapshot(),
      writePool: this.writePool.snapshot(),
    };
  }
}
