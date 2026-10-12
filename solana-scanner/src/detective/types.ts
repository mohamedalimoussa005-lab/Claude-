/**
 * DETECTIVE — shared types of the single report.
 *
 * Vocabulary (the same everywhere):
 *   FAIT          read directly from a source, with its anchor (signature, slot, account) or exact arithmetic on such reads
 *   INDICE        derived by a stated rule, or reported by a third party (DEX Screener): suggestive, not proof
 *   HYPOTHÈSE     DISABLED in this product: the report never states one
 *   INCONNU       could not be established with the budget / data available (never turned into "nothing found")
 *   NON SIMULÉ    a pool or venue the liquidity engine does not support, with the reason
 */

export const LEVELS = ["FAIT", "INDICE", "INCONNU", "NON SIMULÉ"] as const;
export type Level = (typeof LEVELS)[number];

export interface Finding {
  level: Level;
  text: string;
  /** Anchors that back the statement: signatures, account addresses, URLs. */
  anchors?: string[];
}

export type SectionStatus = "ok" | "partial" | "unknown" | "unsupported";

export interface ReportSection<T = unknown> {
  title: string;
  status: SectionStatus;
  /** Machine-readable content of the section (JSON output). */
  data: T | null;
  findings: Finding[];
  /** What could not be established, and why. */
  unknowns: string[];
  /** Budget / coverage limits that bound this section. */
  limits: string[];
}

export type ModeName = "rapide" | "standard" | "profond";

export interface BudgetReport {
  mode: ModeName;
  maxCalls: number;
  maxMs: number;
  /** Calls made through the budgeted client (cache hits included: an upper bound of network use). */
  calls: number;
  byMethod: Record<string, number>;
  /** Actual HTTP attempts when the client reports them (retries included). */
  httpAttempts: number | null;
  retries: number | null;
  elapsedMs: number;
  /** Every limit that was hit: call budget, time budget, page cap, transaction cap, wallet cap… */
  limitsReached: string[];
}

export interface DetectiveReport {
  schema: "detective-report/1";
  mint: string;
  generatedAt: string;
  mode: ModeName;
  budget: BudgetReport;
  sections: {
    identity: ReportSection;
    creator: ReportSection;
    firstBuyers: ReportSection;
    funding: ReportSection;
    liquidity: ReportSection;
    exitSimulations: ReportSection;
    repetitive: ReportSection;
    social: ReportSection;
    evidence: ReportSection;
    synthesis: ReportSection;
  };
  /** Coordination hypotheses are never produced: always false in this product. */
  hypothesesEnabled: false;
  disclaimers: string[];
}

export const DISCLAIMERS: readonly string[] = [
  "Ce rapport décrit des données observées et des mesures; il ne prédit ni le prix ni une fraude et ne constitue pas un conseil.",
  "Les simulations de vente sont des calculs sur l'état du pool à un instant donné, pas une garantie d'exécution.",
  "Aucune hypothèse de coordination n'est produite; un groupe de wallets décrit une ressemblance de comportement ou de financement, jamais un propriétaire commun.",
  "Les scores expérimentaux (brouillons) ne sont ni additionnés ni comparés aux scores Opportunity, Risk, Quality, Confidence existants.",
  "INCONNU signifie que la donnée n'a pas pu être établie avec le budget et les sources disponibles, pas qu'il n'y a rien.",
];

export const section = <T>(title: string, over: Partial<ReportSection<T>> = {}): ReportSection<T> => ({ title, status: "unknown", data: null, findings: [], unknowns: [], limits: [], ...over });
