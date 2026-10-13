/** Writes the radar's observations into the existing evidence ledger (5A) with URL anchors. Nothing here is a hypothesis. */

import { EvidenceLedger } from "../../social/ledger.ts";
import type { Article, Match, SourceStatus, Story } from "./types.ts";

const iso = (ms: number) => new Date(ms).toISOString();

export class SocialEvidenceLedger {
  readonly ledger: EvidenceLedger;
  readonly errors: string[] = [];
  private readonly observedAt: string;
  constructor(observedAtMs: number, ledger: EvidenceLedger = new EvidenceLedger()) {
    this.ledger = ledger;
    this.observedAt = iso(observedAtMs);
  }
  private add(f: () => { id: string }): string | null {
    try {
      return f().id;
    } catch (e) {
      if (!/already in the ledger/.test(String(e))) this.errors.push(e instanceof Error ? e.message : String(e));
      return null;
    }
  }
  article(a: Article): string | null {
    if (!/^https:\/\//.test(a.url)) return null;
    const ev = a.publishedAt !== null && a.publishedAt <= Date.parse(this.observedAt) ? iso(a.publishedAt) : null;
    return this.add(() =>
      this.ledger.add({ mint: null, type: "claim_check", source: "news", status: "FACT", derivation: "observed", summary: `Article « ${a.title.slice(0, 120)} » (${a.publisher}) lu dans le flux ${a.feed}`, facts: [{ key: "publisher", value: a.publisher }, { key: "feed", value: a.feed }, { key: "title", value: a.title.slice(0, 200) }], observedAt: this.observedAt, eventTime: ev, url: a.url, limits: ["titre et date tels que publiés par le flux; l'exactitude de l'article n'est pas vérifiée"] }),
    );
  }
  match(story: Story, m: Match, articleIds: (string | null)[]): string | null {
    const basedOn = articleIds.filter((x): x is string => x !== null);
    const url = m.dexUrl && /^https:\/\//.test(m.dexUrl) ? m.dexUrl : null;
    const facts = [{ key: "level", value: m.level }, { key: "term", value: m.term }, { key: "tokenName", value: m.name }, { key: "tokenSymbol", value: m.symbol }, { key: "story", value: story.title.slice(0, 160) }];
    return this.add(() =>
      this.ledger.add({
        mint: m.mint,
        type: "claim_check",
        source: "dexscreener",
        status: m.evidence === "FAIT" ? "FACT" : "INDICATION",
        derivation: "observed",
        summary: `Association actualité ↔ token (${m.level}): ${m.because}`,
        facts,
        observedAt: this.observedAt,
        url,
        addresses: [m.mint],
        basedOn,
        limits: m.evidence === "FAIT" ? ["l'association montre une citation ou une déclaration, pas un lien d'intention entre l'actualité et le projet"] : ["correspondance de texte seulement: aucune affiliation établie; les homonymes sont fréquents"],
      }),
    );
  }
  gaps(statuses: SourceStatus[], extra: string[]): void {
    const missing = [...statuses.filter((s) => s.state === "unavailable" || s.state === "partial").map((s) => `${s.source}: ${s.reason ?? s.state}`), ...extra];
    missing.push("publications X: non collectées (API payante non utilisée, scraping exclu)");
    this.add(() => this.ledger.add({ mint: null, type: "data_gap", source: "news", status: "UNVERIFIED", summary: "Sources ou données non disponibles pour ce passage du radar", facts: [], observedAt: this.observedAt, missing, limits: ["toute mesure qui dépend de ces données est une borne, pas une valeur exacte"] }));
  }
}
