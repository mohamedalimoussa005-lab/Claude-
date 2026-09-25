import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DexScreenerClient, RATE_LIMITS } from "../api/dexscreener.ts";
import type { RequestLogEntry } from "../api/dexscreener.ts";
import { METRIC_FIELDS, SOURCE_PATH, fieldCoverage } from "../domain/normalize.ts";
import type { NormalizedPair } from "../domain/normalize.ts";
import { mostLiquidPairPerToken, scanSolana } from "../domain/scanner.ts";
import type { ScanError, ScanResult } from "../domain/scanner.ts";
import { age, count, percent, shortAddress, usdCompact, usdPrice } from "./format.ts";

type SortKey = keyof NormalizedPair;

interface Column {
  key: SortKey;
  label: string;
  render: (p: NormalizedPair) => React.ReactNode;
  numeric?: boolean;
}

const COLUMNS: Column[] = [
  {
    key: "tokenSymbol",
    label: "Token",
    render: (p) => (
      <div className="token">
        <strong>{p.tokenSymbol ?? "—"}</strong>
        <span className="muted">{p.tokenName ?? "—"}</span>
      </div>
    ),
  },
  {
    key: "tokenAddress",
    label: "Token address",
    render: (p) => <Address value={p.tokenAddress} />,
  },
  {
    key: "pairAddress",
    label: "Pair",
    render: (p) =>
      p.url ? (
        <a href={p.url} target="_blank" rel="noreferrer" title={p.pairAddress}>
          {shortAddress(p.pairAddress)}
          {p.quoteSymbol ? ` /${p.quoteSymbol}` : ""}
        </a>
      ) : (
        <Address value={p.pairAddress} />
      ),
  },
  { key: "dexId", label: "DEX", render: (p) => p.dexId ?? "—" },
  { key: "priceUsd", label: "Price", numeric: true, render: (p) => usdPrice(p.priceUsd) },
  { key: "marketCap", label: "MCap", numeric: true, render: (p) => usdCompact(p.marketCap) },
  { key: "fdv", label: "FDV", numeric: true, render: (p) => usdCompact(p.fdv) },
  { key: "liquidityUsd", label: "Liquidity", numeric: true, render: (p) => usdCompact(p.liquidityUsd) },
  { key: "volumeM5", label: "Vol 5m", numeric: true, render: (p) => usdCompact(p.volumeM5) },
  { key: "volumeH1", label: "Vol 1h", numeric: true, render: (p) => usdCompact(p.volumeH1) },
  { key: "volumeH6", label: "Vol 6h", numeric: true, render: (p) => usdCompact(p.volumeH6) },
  { key: "volumeH24", label: "Vol 24h", numeric: true, render: (p) => usdCompact(p.volumeH24) },
  { key: "buysM5", label: "Buys 5m", numeric: true, render: (p) => count(p.buysM5) },
  { key: "sellsM5", label: "Sells 5m", numeric: true, render: (p) => count(p.sellsM5) },
  { key: "buysH1", label: "Buys 1h", numeric: true, render: (p) => count(p.buysH1) },
  { key: "sellsH1", label: "Sells 1h", numeric: true, render: (p) => count(p.sellsH1) },
  { key: "priceChangeM5", label: "Δ 5m", numeric: true, render: (p) => <Change value={p.priceChangeM5} /> },
  { key: "priceChangeH1", label: "Δ 1h", numeric: true, render: (p) => <Change value={p.priceChangeH1} /> },
  { key: "priceChangeH6", label: "Δ 6h", numeric: true, render: (p) => <Change value={p.priceChangeH6} /> },
  {
    key: "pairCreatedAt",
    label: "Age",
    numeric: true,
    render: (p) => (
      <span title={p.pairCreatedAt ? new Date(p.pairCreatedAt).toISOString() : "pairCreatedAt absent"}>
        {age(p.pairCreatedAt)}
      </span>
    ),
  },
];

function Address({ value }: { value: string }) {
  return (
    <code title={value} className="addr" onClick={() => void navigator.clipboard?.writeText(value)}>
      {shortAddress(value)}
    </code>
  );
}

function Change({ value }: { value: number | null }) {
  const cls = value === null ? "" : value > 0 ? "up" : value < 0 ? "down" : "";
  return <span className={cls}>{percent(value)}</span>;
}

function compare(a: NormalizedPair, b: NormalizedPair, key: SortKey, dir: 1 | -1): number {
  const va = a[key];
  const vb = b[key];
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
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "volumeH1", dir: -1 });

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

  const rows = useMemo(() => {
    if (!result) return [];
    const base = onePerToken ? mostLiquidPairPerToken(result.pairs) : result.pairs;
    const q = filter.trim().toLowerCase();
    const filtered = q
      ? base.filter((p) =>
          [p.tokenName, p.tokenSymbol, p.tokenAddress, p.pairAddress, p.dexId].some((v) =>
            v?.toLowerCase().includes(q),
          ),
        )
      : base;
    return [...filtered].sort((a, b) => compare(a, b, sort.key, sort.dir));
  }, [result, onePerToken, filter, sort]);

  const coverage = useMemo(() => (result ? fieldCoverage(result.pairs) : null), [result]);

  const onSort = (key: SortKey) =>
    setSort((s) => (s.key === key ? { key, dir: s.dir === 1 ? -1 : 1 } : { key, dir: -1 }));

  const allFailed = result !== null && result.pairs.length === 0 && result.errors.length > 0;

  return (
    <main>
      <header>
        <div>
          <h1>Solana Scanner</h1>
          <p className="muted">
            Données réelles DEX Screener · lecture seule · aucun trading, aucun wallet, aucun scoring
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
        <span className="muted">{rows.length} lignes</span>
      </section>

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              {COLUMNS.map((c) => (
                <th
                  key={c.key}
                  className={c.numeric ? "num" : undefined}
                  onClick={() => onSort(c.key)}
                  title={`Source : ${SOURCE_PATH[c.key]}`}
                >
                  {c.label}
                  {sort.key === c.key ? (sort.dir === -1 ? " ▼" : " ▲") : ""}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => (
              <tr key={p.pairAddress}>
                {COLUMNS.map((c) => (
                  <td key={c.key} className={c.numeric ? "num" : undefined}>
                    {c.render(p)}
                  </td>
                ))}
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={COLUMNS.length} className="empty">
                  {loading ? "Chargement des données DEX Screener…" : "Aucune paire à afficher."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

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
