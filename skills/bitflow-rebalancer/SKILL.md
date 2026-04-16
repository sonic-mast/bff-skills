---
name: bitflow-rebalancer
description: "Portfolio rebalancer for Stacks DeFi — automatically swaps tokens via Bitflow to maintain target allocations. Triggers only when drift exceeds the configured threshold. Supports HODLMM routes for efficient execution."
metadata:
  author: "sonic-mast"
  author-agent: "Sonic Mast"
  user-invocable: "false"
  arguments: "doctor | configure | status | preview | run | list | cancel"
  entry: "bitflow-rebalancer/bitflow-rebalancer.ts"
  requires: "wallet, signing"
  tags: "defi, write, mainnet-only, requires-funds, l2, hodlmm"
---

# Bitflow Rebalancer

Maintains target portfolio allocations across Bitflow token pairs on Stacks mainnet.
The agent calls `preview` to check drift and `run --confirm` to rebalance.
HODLMM routes are preferred when available for improved price efficiency.

## What it does

1. `configure` creates a local allocation plan with target percentages and drift threshold
2. `status` checks current balances vs targets and calculates required trades
3. `preview` shows the exact swaps needed (no tx yet)
4. `run` executes swaps when drift exceeds threshold — requires `--confirm`
5. Frequency-aware: `run` returns `blocked` if rebalanced within the cooldown window

## Why agents need it

Autonomous agents managing multi-token portfolios on Stacks drift from target allocations as prices move. Without automated rebalancing, agents must manually track drift and execute multi-step swaps. This skill gives agents a single `run --confirm` command that checks current allocation, determines required trades, and executes them via Bitflow — enabling hands-off portfolio maintenance within configured safety limits.

## Quick Start

```bash
# 1. Install dependencies
bun run bitflow-rebalancer/bitflow-rebalancer.ts install-packs

# 2. Health check
bun run bitflow-rebalancer/bitflow-rebalancer.ts doctor

# 3. Create a 60/40 STX-sBTC allocation plan (rebalance when >5% off target)
bun run bitflow-rebalancer/bitflow-rebalancer.ts configure \
  --token-a STX --target-a 60 \
  --token-b sBTC --target-b 40 \
  --threshold 5 --cooldown 24h

# 4. Preview required trades
bun run bitflow-rebalancer/bitflow-rebalancer.ts preview --plan <planId>

# 5. Execute rebalance (--confirm required)
export AIBTC_WALLET_PASSWORD="your-password"
bun run bitflow-rebalancer/bitflow-rebalancer.ts run --plan <planId> --confirm

# 6. Monitor all plans
bun run bitflow-rebalancer/bitflow-rebalancer.ts list
```

## Commands

### `doctor`
Checks Bitflow API connectivity, wallet file presence, and Stacks mainnet health.

### `install-packs`
One-time setup: installs required npm packages via `bun add`.

**Installs:** `@bitflowlabs/core-sdk`, `@stacks/transactions`, `@stacks/network`, `@stacks/wallet-sdk`, `@stacks/encryption`, `commander`, `tslib`

### `configure`

| Flag | Required | Description |
|------|----------|-------------|
| `--token-a` | ✅ | First token symbol (e.g. `STX`) |
| `--target-a` | ✅ | Target % for token A (e.g. `60`) |
| `--token-b` | ✅ | Second token symbol (e.g. `sBTC`) |
| `--target-b` | ✅ | Target % for token B (targets must sum to 100) |
| `--threshold` | ❌ | Drift % to trigger rebalance (default `5`, min `1`, max `20`) |
| `--slippage` | ❌ | Swap slippage % (default `3`, hard max `10`) |
| `--cooldown` | ❌ | Min time between rebalances: `1h`-`168h` (default `24h`) |
| `--hodlmm-only` | ❌ | Restrict routing to HODLMM pools only |

Validates both token symbols against live Bitflow routes before saving.

### `status --plan <id>` / `status --all`
Shows current balances, target allocation, actual allocation, and drift.

### `preview --plan <id>`
Calculates what swaps would rebalance the portfolio. Returns `blocked` if within threshold or cooldown. No transactions broadcast.

### `run --plan <id> [--confirm] [--hodlmm-only]`
Executes rebalancing swaps if drift exceeds threshold and cooldown has elapsed.

- **Without `--confirm`**: Returns preview. Safe to inspect.
- **With `--confirm`**: Executes swaps on-chain, logs tx hashes, records new allocation.

> **Security:** Prefer `AIBTC_WALLET_PASSWORD` env var over `--wallet-password` flag.

### `list`
List all local rebalancer plans with status and last rebalance time.

### `cancel --plan <id>`
Cancel a plan permanently. Future `run` calls will be blocked.

## Token Amounts and Allocation

Allocation is computed by total portfolio value in STX terms:
- Token A value = `balance_A × price_A_in_STX`
- Token B value = `balance_B × price_B_in_STX`
- Drift = `|actual_pct - target_pct|`

If drift exceeds threshold, swaps enough Token A → Token B (or vice versa) to reach target.

## Environment Variables

| Variable | Description |
|----------|-------------|
| `AIBTC_WALLET_PASSWORD` | Wallet password (preferred over `--wallet-password`) |
| `STACKS_PRIVATE_KEY` | Direct private key (testing only) |
| `AIBTC_DRY_RUN=1` | Simulate swaps without broadcasting |
| `BITFLOW_API_HOST` | Override Bitflow API base URL |

## Output contract

All commands emit strict JSON to stdout:

```json
{
  "status": "success | error | blocked",
  "action": "Human-readable next step",
  "data": {
    "telegram": "Telegram-friendly summary",
    "plan": {...},
    "trades": [...]
  },
  "error": null
}
```

## Safety notes

| Guardrail | Value | Enforcement |
|-----------|-------|-------------|
| Max slippage | 10% | Hard error `SLIPPAGE_LIMIT` |
| Min threshold | 1% | Hard error `THRESHOLD_TOO_LOW` |
| Max threshold | 20% | Hard error `THRESHOLD_TOO_HIGH` |
| Targets must sum to 100 | 100% | Hard error `TARGETS_INVALID` |
| Cooldown between rebalances | Configurable | `blocked` with time remaining |
| Below-threshold drift | Configurable | `blocked` — no unnecessary swaps |
| Confirmation required | Always | `blocked` without `--confirm` |
| Cancelled plans | Permanent | Hard error `PLAN_CANCELLED` |
| Private key exposure | Never | Zero in all output |
| Min trade size | > 0 | Error `TRADE_TOO_SMALL` |
| STX balance for gas | 100,000 uSTX minimum | Error `INSUFFICIENT_GAS` |
| Dry run mode | `AIBTC_DRY_RUN=1` | Simulates without broadcasting |

## HODLMM Integration

When `--hodlmm-only` is passed (in `configure` or `run`), the preference is stored in the plan. The Bitflow SDK's best-route resolver considers HODLMM pools alongside standard AMM pools automatically. Use `--hodlmm-only` to flag that HODLMM-exclusive routing is preferred; the SDK will apply this preference where supported.

## State Files

Plans stored at `~/.aibtc/rebalancer/<plan-id>.json`. Contains full config, balance snapshots, rebalance history with tx hashes, and running allocation log.
