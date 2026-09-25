import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DexScreenerClient, RATE_LIMITS } from "../api/dexscreener.ts";
import type { RequestLogEntry } from "../api/dexscreener.ts";
import { METRIC_FIELDS, SOURCE_PATH, fieldCoverage } from "../domain/normalize.ts";
import { mostLiquidPairPerToken, scanSolana } from "../domain/scanner.ts";
import type { ScanError, ScanResult } from "../domain/scanner.ts";
import { LABEL_DISCLAIMER, SCORING_CONFIG } from "../scoring/config.ts";
import { NO_FILTERS, applyFilters } from "../scoring/filters.ts";
import type { ScoreFilters } from "../scoring/filters.ts";
import { CATEGORY_LABEL, scorePairs } from "../scoring/score.ts";
import type { CategoryKey, Label, ScoredPair } from "../scoring/score.ts";
import { FiltersPanel } from "./FiltersPanel.tsx";
import { LabelBadge } from "./LabelBadge.tsx";
import { Bar, ScoreDetail, riskLevel } from "./ScoreDetail.tsx";
import { age, count, percent, shortAddress, usdCompact } from "./format.ts";

type SortDir = 1 | -1;
type SortValue = number | string | null;

interface Column {
  id: string;
  label: string;
  title?: string;
  sortValue: (r: ScoredPair) => SortValue;
  render: (r: ScoredPair) => React.ReactNode;
  numeric?: boolean;
  group?: "score" | "raw";
}

const categoryColumn = (key: CategoryKey, label: string): Column => ({
  id: `cat-${key}`,
  label,
  title: `${CATEGORY_LABEL[key]} : points / ${SCORING_CONFIG.opportunity[key].max}`,
  numeric: true,
  group: "score",
  sortValue: (r) => r.score.categories[key].points,
  render: (r) => {
    const c = r.score.categories[key];
    const anyMissing = c.items.some((i) => i.missing);
    return (
      <span className={anyMissing ? "cat-cell partial" : "cat-cell"} title={anyMissing ? "Au moins une donnée absente" : undefined}>
        {c.points.toFixed(1)}
        <span className="muted">/{c.max}</span>
        <Bar value={c.points} max={c.max} />
      </span>
    );
  },
});

const COLUMNS: Column[] = [
  {
    id: "token",
    label: "Token",
    sortValue: (r) => r.pair.tokenSymbol,
    render: ({ pair: p }) => (
      <div className="token">
        <strong>{p.tokenSymbol ?? "—"}</strong>
        <span className="muted">{p.tokenName ?? "—"}</span>
      </div>
    ),
  },
  {
    id: "label",
    label: "Étiquette",
    title: "Étiquette descriptive, jamais une recommandation d'achat",
    sortValue: (r) => r.score.label,
    render: (r) => <LabelBadge label={r.score.label} />,
  },
  {
    id: "opportunity",
    label: "Opportunity",
    title: "Opportunity Score /100",
    numeric: true,
    group: "score",
    sortValue: (r) => r.score.opportunity,
    render: (r) => <strong className="score">{r.score.opportunity}</strong>,
  },
  {
    id: "risk",
    label: "Risk",
    title: "Risk Score /100",
    numeric: true,
    group: "score",
    sortValue: (r) => r.score.risk,
    render: (r) => <strong className={`score risk-${riskLevel(r.score.risk)}`}>{r.score.risk}</strong>,
  },
  categoryColumn("momentum", "Momentum"),
  categoryColumn("volume", "Volume"),
  categoryColumn("buyPressure", "Buy Pr."),
  categoryColumn("liquidity", "Liquidity"),
  categoryColumn("marketCap", "Mkt Cap"),
  categoryColumn("age", "Age"),
  {
    id: "bs5m",
    label: "B/S 5m",
    title: "Achats / ventes sur 5 min (txns.m5)",
    numeric: true,
    sortValue: (r) => ratio(r.pair.buysM5, r.pair.sellsM5),
    render: ({ pair: p }) => <BuySell buys={p.buysM5} sells={p.sellsM5} />,
  },
  {
    id: "bs1h",
    label: "B/S 1h",
    title: "Achats / ventes sur 1 h (txns.h1)",
    numeric: true,
    sortValue: (r) => ratio(r.pair.buysH1, r.pair.sellsH1),
    render: ({ pair: p }) => <BuySell buys={p.buysH1} sells={p.sellsH1} />,
  },
  { id: "mcap", label: "MCap", numeric: true, group: "raw", sortValue: (r) => r.pair.marketCap, render: (r) => usdCompact(r.pair.marketCap) },
  { id: "liq", label: "Liq.", numeric: true, group: "raw", sortValue: (r) => r.pair.liquidityUsd, render: (r) => usdCompact(r.pair.liquidityUsd) },
  { id: "vol5m", label: "Vol 5m", numeric: true, group: "raw", sortValue: (r) => r.pair.volumeM5, render: (r) => usdCompact(r.pair.volumeM5) },
  { id: "vol1h", label: "Vol 1h", numeric: true, group: "raw", sortValue: (r) => r.pair.volumeH1, render: (r) => usdCompact(r.pair.volumeH1) },
  { id: "ch5m", label: "Δ 5m", numeric: true, group: "raw", sortValue: (r) => r.pair.priceChangeM5, render: (r) => <Change value={r.pair.priceChangeM5} /> },
  { id: "ch1h", label: "Δ 1h", numeric: true, group: "raw", sortValue: (r) => r.pair.priceChangeH1, render: (r) => <Change value={r.pair.priceChangeH1} /> },
  { id: "ch6h", label: "Δ 6h", numeric: true, group: "raw", sortValue: (r) => r.pair.priceChangeH6, render: (r) => <Change value={r.pair.priceChangeH6} /> },
  {
    id: "created",
    label: "Âge",
    numeric: true,
    group: "raw",
    sortValue: (r) => r.score.ageMinutes,
    render: ({ pair: p }) => (
      <span title={p.pairCreatedAt ? new Date(p.pairCreatedAt).toISOString() : "pairCreatedAt absent"}>{age(p.pairCreatedAt)}</span>
    ),
  },
  { id: "dex", label: "DEX", sortValue: (r) => r.pair.dexId, render: (r) => r.pair.dexId ?? "—" },
  {
    id: "pair",
    label: "Pair",
    sortValue: (r) => r.pair.pairAddress,
    render: ({ pair: p }) =>
      p.url ? (
        <a href={p.url} target="_blank" rel="noreferrer" title={p.pairAddress} onClick={(e) => e.stopPropagation()}>
          {shortAddress(p.pairAddress)}
          {p.quoteSymbol ? ` /${p.quoteSymbol}` : ""}
        </a>
      ) : (
        <code title={p.pairAddress}>{shortAddress(p.pairAddress)}</code>
      ),
  },
];

function ratio(buys: number | null, sells: number | null): number | null {
  if (buys === null || sells === null || buys + sells === 0) return null;
  return buys / (buys + sells);
}

function BuySell({ buys, sells }: { buys: number | null; sells: number | null }) {
  if (buys === null || sells === null) return <span className="muted">—</span>;
  const r = ratio(buys, sells);
  return (
    <span className="bs" title={r === null ? "aucune transaction" : `${(r * 100).toFixed(0)} % achats`}>
      <span className="up">{count(buys)}</span>/<span className="down">{count(sells)}</span>
    </span>
  );
}

function Change({ value }: { value: number | null }) {
  const cls = value === null ? "" : value > 0 ? "up" : value < 0 ? "down" : "";
  return <span className={cls}>{percent(value)}</span>;
}

function compare(a: ScoredPair, b: ScoredPair, col: Column, dir: SortDir): number {
  const va = col.sortValue(a);
  const vb = col.sortValue(b);
  // Missing values always sink to the bottom, whatever the direction.
  if (va === null && vb === null) return 0;
  if (va === null) return 1;
  if (vb === null) return -1;
  if (typeof va === "number" && typeof vb === "number") return (va - vb) * dir;
  return String(va).localeCompare(String(vb)) * dir;
}

export function App() {
  const [result, setResult] = useState<ScanResult | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [log, setLog] = useState<RequestLogEntry[]>([]);
  const [onePerToken, setOnePerToken] = useState(true);
  const [filter, setFilter] = useState("");
  const [sort, setSort] = useState<{ id: string; dir: SortDir }>({ id: "opportunity", dir: -1 });
  const [filters, setFilters] = useState<ScoreFilters>(NO_FILTERS);
  const [selected, setSelected] = useState<string | null>(null);

  const client = useMemo(
    () =>
      new DexScreenerClient({
        baseUrl: import.meta.env.VITE_DEXSCREENER_BASE_URL ?? "/dex",
        onRequest: (entry) => setLog((prev) => [entry, ...prev].slice(0, 100)),
      }),
    [],
  );

  const refresh = useCallback(async () => {
    setLoading(true);
    setFatal(null);
    try {
      setResult(await scanSolana(client));
    } catch (err) {
      setFatal(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [client]);

  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void refresh();
  }, [refresh]);

  const scored = useMemo(() => {
    if (!result) return [];
    const base = onePerToken ? mostLiquidPairPerToken(result.pairs) : result.pairs;
    return scorePairs(base, result.fetchedAt);
  }, [result, onePerToken]);

  const rows = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const textFiltered = q
      ? scored.filter(({ pair: p }) =>
          [p.tokenName, p.tokenSymbol, p.tokenAddress, p.pairAddress, p.dexId].some((v) => v?.toLowerCase().includes(q)),
        )
      : scored;
    const col = COLUMNS.find((c) => c.id === sort.id) ?? COLUMNS[2];
    return [...applyFilters(textFiltered, filters)].sort((a, b) => compare(a, b, col, sort.dir));
  }, [scored, filter, filters, sort]);

  const labelCounts = useMemo(() => {
    const out = { WATCH: 0, MOMENTUM: 0, "HIGH RISK": 0 } as Record<Label, number>;
    for (const r of rows) if (r.score.label) out[r.score.label]++;
    return out;
  }, [rows]);

  const selectedRow = selected ? scored.find((r) => r.pair.pairAddress === selected) ?? null : null;

  const coverage = useMemo(() => (result ? fieldCoverage(result.pairs) : null), [result]);

  const onSort = (id: string) => setSort((s) => (s.id === id ? { id, dir: s.dir === 1 ? -1 : 1 } : { id, dir: -1 }));

  const allFailed = result !== null && result.pairs.length === 0 && result.errors.length > 0;

  return (
    <main>
      <header>
        <div>
          <h1>Solana Scanner</h1>
          <p className="muted">
            Données réelles DEX Screener · lecture seule · aucun trading, aucun wallet · scores descriptifs, pas de prédiction
          </p>
        </div>
        <button onClick={() => void refresh()} disabled={loading}>
          {loading ? "Chargement…" : "Refresh"}
        </button>
      </header>

      {fatal && <ErrorBanner title="Échec du scan" errors={[]} message={fatal} />}
      {result && result.errors.length > 0 && (
        <ErrorBanner
          title={allFailed ? "Erreur API DEX Screener : aucune donnée récupérée" : "Erreurs API partielles"}
          errors={result.errors}
          severe={allFailed}
        />
      )}

      {result && (
        <section className="summary">
          <span>
            Mis à jour <strong>{new Date(result.fetchedAt).toLocaleTimeString()}</strong> ({result.durationMs} ms)
          </span>
          <span>
            Découverte : profiles {result.stats.discoveredBySource.profiles} · boosts latest{" "}
            {result.stats.discoveredBySource["boosts-latest"]} · boosts top {result.stats.discoveredBySource["boosts-top"]}{" "}
            → <strong>{result.stats.uniqueSolanaTokens}</strong> tokens Solana uniques
          </span>
          <span>
            <strong>{result.stats.keptPairs}</strong> paires ({result.stats.rawPairs} brutes,{" "}
            {result.stats.skippedQuoteSide} côté quote, {result.stats.skippedOtherChain} autre chaîne,{" "}
            {result.stats.skippedInvalid} invalides) · {result.stats.tokensWithoutPairs} tokens sans paire
          </span>
        </section>
      )}

      <section className="controls">
        <input
          type="search"
          placeholder="Filtrer (nom, symbole, adresse, DEX)"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <label>
          <input type="checkbox" checked={onePerToken} onChange={(e) => setOnePerToken(e.target.checked)} />
          1 paire par token (la plus liquide)
        </label>
        <span className="muted">
          {rows.length} / {scored.length} lignes
        </span>
        <span className="label-counts">
          <LabelBadge label="MOMENTUM" /> {labelCounts.MOMENTUM} <LabelBadge label="WATCH" /> {labelCounts.WATCH}{" "}
          <LabelBadge label="HIGH RISK" /> {labelCounts["HIGH RISK"]}
        </span>
      </section>

      <FiltersPanel value={filters} onChange={setFilters} />

      <p className="disclaimer">
        {LABEL_DISCLAIMER} Cliquez sur une ligne pour voir le détail du score.
      </p>

      <div className="table-wrap">
        <table className="scores">
          <thead>
            <tr>
              {COLUMNS.map((c) => (
                <th
                  key={c.id}
                  className={[c.numeric ? "num" : "", c.group ? `g-${c.group}` : ""].join(" ").trim() || undefined}
                  onClick={() => onSort(c.id)}
                  title={c.title}
                >
                  {c.label}
                  {sort.id === c.id ? (sort.dir === -1 ? " ▼" : " ▲") : ""}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr
                key={r.pair.pairAddress}
                className={selected === r.pair.pairAddress ? "clickable selected" : "clickable"}
                onClick={() => setSelected(r.pair.pairAddress)}
              >
                {COLUMNS.map((c) => (
                  <td key={c.id} className={c.numeric ? "num" : undefined}>
                    {c.render(r)}
                  </td>
                ))}
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={COLUMNS.length} className="empty">
                  {loading ? "Chargement des données DEX Screener…" : "Aucune paire ne correspond aux filtres."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {selectedRow && result && (
        <ScoreDetail row={selectedRow} fetchedAt={result.fetchedAt} onClose={() => setSelected(null)} />
      )}

      {result && coverage && (
        <details>
          <summary>Couverture des champs ({result.pairs.length} paires)</summary>
          <table className="small">
            <thead>
              <tr>
                <th>Champ</th>
                <th>Chemin API</th>
                <th className="num">Présent</th>
              </tr>
            </thead>
            <tbody>
              {METRIC_FIELDS.map((f) => (
                <tr key={f}>
                  <td>{f}</td>
                  <td>
                    <code>{SOURCE_PATH[f]}</code>
                  </td>
                  <td className="num">
                    {coverage[f]} / {result.pairs.length}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}

      <details>
        <summary>Journal des requêtes ({log.length})</summary>
        <p className="muted">
          Rate limits appliqués : {RATE_LIMITS.slow.appliedPerMinute}/min (documenté{" "}
          {RATE_LIMITS.slow.documentedPerMinute}) pour profiles/boosts, {RATE_LIMITS.fast.appliedPerMinute}/min
          (documenté {RATE_LIMITS.fast.documentedPerMinute}) pour tokens/pairs/search.
        </p>
        <table className="small">
          <thead>
            <tr>
              <th>Endpoint</th>
              <th>Essai</th>
              <th>HTTP</th>
              <th className="num">ms</th>
              <th>Résultat</th>
            </tr>
          </thead>
          <tbody>
            {log.map((e, i) => (
              <tr key={i} className={e.outcome === "error" ? "row-error" : undefined}>
                <td>
                  <code>{e.endpoint.length > 80 ? `${e.endpoint.slice(0, 80)}…` : e.endpoint}</code>
                </td>
                <td>{e.attempt}</td>
                <td>{e.status ?? "—"}</td>
                <td className="num">{e.durationMs}</td>
                <td>
                  {e.outcome}
                  {e.note ? ` — ${e.note}` : ""}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </main>
  );
}

function ErrorBanner({
  title,
  errors,
  message,
  severe = true,
}: {
  title: string;
  errors: ScanError[];
  message?: string;
  severe?: boolean;
}) {
  return (
    <div className={severe ? "banner error" : "banner warn"} role="alert">
      <strong>{title}</strong>
      {message && <p>{message}</p>}
      {errors.length > 0 && (
        <ul>
          {errors.map((e, i) => (
            <li key={i}>
              <code>
                [{e.stage} · {e.source} · {e.kind}
                {e.status !== null ? ` · HTTP ${e.status}` : ""}]
              </code>{" "}
              {e.message}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
