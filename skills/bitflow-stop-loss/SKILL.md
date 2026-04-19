---
name: bitflow-stop-loss
description: "Protect token positions from price drops — create stop-loss orders that auto-sell on Bitflow when price falls below your threshold. The agent IS the order engine: each `run` call checks prices and executes triggered sells."
metadata:
  author: "sonic-mast"
  author-agent: "Sonic Mast"
  user-invocable: "false"
  arguments: "doctor | install-packs | set --token-in <T> --token-out <T> --amount <N> --stop-price <N> [--slippage <PCT>] [--expires <DURATION>] | run [--confirm] [--wallet-password <PW>] | list [--order-id <ID>] | cancel <ID> | status --order <ID>"
  entry: "bitflow-stop-loss/bitflow-stop-loss.ts"
  requires: "wallet, signing, settings"
  tags: "defi, write, mainnet-only, requires-funds, l2, risk-management"
---

# bitflow-stop-loss

Agent-powered stop-loss orders on Bitflow. Bitflow has no native stop-loss support — the agent IS the protection layer.

## What it does

Creates stop-loss orders for token positions on Bitflow. When the market price of your held token falls below your configured threshold, the agent automatically sells to limit downside. Price is sampled via the BitflowSDK quote API on each `run` call.

**Core flow:**
1. `set` — Create a stop-loss order: specify token pair, amount to protect, price threshold, slippage, expiry
2. `run` — Called on each heartbeat: loads active orders, fetches live quotes, executes sells when price < stop-price
3. `list` / `cancel` / `status` — Manage the order book

```
Agent/User ─set──▶ Order File ─run──▶ Quote Check ──trigger──▶ BitflowSDK Swap
                   (~/.aibtc/         (price < stop)             (on-chain tx)
                    stop-loss)
```

## Quick Start

```bash
# 1. Install dependencies
bun run bitflow-stop-loss/bitflow-stop-loss.ts install-packs

# 2. Health check
bun run bitflow-stop-loss/bitflow-stop-loss.ts doctor

# 3. Protect 50 STX — sell to sBTC if price drops below 0.000035 sBTC/STX
bun run bitflow-stop-loss/bitflow-stop-loss.ts set \
  --token-in STX --token-out sBTC \
  --amount 50 --stop-price 0.000035 --slippage 3 --expires 7d

# 4. Run the check (dry-run first — without --confirm)
bun run bitflow-stop-loss/bitflow-stop-loss.ts run

# 5. Execute triggered orders
export AIBTC_WALLET_PASSWORD="your-password"
bun run bitflow-stop-loss/bitflow-stop-loss.ts run --confirm

# 6. View active orders
bun run bitflow-stop-loss/bitflow-stop-loss.ts list

# 7. Cancel an order
bun run bitflow-stop-loss/bitflow-stop-loss.ts cancel <orderId>
```

## Commands

### `doctor`
Health check — verifies Bitflow API, wallet file, and Stacks mainnet connectivity. Safe to call at any time.

### `install-packs`
One-time setup: installs `@bitflowlabs/core-sdk`, `@stacks/transactions`, `@stacks/network`, `@stacks/wallet-sdk`, `@stacks/encryption`, `commander`. Run once per environment.

### `set`

| Flag | Required | Description |
|------|----------|-------------|
| `--token-in` | ✅ | Token you hold and want to sell (e.g. `STX`) |
| `--token-out` | ✅ | Token to receive on execution (e.g. `sBTC`) |
| `--amount` | ✅ | Amount of token-in to sell when triggered (human units) |
| `--stop-price` | ✅ | Sell if market price falls below this (token-out per token-in) |
| `--slippage` | ❌ | Slippage % (default `3`, hard max `15`) |
| `--expires` | ❌ | Expiry duration: `1d`, `7d`, `30d` (default `7d`) |

Validates the token pair against live Bitflow routes before saving. Returns `error` if no route exists.

### `run [--confirm] [--wallet-password <pw>]`
Check all active stop-loss orders. For each order where `current_price < stop_price`:
- **Without `--confirm`**: Returns quote preview — shows current price, stop price, expected output. Safe.
- **With `--confirm`**: Executes the swap on-chain. Marks order as `triggered`.

Returns `blocked` if no orders are triggered.

> **Security:** Prefer `AIBTC_WALLET_PASSWORD` env var over `--wallet-password` flag.

### `list [--order-id <id>]`
List all stop-loss orders with status, current price vs stop price, and time remaining.

### `cancel <orderId>`
Cancel a pending stop-loss order. Expired or triggered orders cannot be cancelled.

### `status --order <id>`
Detailed view of a single order: full config, current price, price history (last 5 checks), execution log.

## Token Amounts & Prices

Pass `--amount` in **human-readable units** (not microunits):
- `--amount 50` with STX = 50 STX (not 50,000,000 uSTX)

Pass `--stop-price` in **token-out per 1 token-in**:
- `--stop-price 0.000035` means "sell if 1 STX buys less than 0.000035 sBTC"

Price is sampled via live Bitflow quote: `quote(1 tokenIn → tokenOut)`.

## Expiry Durations

| Format | Example | Meaning |
|--------|---------|---------|
| `Nd` | `7d` | 7 days from now |
| `Nh` | `24h` | 24 hours from now |
| `Nw` | `2w` | 2 weeks from now |

Orders past expiry are automatically cleaned up on the next `run` call.

## Output Format

All commands emit strict JSON to stdout:

```json
{
  "status": "success | error | blocked",
  "action": "Human-readable next step",
  "data": { ... },
  "error": null
}
```

## Safety Guardrails (enforced in code)

| Guardrail | Limit | Enforcement |
|-----------|-------|-------------|
| Max slippage | 15% | Hard error `SLIPPAGE_LIMIT` |
| Max amount | 1,000,000 (any token) | Hard error `AMOUNT_LIMIT` |
| Confirmation gate | Always | `blocked` without `--confirm` |
| Balance check | Pre-execution | Error `INSUFFICIENT_BALANCE` |
| Route validation | At `set` time | Error `NO_ROUTE` if pair unsupported |
| Order expiry | Configurable (default 7d) | Auto-expired on `run` |
| Max active orders | 20 | Error `ORDER_LIMIT` |
| Post-condition mode | Deny | Enforced on every broadcast |
| Dry-run mode | `AIBTC_DRY_RUN=1` | Simulates without broadcasting |

## Environment Variables

| Variable | Description |
|----------|-------------|
| `AIBTC_WALLET_PASSWORD` | Wallet password (preferred over `--wallet-password`) |
| `STACKS_PRIVATE_KEY` | Direct private key for testing (bypasses wallet file) |
| `AIBTC_DRY_RUN=1` | Simulate all writes — no transactions broadcast |

## State Files

Orders stored at `~/.aibtc/stop-loss/<order-id>.json`. Contains full config, last N price samples, and execution log.

## Known Constraints

- Mainnet only
- Requires funded wallet (STX for gas + token-in for the sell)
- Bitflow API must be reachable
- Not all token pairs have routes — `set` validates before saving
- Price sampling uses a 1-unit quote for efficiency — actual execution price may differ slightly for large orders
