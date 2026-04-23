---
name: alex-dca
description: "Dollar Cost Averaging (DCA) for ALEX DEX on Stacks — automate recurring buys or sells of any supported ALEX token pair. The agent executes each order on schedule: checks frequency gate, fetches a live quote via ALEX SDK, enforces slippage hard limit, verifies STX balance, then broadcasts the swap with postConditionMode deny. Supports any token pair available on ALEX (STX/ALEX, STX/aBTC, ALEX/aBTC, and more). Plan state persisted locally."
metadata:
  author: "sonic-mast"
  author-agent: "Sonic Mast"
  user-invocable: "false"
  arguments: "doctor | install-packs | setup | plan | run | status | cancel | list"
  entry: "alex-dca/alex-dca.ts"
  requires: "wallet"
  tags: "defi, write, mainnet-only, requires-funds, l2"
---

# ALEX DCA — Dollar Cost Averaging on ALEX DEX

Automate recurring token purchases (or sales) on Stacks mainnet via **ALEX DEX**.
The agent executes each order on schedule — no third-party contracts required.

## What it does

Executes recurring token swaps on ALEX DEX at a fixed interval. On each `run` call, the skill checks the frequency gate (hourly/daily/weekly/biweekly), fetches a live quote via the ALEX SDK, enforces a slippage hard limit, verifies the STX balance, and broadcasts the swap with `postConditionMode: deny`. All plan state (config, tx hashes, execution log, avg cost) is persisted locally at `~/.aibtc/alex-dca/<plan-id>.json`.

## Why agents need it

DCA removes timing risk from token accumulation. Agents running treasury management, savings strategies, or scheduled rebalancing can set a plan once and let the skill handle execution autonomously. The frequency gate means it is safe to call on every heartbeat — early calls return `blocked` with time remaining rather than firing early. This makes the skill cron-friendly without requiring external scheduling logic.

## How It Works

1. `setup` creates a local plan file with the full DCA schedule
2. `run` is called by the agent on each schedule tick (via cron or heartbeat)
3. Each `run` checks if an order is due, fetches a live ALEX quote, and returns `blocked` until `--confirm`
4. On confirm: executes the ALEX swap on-chain, logs the tx hash, advances the schedule
5. `status` shows progress: avg entry price, total spent/received, remaining orders

## Quick Start

```bash
# 1. Install dependencies
bun run alex-dca/alex-dca.ts install-packs --pack all

# 2. Health check
bun run alex-dca/alex-dca.ts doctor

# 3. Create a plan: DCA 100 STX into ALEX over 10 daily orders
bun run alex-dca/alex-dca.ts setup \
  --token-in STX --token-out ALEX \
  --total 100 --orders 10 --frequency daily --slippage 3

# 4. Preview the schedule
bun run alex-dca/alex-dca.ts plan --plan <planId>

# 5. Execute next order (--confirm required)
export AIBTC_WALLET_PASSWORD="your-password"
bun run alex-dca/alex-dca.ts run --plan <planId>
# Review the quote, then:
bun run alex-dca/alex-dca.ts run --plan <planId> --confirm

# 6. Monitor progress
bun run alex-dca/alex-dca.ts status --plan <planId>

# 7. Cancel remaining orders
bun run alex-dca/alex-dca.ts cancel --plan <planId>
```

## Commands

### `doctor`
System health check — verifies ALEX API, wallet file, and Stacks mainnet connectivity.

### `install-packs --pack all`
One-time setup: installs required packages.

**Installs:** `@alexgo-io/alex-sdk`, `@stacks/transactions`, `@stacks/network`, `@stacks/wallet-sdk`, `@stacks/encryption`, `commander`, `tslib`

### `setup`

| Flag | Required | Description |
|------|----------|-------------|
| `--token-in` | ✅ | Input token symbol (e.g. `STX`, `ALEX`) |
| `--token-out` | ✅ | Output token symbol (e.g. `ALEX`, `aBTC`) |
| `--total` | ✅ | Total amount in human units (e.g. `100` = 100 STX) |
| `--orders` | ✅ | Number of orders (2..100) |
| `--frequency` | ✅ | `hourly` · `daily` · `weekly` · `biweekly` |
| `--slippage` | ❌ | Slippage % (default `3`, hard max `10`) |
| `--start-delay-hours` | ❌ | Hours before first order (default `0`) |

Validates the token pair against ALEX SDK before saving.

### `plan --plan <id>`
Preview the full DCA schedule with per-order timing and current quote estimates.

### `run --plan <id> [--confirm] [--wallet-password <pw>]`
Execute the next pending order. Cron-friendly — returns `blocked` if called before the next order is due.

- **Without `--confirm`**: Returns live quote preview. Safe to inspect.
- **With `--confirm`**: Executes the ALEX swap on-chain, logs tx hash, advances schedule.

> **Security:** Prefer `AIBTC_WALLET_PASSWORD` env var over `--wallet-password` flag.

### `status --plan <id>` / `status --all`
Progress: orders complete, total spent, total received, avg entry price, next order ETA.

### `cancel --plan <id>`
Cancel a plan. Stops all future `run` calls for this plan.

### `list`
List all local ALEX DCA plan files with status.

## Supported Token Pairs

Any pair available on ALEX DEX. Common pairs:
- `STX → ALEX`
- `STX → aBTC`
- `ALEX → aBTC`
- `STX → sUSDT`

The `setup` command validates the pair against live ALEX routes before saving.

## Token Amounts

Pass `--total` in **human-readable units** (not microunits):

| Token | Decimals | Example |
|-------|----------|---------|
| STX | 6 | `--total 100` = 100 STX |
| ALEX | 8 | `--total 1000` = 1000 ALEX |
| aBTC | 8 | `--total 0.001` = 0.001 aBTC |

## Safety notes

All guardrails are enforced in code — not doc-only.

| Guardrail | Limit | Enforcement |
|-----------|-------|-------------|
| Max slippage | 10% | Hard error `SLIPPAGE_LIMIT` |
| Max orders | 100 | Hard error `ORDERS_LIMIT` |
| Min order size | > 0 | Hard error `ORDER_TOO_SMALL` |
| Spend confirmation | Always | `blocked` without `--confirm` |
| Frequency enforcement | Per-plan | `blocked` if called too early |
| STX balance check | Pre-execution | Error `INSUFFICIENT_BALANCE` |
| postConditionMode | deny | Enforced on every swap tx |
| Private key exposure | Never | Zero exposure in all output |
| Dry run mode | `AIBTC_DRY_RUN=1` | Simulates without broadcasting |

## Output contract

All commands emit strict JSON to stdout:

```json
{
  "status": "success | error | blocked",
  "action": "Human-readable next step",
  "data": {
    "telegram": "📊 Emoji-rich Telegram-friendly summary",
    "...": "command-specific fields"
  },
  "error": {
    "code": "ERROR_CODE",
    "message": "...",
    "next": "suggested action"
  } | null
}
```

`blocked` status means the skill is waiting for operator input (e.g. `--confirm` not provided, frequency gate not elapsed). `error` status means execution failed. `success` means the action completed.

## State Files

Plans stored at `~/.aibtc/alex-dca/<plan-id>.json`. Contains full plan config, every tx hash, per-order execution log, and running avg cost.

## Environment Variables

| Variable | Description |
|----------|-------------|
| `AIBTC_WALLET_PASSWORD` | Wallet password (alternative to `--wallet-password`) |
| `STACKS_PRIVATE_KEY` | Direct private key for testing (bypasses wallet file) |
| `AIBTC_DRY_RUN=1` | Simulate all writes — no transactions broadcast |
