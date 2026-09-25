/**
 * Every rule, weight and threshold of the scoring engine lives here.
 *
 * Nothing in this file predicts a future price. The scores describe what can
 * be *observed right now* in DEX Screener data:
 *   - Opportunity: strength of the observed setup,
 *   - Risk: level of detected risk,
 *   - Quality: credibility of the data and of the trading activity,
 *   - Confidence (LOW / MEDIUM / HIGH): how much the other scores can be relied on.
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
    /**
     * Discounts that stop Opportunity from rewarding activity that looks
     * artificial. Each is a multiplier (0…1) applied to specific items; the
     * explanation shows the points before and after.
     */
    adjustments: {
      /**
       * Average transaction size on 1 h (volume.h1 / txns.h1) → multiplier on
       * the buy/sell ratio items, the transaction-count item and the age
       * activity factor. Only applied with at least `minTxns` transactions.
       */
      smallTicket: { minTxns: number; curve: Curve };
      /** volume.h1 / liquidity.usd → multiplier on the volume 5 min and 1 h items. */
      turnover: Curve;
      /** Multiplier on the buy/sell ratio items when price/activity divergence is detected. */
      divergence: number;
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

  /**
   * Quality = 100 − Σ deductions (floored at 0). Each curve gives deduction
   * points. Deductions flagged as anomalies are listed as such in the UI.
   */
  quality: {
    /** Average transaction size (USD) → deduction. Needs `minTxns` in the window. */
    smallTicket: { minTxns: number; curve: Curve; artificialBelowUsd: number; artificialMinTxns: number };
    /**
     * Buy share (buys / total) → deduction, multiplied by a sample weight
     * (transactions → 0…1) so a 3/0 split is not an anomaly but 573/4 is.
     */
    buyImbalanceH1: Curve;
    buyImbalanceM5: Curve;
    imbalanceWeightH1: Curve;
    imbalanceWeightM5: Curve;
    /**
     * Price/activity divergence: many transactions, buy-dominated, yet the price
     * barely moves (|change| ≤ maxPriceChange). Deduction from the curve on
     * |price change|.
     */
    divergenceH1: { minTxns: number; minBuyShare: number; maxPriceChange: number; curve: Curve };
    divergenceM5: { minTxns: number; minBuyShare: number; maxPriceChange: number; curve: Curve };
    /** volume.h1 / liquidity.usd → deduction. */
    turnover: Curve;
    /** Highest of priceChange.h1 / h6 (%) → deduction. */
    extremePump: Curve;
    /** Lowest of priceChange.h1 / h6 (%) → deduction. */
    extremeDump: Curve;
    /** |priceChange.m5| (%) → deduction. */
    violentM5: Curve;
    /** Total 1 h transactions → deduction (too small a sample). */
    fewTxns: Curve;
    /** Pair age in minutes → deduction (little history). */
    veryNew: Curve;
    /** liquidity.usd absent. */
    missingLiquidity: number;
    /** Per other missing important field, capped. */
    missingField: { perField: number; max: number };
    /** liquidity.usd > marketCap. */
    liquidityAboveMcap: number;
    /** Per inconsistency between time windows (e.g. volume 5 min > volume 1 h), capped. */
    windowInconsistency: { perIssue: number; max: number; tolerance: number };
  };

  /** Confidence points (0–100) → LOW / MEDIUM / HIGH, with hard caps. */
  confidence: {
    /** Share of important fields present (0…1) → points. */
    completeness: Curve;
    /** Pair age in minutes → points. */
    age: Curve;
    /** Total 1 h transactions → points. */
    txns: Curve;
    /** liquidity.usd present and ≥ `minUsd`: `full` points; present but lower: `partial`. */
    liquidity: { minUsd: number; full: number; partial: number };
    /** Points when no time-window inconsistency is found. */
    consistency: number;
    /** Points removed per anomaly, capped. */
    perAnomaly: number;
    maxAnomalyPenalty: number;
    high: number;
    medium: number;
    /** Hard caps on the level. */
    lowIfAgeBelowMinutes: number;
    mediumMaxIfAgeBelowMinutes: number;
    lowIfQualityBelow: number;
    mediumMaxIfQualityBelow: number;
    /** liquidity.usd absent (e.g. pump.fun bonding curve) → at most MEDIUM. */
    mediumMaxIfNoLiquidity: boolean;
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
    /** Average 1 h transaction size (USD) → risk points (needs `minTxns`). */
    smallTicket: { minTxns: number; curve: Curve };
    /** Buy share on 1 h → risk points, times the quality imbalance sample weight. */
    buyImbalance: Curve;
    /** Flat risk points when price/activity divergence is detected on 1 h. */
    divergence: number;
  };

  /** Descriptive tags. They are never buy recommendations. */
  labels: {
    highRisk: { minRisk: number };
    momentum: { minOpportunity: number; minMomentum: number; maxRisk: number; minQuality: number; allowLowConfidence: boolean };
    watch: { minOpportunity: number; maxRisk: number; minQuality: number };
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
        [0.8, 1],
        [0.9, 0.6],
        [0.97, 0.25],
        [1, 0.1],
      ],
      ratioH1Max: 7,
      ratioH1: [
        [0.3, 0],
        [0.45, 0.3],
        [0.55, 0.7],
        [0.65, 1],
        [0.8, 1],
        [0.9, 0.6],
        [0.97, 0.25],
        [1, 0.1],
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

    adjustments: {
      smallTicket: {
        minTxns: 50,
        curve: [
          [1, 0.2],
          [3, 0.4],
          [8, 0.75],
          [15, 1],
        ],
      },
      turnover: [
        [5, 1],
        [10, 0.7],
        [30, 0.4],
        [100, 0.2],
      ],
      divergence: 0.5,
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

  quality: {
    smallTicket: {
      minTxns: 50,
      curve: [
        [1, 35],
        [3, 25],
        [8, 12],
        [15, 4],
        [25, 0],
      ],
      artificialBelowUsd: 3,
      artificialMinTxns: 300,
    },
    buyImbalanceH1: [
      [0.8, 0],
      [0.85, 5],
      [0.9, 12],
      [0.95, 20],
      [0.99, 28],
    ],
    buyImbalanceM5: [
      [0.8, 0],
      [0.85, 3],
      [0.9, 7],
      [0.95, 12],
      [0.99, 16],
    ],
    imbalanceWeightH1: [
      [30, 0],
      [100, 0.5],
      [300, 1],
    ],
    imbalanceWeightM5: [
      [15, 0],
      [50, 0.5],
      [150, 1],
    ],
    divergenceH1: {
      minTxns: 1_000,
      minBuyShare: 0.65,
      maxPriceChange: 10,
      curve: [
        [2, 15],
        [10, 0],
      ],
    },
    divergenceM5: {
      minTxns: 150,
      minBuyShare: 0.7,
      maxPriceChange: 3,
      curve: [
        [0.5, 8],
        [3, 0],
      ],
    },
    turnover: [
      [3, 0],
      [5, 4],
      [10, 12],
      [30, 25],
      [200, 40],
    ],
    extremePump: [
      [150, 0],
      [300, 10],
      [1_000, 30],
    ],
    extremeDump: [
      [-95, 30],
      [-80, 20],
      [-50, 6],
      [-30, 0],
    ],
    violentM5: [
      [25, 0],
      [50, 8],
      [100, 15],
    ],
    fewTxns: [
      [10, 20],
      [50, 8],
      [100, 0],
    ],
    veryNew: [
      [5, 10],
      [15, 5],
      [30, 0],
    ],
    missingLiquidity: 15,
    missingField: { perField: 4, max: 20 },
    liquidityAboveMcap: 10,
    windowInconsistency: { perIssue: 15, max: 30, tolerance: 0.01 },
  },

  confidence: {
    completeness: [
      [0.5, 0],
      [1, 25],
    ],
    age: [
      [5, 0],
      [30, 8],
      [120, 15],
      [360, 20],
    ],
    txns: [
      [20, 0],
      [100, 10],
      [500, 20],
    ],
    liquidity: { minUsd: 5_000, full: 15, partial: 7 },
    consistency: 20,
    perAnomaly: 6,
    maxAnomalyPenalty: 30,
    high: 70,
    medium: 45,
    lowIfAgeBelowMinutes: 15,
    mediumMaxIfAgeBelowMinutes: 60,
    lowIfQualityBelow: 40,
    mediumMaxIfQualityBelow: 60,
    mediumMaxIfNoLiquidity: true,
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
      [-95, 50],
      [-80, 35],
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
      [200, 30],
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
    smallTicket: {
      minTxns: 50,
      curve: [
        [1, 10],
        [3, 6],
        [8, 2],
        [15, 0],
      ],
    },
    buyImbalance: [
      [0.85, 0],
      [0.95, 6],
      [0.99, 10],
    ],
    divergence: 5,
  },

  labels: {
    highRisk: { minRisk: 50 },
    momentum: { minOpportunity: 60, minMomentum: 15, maxRisk: 40, minQuality: 60, allowLowConfidence: false },
    watch: { minOpportunity: 45, maxRisk: 49, minQuality: 40 },
  },
};

export const LABEL_DISCLAIMER =
  "WATCH, MOMENTUM, HIGH RISK, Quality et Confidence décrivent l'état observé des données. " +
  "Ce ne sont pas des recommandations d'achat ni des prédictions de prix.";
