/**
 * Every rule, weight and threshold of the scoring engine lives here.
 *
 * Nothing in this file predicts a future price. The scores describe what can
 * be *observed right now* in DEX Screener data: how clean the setup is
 * (Opportunity) and how fragile or abnormal it looks (Risk).
 *
 * ─── How to read a curve ────────────────────────────────────────────────────
 * A curve is a list of [x, y] points, x ascending. The engine interpolates
 * linearly between points and clamps outside them (below the first x → first
 * y, above the last x → last y).
 *
 *   - Opportunity curves: y is the *fraction* (0…1) of the item's `max` points.
 *   - Risk curves: y is directly the number of risk points.
 *
 * Example: `[[0, 0], [10, 1]]` with max 5 → x=5 gives 2.5 points.
 *
 * ─── Missing data ───────────────────────────────────────────────────────────
 * A missing input is never replaced by 0. The item simply awards no
 * opportunity points, is marked "donnée absente" in the explanation, and the
 * gap is counted in the Risk score.
 */

export type Curve = readonly (readonly [x: number, y: number])[];

export interface ScoringConfig {
  opportunity: {
    momentum: {
      max: number;
      /** priceChange.m5 (%) → fraction of `m5Max`. */
      m5Max: number;
      m5: Curve;
      /** priceChange.h1 (%) → fraction of `h1Max`. */
      h1Max: number;
      h1: Curve;
      /**
       * Acceleration = priceChange.m5 − (average 5-min change over the last hour).
       * Average 5-min change = priceChange.h1 / (minutes covered by h1 / 5).
       * Expressed in percentage points.
       */
      accelMax: number;
      accel: Curve;
      /** priceChange.h6 (%) as trend context → fraction of `h6Max`. */
      h6Max: number;
      h6: Curve;
      /**
       * Extreme-move cap: if any of m5 / h1 / h6 is at or above its threshold,
       * the whole Momentum category is capped at `cap` points.
       */
      extreme: { m5: number; h1: number; h6: number; cap: number };
    };
    volume: {
      max: number;
      m5Max: number;
      /** volume.m5 (USD). */
      m5: Curve;
      h1Max: number;
      /** volume.h1 (USD). */
      h1: Curve;
      turnoverMax: number;
      /** volume.h1 / liquidity.usd. Healthy in the middle, suspicious at the extremes. */
      turnover: Curve;
      accelMax: number;
      /**
       * Volume acceleration = volume.m5 / (average 5-min volume over the last hour).
       * 1 = same pace as the hour, 2 = twice the pace.
       */
      accel: Curve;
    };
    buyPressure: {
      max: number;
      /** buys / (buys + sells) on 5 min → fraction of `ratioM5Max`. */
      ratioM5Max: number;
      ratioM5: Curve;
      ratioH1Max: number;
      ratioH1: Curve;
      /**
       * Confidence applied to each ratio: with fewer than `min` transactions the
       * ratio earns nothing; confidence then grows linearly up to 1 at `full`.
       * Prevents 2 buys / 0 sells from looking like "100 % buy pressure".
       */
      confidenceM5: { min: number; full: number };
      confidenceH1: { min: number; full: number };
      activityMax: number;
      /** Total transactions on 1 h (buys + sells). */
      activity: Curve;
    };
    liquidity: {
      max: number;
      usdMax: number;
      /** liquidity.usd. */
      usd: Curve;
      ratioMax: number;
      /** liquidity.usd / marketCap. Very high values (liquidity > mcap) are unusual. */
      ratio: Curve;
    };
    marketCap: {
      max: number;
      /** marketCap (USD) → fraction of `max`. Favours small/mid caps, not dust. */
      curve: Curve;
      /**
       * Illiquid dust cap: if liquidity.usd is missing or below
       * `minLiquidityUsd`, the category is capped at `cap` points.
       */
      illiquid: { minLiquidityUsd: number; cap: number };
    };
    age: {
      max: number;
      /** Pair age in minutes → age fraction. Very new ≠ automatically good. */
      ageCurve: Curve;
      /**
       * Real-activity factor from total 1 h transactions. Final points =
       * max × ageFraction × activityFactor, so a brand-new pair with no
       * trading earns nothing.
       */
      activityCurve: Curve;
    };
  };

  risk: {
    /** The risk score is the sum of the factors below, capped at `cap`. */
    cap: number;
    /** liquidity.usd (USD) → risk points. */
    lowLiquidity: Curve;
    /** When liquidity.usd is missing on a pump.fun pair (bonding curve, no pool yet). */
    bondingCurveNoLiquidity: number;
    /** DEX ids treated as pump.fun bonding curve. */
    bondingCurveDexIds: readonly string[];
    /** When liquidity.usd is missing on any other DEX. */
    missingLiquidity: number;
    /** marketCap (USD) → risk points. */
    lowMarketCap: Curve;
    /** Total 1 h transactions → risk points. */
    fewTransactions: Curve;
    /** Worst of priceChange.h1 / h6 (%) → risk points. */
    priceCrash: Curve;
    /** priceChange.m5 (%) → risk points for a sharp 5-min drop. */
    priceCrashM5: Curve;
    /** volume.h1 / liquidity.usd → risk points. */
    abnormalTurnover: Curve;
    /** |priceChange.m5| (%) → risk points. */
    violentM5: Curve;
    /** |priceChange.h1| (%) → risk points. */
    violentH1: Curve;
    /** Pair age in minutes → risk points. */
    veryNew: Curve;
    /** Points per missing important field (liquidity has its own factor). */
    missingField: { perField: number; max: number };
  };

  /** Descriptive tags. They are never buy recommendations. */
  labels: {
    highRisk: { minRisk: number };
    momentum: { minOpportunity: number; minMomentum: number; maxRisk: number };
    watch: { minOpportunity: number; maxRisk: number };
  };
}

export const SCORING_CONFIG: ScoringConfig = {
  opportunity: {
    // A. MOMENTUM — 25 points
    momentum: {
      max: 25,
      m5Max: 7,
      m5: [
        [-10, 0],
        [-2, 0.2],
        [0, 0.4],
        [3, 0.8],
        [8, 1],
        [25, 1],
        [60, 0.5],
        [150, 0.1],
      ],
      h1Max: 10,
      h1: [
        [-30, 0],
        [-5, 0.2],
        [0, 0.4],
        [15, 0.8],
        [40, 1],
        [150, 1],
        [400, 0.5],
        [1000, 0.1],
      ],
      accelMax: 5,
      accel: [
        [-5, 0],
        [0, 0.4],
        [3, 0.8],
        [8, 1],
        [30, 1],
        [80, 0.4],
      ],
      h6Max: 3,
      h6: [
        [-50, 0],
        [0, 0.5],
        [50, 1],
        [500, 1],
        [2000, 0.3],
      ],
      extreme: { m5: 100, h1: 500, h6: 2000, cap: 12 },
    },

    // B. VOLUME — 20 points
    volume: {
      max: 20,
      m5Max: 5,
      m5: [
        [0, 0],
        [500, 0.2],
        [2_000, 0.6],
        [10_000, 1],
      ],
      h1Max: 6,
      h1: [
        [1_000, 0],
        [10_000, 0.35],
        [50_000, 0.7],
        [200_000, 1],
      ],
      turnoverMax: 5,
      turnover: [
        [0, 0],
        [0.1, 0.2],
        [0.5, 0.8],
        [1, 1],
        [3, 1],
        [6, 0.6],
        [15, 0],
      ],
      accelMax: 4,
      accel: [
        [0.3, 0],
        [0.8, 0.4],
        [1.2, 0.75],
        [2, 1],
      ],
    },

    // C. BUY PRESSURE — 20 points
    buyPressure: {
      max: 20,
      ratioM5Max: 7,
      ratioM5: [
        [0.3, 0],
        [0.45, 0.3],
        [0.55, 0.7],
        [0.65, 1],
        [0.85, 1],
        [1, 0.8],
      ],
      ratioH1Max: 7,
      ratioH1: [
        [0.3, 0],
        [0.45, 0.3],
        [0.55, 0.7],
        [0.65, 1],
        [0.85, 1],
        [1, 0.8],
      ],
      confidenceM5: { min: 5, full: 30 },
      confidenceH1: { min: 10, full: 100 },
      activityMax: 6,
      activity: [
        [10, 0],
        [50, 0.35],
        [200, 0.7],
        [1_000, 1],
      ],
    },

    // D. LIQUIDITY — 15 points
    liquidity: {
      max: 15,
      usdMax: 10,
      usd: [
        [1_000, 0],
        [5_000, 0.2],
        [15_000, 0.5],
        [50_000, 0.8],
        [150_000, 1],
      ],
      ratioMax: 5,
      ratio: [
        [0.02, 0],
        [0.05, 0.4],
        [0.1, 0.8],
        [0.2, 1],
        [0.8, 1],
        [1.2, 0.6],
        [2, 0.2],
      ],
    },

    // E. MARKET CAP / UPSIDE PROFILE — 10 points
    marketCap: {
      max: 10,
      curve: [
        [5_000, 0],
        [20_000, 0.3],
        [50_000, 0.7],
        [100_000, 1],
        [1_000_000, 1],
        [5_000_000, 0.6],
        [20_000_000, 0.3],
        [100_000_000, 0.1],
      ],
      illiquid: { minLiquidityUsd: 5_000, cap: 3 },
    },

    // F. AGE / EARLY MOMENTUM — 10 points
    age: {
      max: 10,
      ageCurve: [
        [0, 0.3],
        [10, 0.5],
        [30, 0.8],
        [60, 1],
        [360, 1],
        [1_440, 0.7],
        [4_320, 0.4],
        [10_080, 0.2],
      ],
      activityCurve: [
        [20, 0],
        [100, 0.5],
        [300, 1],
      ],
    },
  },

  risk: {
    cap: 100,
    lowLiquidity: [
      [2_000, 25],
      [5_000, 18],
      [10_000, 10],
      [25_000, 4],
      [50_000, 0],
    ],
    bondingCurveNoLiquidity: 20,
    bondingCurveDexIds: ["pumpfun"],
    missingLiquidity: 25,
    lowMarketCap: [
      [5_000, 15],
      [10_000, 10],
      [25_000, 5],
      [50_000, 0],
    ],
    fewTransactions: [
      [10, 15],
      [30, 10],
      [100, 3],
      [200, 0],
    ],
    priceCrash: [
      [-95, 40],
      [-80, 30],
      [-50, 15],
      [-30, 5],
      [-15, 0],
    ],
    priceCrashM5: [
      [-30, 10],
      [-15, 5],
      [-8, 0],
    ],
    abnormalTurnover: [
      [5, 0],
      [10, 10],
      [30, 18],
    ],
    violentM5: [
      [10, 0],
      [25, 5],
      [50, 10],
    ],
    violentH1: [
      [100, 0],
      [300, 8],
      [1_000, 15],
    ],
    veryNew: [
      [5, 8],
      [15, 5],
      [60, 0],
    ],
    missingField: { perField: 3, max: 15 },
  },

  labels: {
    highRisk: { minRisk: 50 },
    momentum: { minOpportunity: 60, minMomentum: 15, maxRisk: 40 },
    watch: { minOpportunity: 45, maxRisk: 49 },
  },
};

export const LABEL_DISCLAIMER =
  "WATCH, MOMENTUM et HIGH RISK sont des étiquettes descriptives de l'état observé. " +
  "Ce ne sont pas des recommandations d'achat ni des prédictions de prix.";
