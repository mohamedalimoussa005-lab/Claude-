#!/usr/bin/env node
// PreToolUse guard: Helius MCP is strictly read-only in this project.
//
// Default deny: a Helius call passes only if its tool AND its `action` are in
// the read-only allowlist below (checked against helius-mcp 2.2.0). Any other
// tool (heliusWrite, heliusAccount, heliusStreaming, heliusCompression…), any
// unknown or future action, and simulateTransaction are refused.
// Complements the permissions.deny rules in .claude/settings.json.

const READ_ACTIONS = {
  mcp__helius__heliusWallet: [
    "getBalance",
    "getTokenBalances",
    "getWalletBalances",
    "getWalletBalanceAt",
    "getWalletHistory",
    "getWalletTransfers",
    "getWalletIdentity",
    "batchWalletIdentity",
    "getWalletFundedBy",
  ],
  mcp__helius__heliusAsset: [
    "getAsset",
    "getAssetsByOwner",
    "searchAssets",
    "getAssetsByGroup",
    "getAssetProof",
    "getAssetProofBatch",
    "getSignaturesForAsset",
    "getNftEditions",
    "getTokenHolders",
  ],
  mcp__helius__heliusTransaction: ["parseTransactions", "getTransactionHistory", "getTransfersByAddress"],
  mcp__helius__heliusChain: [
    "getAccountInfo",
    "getTokenAccounts",
    "getProgramAccounts",
    "getBlock",
    "getNetworkStatus",
    "getPriorityFeeEstimate",
    "getStakeAccounts",
    "getWithdrawableAmount",
  ],
  mcp__helius__heliusKnowledge: [
    "lookupHeliusDocs",
    "listHeliusDocTopics",
    "getHeliusCreditsInfo",
    "getRateLimitInfo",
    "troubleshootError",
    "recommendStack",
    "getSIMD",
    "listSIMDs",
    "searchSolanaDocs",
    "readSolanaSourceFile",
    "fetchHeliusBlog",
    "getPumpFunGuide",
    "getSenderInfo",
    "getWebhookGuide",
    "getLatencyComparison",
    "getEnhancedWebSocketInfo",
    "getLaserstreamInfo",
  ],
};
// expandResult only re-reads a previous result; it has no action.
const NO_ACTION_TOOLS = new Set(["mcp__helius__expandResult"]);

let raw = "";
process.stdin.on("data", (d) => (raw += d));
process.stdin.on("end", () => {
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    return deny("Helius guard: unreadable hook input");
  }
  const tool = String(input.tool_name ?? "");
  if (!tool.startsWith("mcp__helius__")) return; // not a Helius call
  if (NO_ACTION_TOOLS.has(tool)) return;
  const actions = READ_ACTIONS[tool];
  if (!actions) return deny(`Helius is read-only here: ${tool} is not allowed.`);
  const action = String(input.tool_input?.action ?? "");
  if (!actions.includes(action)) return deny(`Helius is read-only here: action "${action}" of ${tool} is not in the read allowlist.`);
});

function deny(reason) {
  process.stdout.write(
    JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } }),
  );
}
