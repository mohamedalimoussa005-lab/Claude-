/**
 * Hard budget on outbound requests. `budgetedFetch` wraps the fetch the
 * history providers use: every request is classified, checked against the
 * allow-list and the call / credit caps BEFORE it is sent, and counted.
 * A refused request never reaches the network; the caller gets a synthetic
 * 402 / 403 and the budget remembers why.
 *
 * It records host and method only: never a URL, a header or a key.
 */

import { describeRequest, HELIUS_HOST, PUBLIC_RPC_HOST } from "./costModel.ts";
import type { RequestKind } from "./costModel.ts";

export interface BudgetLimits {
  maxCalls: number;
  /** Estimated Helius credits. */
  maxCredits: number;
}

export type ExhaustedBy = "calls" | "credits";

export interface BudgetReport {
  limits: BudgetLimits;
  calls: number;
  credits: number;
  byKind: Partial<Record<RequestKind, { calls: number; credits: number }>>;
  /** Requests refused because the budget was spent. */
  refusedByBudget: number;
  /** Requests refused because they are not on the allow-list. */
  refusedByPolicy: number;
  exhaustedBy: ExhaustedBy | null;
}

export class CallBudget {
  readonly limits: BudgetLimits;
  private calls = 0;
  private credits = 0;
  private refusedByBudget = 0;
  private refusedByPolicy = 0;
  private readonly byKind: BudgetReport["byKind"] = {};
  private exhausted: ExhaustedBy | null = null;

  constructor(limits: BudgetLimits) {
    if (!(limits.maxCalls > 0) || !(limits.maxCredits >= 0)) throw new Error("budget limits must be positive");
    this.limits = { ...limits };
  }

  get exhaustedBy(): ExhaustedBy | null {
    return this.exhausted;
  }

  get remainingCredits(): number {
    return this.limits.maxCredits - this.credits;
  }

  /** Whether `calls` more requests costing `credits` fit in what is left. */
  canAfford(calls: number, credits: number): boolean {
    return this.calls + calls <= this.limits.maxCalls && this.credits + credits <= this.limits.maxCredits;
  }

  /** Reserves one request. false = refused (budget). */
  tryCharge(kind: RequestKind, credits: number): boolean {
    if (this.calls + 1 > this.limits.maxCalls) {
      this.exhausted = "calls";
      this.refusedByBudget++;
      return false;
    }
    if (this.credits + credits > this.limits.maxCredits) {
      this.exhausted = "credits";
      this.refusedByBudget++;
      return false;
    }
    this.calls++;
    this.credits += credits;
    const k = (this.byKind[kind] ??= { calls: 0, credits: 0 });
    k.calls++;
    k.credits += credits;
    return true;
  }

  refusePolicy(): void {
    this.refusedByPolicy++;
  }

  report(): BudgetReport {
    return {
      limits: { ...this.limits },
      calls: this.calls,
      credits: this.credits,
      byKind: JSON.parse(JSON.stringify(this.byKind)),
      refusedByBudget: this.refusedByBudget,
      refusedByPolicy: this.refusedByPolicy,
      exhaustedBy: this.exhausted,
    };
  }
}

const refusal = (status: number, reason: string): Response => new Response(JSON.stringify({ error: reason }), { status, headers: { "content-type": "application/json" } });

/** Hosts the agent may talk to: Helius, the public Solana RPC, and one keyless custom endpoint when configured. */
export function allowedHostsFor(env: Record<string, string | undefined>): Set<string> {
  const hosts = new Set([HELIUS_HOST, PUBLIC_RPC_HOST]);
  const custom = env.SOLANA_RPC_URL?.trim();
  if (custom) {
    try {
      hosts.add(new URL(custom).host);
    } catch {
      // an unparsable custom endpoint is simply not allowed
    }
  }
  return hosts;
}

export function budgetedFetch(inner: typeof fetch, budget: CallBudget, allowedHosts: ReadonlySet<string>): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const info = describeRequest(url, init?.body, allowedHosts);
    if (!info) {
      budget.refusePolicy();
      return refusal(403, "request not allowed by the Smart Money allow-list");
    }
    if (!budget.tryCharge(info.kind, info.credits)) return refusal(402, "smart-money call budget exhausted");
    return inner(input, init);
  }) as typeof fetch;
}
