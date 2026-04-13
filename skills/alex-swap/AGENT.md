---
name: alex-swap-agent
skill: alex-swap
description: "Executes token swaps on ALEX DEX (Stacks L2) with mandatory confirmation gates, autonomous spend limits, and slippage protection."
---

# Agent Behavior — alex-swap

ALEX DEX is the second-largest Stacks L2 DEX. This skill swaps tokens via `swap-helper-v1-03` using the `alex-sdk` for routing and quote calculation.

## Decision Order

1. Run `doctor` first. If it fails, surface the blocker. Do not proceed.
2. Run `tokens` if the user doesn't know available pairs.
3. Run `quote` to get a live price before any spend commitment.
4. Run `run` (WITHOUT `--confirm`) to preview the swap with slippage applied.
5. Present the preview to the user. Wait for explicit approval.
6. Only after approval: `run --confirm` (use `AIBTC_WALLET_PASSWORD` env var — not `--wallet-password` flag).
7. Report the tx hash and explorer link after execution.

## Guardrails (enforced in alex-swap.ts)

### 1. Max Slippage: 5%
```typescript
if (slippagePct > MAX_SLIPPAGE_PCT)
  fail("SLIPPAGE_LIMIT", ...);
```
Any `--slippage` above 5% aborts before execution. Default is 2%.

### 2. Autonomous Spend Cap: 10,000 STX equivalent per swap
```typescript
if (amountNum > MAX_AUTO_STX)
  fail("SPEND_LIMIT", ...);
```
Single-swap limit. Operator must explicitly authorize amounts above this.

### 3. Confirmation Gate
```typescript
if (!opts.confirm) return blocked("Add --confirm to authorize...", ...);
```
**Never** add `--confirm` without explicit user approval.

### 4. Gas Reserve
```typescript
if (stxBalance < MIN_STX_GAS_USTX)
  fail("INSUFFICIENT_GAS", ...);
```
Always maintains 0.05 STX minimum for transaction fees.

### 5. STX Balance Check (for STX inputs)
```typescript
if (stxBalance < amountInUstx + MIN_STX_GAS_USTX)
  fail("INSUFFICIENT_BALANCE", ...);
```
Verifies sufficient STX balance before execution.

### 6. Post-Condition Mode: Deny
```typescript
postConditionMode: PostConditionMode.Deny
```
Rejects the transaction if post-conditions are unmet — prevents unexpected token movements.

### 7. Private Key Zero-Exposure
Derived `stxPrivateKey` is used only for transaction signing. Never logged, never serialized, never in JSON output.

## Error Handling

| Error Code | Agent Behavior |
|------------|----------------|
| `WALLET_NOT_FOUND` | Direct to `npx @aibtc/mcp-server@latest --install` |
| `SLIPPAGE_LIMIT` | Hard stop — never override the 5% cap |
| `SPEND_LIMIT` | Request operator approval for amount above 10,000 STX |
| `INSUFFICIENT_GAS` | Stop — fund wallet with STX first |
| `INSUFFICIENT_BALANCE` | Stop — reduce amount or fund wallet |
| `TOKEN_NOT_FOUND` | Run `tokens` command, suggest closest match |
| `QUOTE_ERROR` | Check token pair liquidity, try `tokens` command |
| `SWAP_FAILED` | Surface full error, check explorer for pending tx |
| `INSTALL_FAILED` | Surface bun install error, check connectivity |

## Wallet Security

1. Use `AIBTC_WALLET_PASSWORD` env var (preferred — not visible in `ps aux` or shell history).
2. `--wallet-password` flag is a fallback only.
3. Never hardcode, guess, or cache passwords.
4. Zero private key content in: JSON output, error messages, stderr.

## When to Use `--slippage`

- Default (2%): Good for liquid pairs (STX/USDA, STX/sUSDT) in normal conditions.
- Higher (3-5%): Use for volatile markets, low-liquidity pairs, or large swap sizes.
- Never exceed 5%: Enforced as a hard limit in code.

## Autonomous Operation Rules

- **Allowed without user prompt**: `doctor`, `tokens`, `quote`
- **Requires user confirmation**: `run --confirm`
- **Never autonomous**: amounts > 10,000 STX, slippage > 5%
- **Cooldown**: No built-in cooldown — operator should set a sensible frequency if running on a schedule.

## Output Contract

```json
{
  "status": "success | error | blocked",
  "action": "next recommended action",
  "data": {
    "txid": "0x...",
    "explorer": "https://explorer.hiro.so/txid/...",
    "telegram": "✅ emoji-rich summary",
    "token_in": "STX",
    "token_out": "USDA",
    "amount_in": 100,
    "min_out": 98.0,
    "slippage": 2
  },
  "error": null | { "code": "", "message": "", "next": "" }
}
```

## Example Autonomous Flow

```
Agent decides to swap 500 STX to USDA for liquidity management:

1. doctor()                             → all checks pass
2. quote(STX, USDA, 500)               → 500 STX → ~490 USDA
3. run(STX, USDA, 500, slippage=2)     → blocked: preview shown
4. User: "execute"
5. run(STX, USDA, 500, --confirm)      → ✅ txid: 0xabc...
6. Report: swap complete, tx confirmed
```
