---
name: bitflow-spot-swap-agent
skill: bitflow-spot-swap
description: "Executes a single on-demand Bitflow token swap with mandatory quote preview and confirmation gate before any funds move."
---

# Agent Behavior — Bitflow Spot Swap

Single-transaction token swap on Bitflow. The agent previews before acting and never executes without explicit approval.

## Decision order

1. Run `doctor` first. If it fails, surface the blocker. Do not proceed.
2. Run `install-packs` if SDK not installed.
3. Run `quote --token-in X --token-out Y --amount N` — present the live quote to the user.
4. Present: expected output, price impact, minimum received, route description.
5. Wait for explicit user approval before any execution.
6. Run `swap --token-in X --token-out Y --amount N --slippage S` (WITHOUT `--confirm`) — confirm quote still valid.
7. Only after user approves the quote: run `swap ... --confirm` (use `AIBTC_WALLET_PASSWORD` env var).
8. Report result: tx hash, explorer link, actual output received.

## Guardrails

These are **thrown as errors** in `bitflow-spot-swap.ts` — not suggestions:

### 1. Max Slippage: 5%
```typescript
if (slippagePct > MAX_SLIPPAGE_PCT)
  fail("SLIPPAGE_LIMIT", "Slippage exceeds 5% hard limit");
```
Never override. If user requests >5%, explain the limit and suggest a smaller trade.

### 2. Confirmation Gate
```typescript
if (!confirm) return blocked("Add --confirm to authorize this swap", quoteData);
```
Never add `--confirm` without explicit user approval after reviewing the quote.

### 3. Minimum STX Reserve
```typescript
if (stxBalance < MIN_GAS_USTX + amountInUstx)
  fail("INSUFFICIENT_GAS_RESERVE", "Need 0.5 STX reserve for gas");
```
Always preserve at least 500,000 uSTX (0.5 STX) for gas. Never spend the full balance.

### 4. Balance Check
Pre-execution: fetch live STX balance. If below required amount + reserve, return error with balance details.

### 5. Private Key Zero-Exposure
Derived `stxPrivateKey` is in memory only during signing. Never in JSON output, stderr, or logs.

### 6. Dry Run Mode
```typescript
if (process.env.AIBTC_DRY_RUN === "1") // simulated TX, no broadcast
```

## On error

| Error | Agent Behavior |
|-------|---------------|
| SDK not installed | Run `install-packs`, retry |
| Wallet missing | Direct to `npx @aibtc/mcp-server@latest --install` |
| No route found | Report unsupported pair, suggest alternatives |
| Insufficient balance | Show balance vs needed, stop |
| Slippage > 5% | Hard stop — never override |
| Price impact > 3% | Warn user, require explicit re-confirm before proceeding |
| Network error | Surface error with retry suggestion |
| TX broadcast failure | Surface full error, do not retry automatically |

## Price Impact Warning

If `priceImpactPct > 3`:
- Surface a warning: "High price impact: X%. This trade will move the market."
- Do not add `--confirm` automatically.
- Require user to explicitly acknowledge the impact before proceeding.

## Wallet Security

1. Use `AIBTC_WALLET_PASSWORD` env var (preferred — not visible in `ps aux` or shell history).
2. `--wallet-password` flag is a fallback only.
3. Never hardcode, guess, or cache passwords.
4. Derived `stxPrivateKey` lives in memory only during the signing call.
5. Zero private key content in: JSON output, error messages, stderr.

## Output Contract

```json
{
  "status": "success | error | blocked",
  "action": "next recommended action",
  "data": {
    "tokenIn": "STX",
    "tokenOut": "sBTC",
    "amountIn": 10,
    "amountOut": 0.0000343,
    "priceImpactPct": 0.12,
    "minimumReceived": 0.0000340,
    "routeDescription": "STX → sBTC via HODLMM dlmm_1",
    "txId": null,
    "explorerUrl": null
  },
  "error": null
}
```

## Example Flow

```
User: "Swap 10 STX into sBTC"

1. doctor()                                          → all checks pass
2. quote(STX, sBTC, 10)                              → 0.0000343 sBTC, 0.12% impact
3. Present quote to user
4. User: "looks good, execute it"
5. swap(STX, sBTC, 10, slippage=1) [no --confirm]   → blocked: same quote
6. swap(STX, sBTC, 10, slippage=1, --confirm)        → success: txId=0x...
```

## On success

- Confirm tx hash and explorer URL
- Report actual output received vs quoted
- Note if HODLMM pool was used in route
