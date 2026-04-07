---
name: bitflow-spot-swap
description: "Execute a single on-demand token swap on Bitflow DEX with live quote preview, slippage protection, and mandatory confirmation gate."
metadata:
  author: "sonic-mast"
  author-agent: "Sonic Mast"
  user-invocable: "false"
  arguments: "doctor | install-packs | quote | swap"
  entry: "bitflow-spot-swap/bitflow-spot-swap.ts"
  requires: "wallet, signing"
  tags: "defi, write, mainnet-only, requires-funds, l2"
---

# Bitflow Spot Swap

Execute a single on-demand token swap on Bitflow DEX via the official `@bitflowlabs/core-sdk`. Live quote preview before any funds move. Mandatory `--confirm` gate prevents accidental execution.

The fundamental DeFi primitive: swap any supported Bitflow token pair atomically in one transaction. Designed for agents that need to trade once on a signal — not on a schedule.

## What it does

1. `quote` fetches a live route from Bitflow and returns expected output, price impact, and minimum received
2. `swap` without `--confirm` returns the same quote as `blocked` — safe to inspect
3. `swap --confirm` executes the swap on-chain, returns tx hash and explorer link
4. All amounts in human-readable units (STX not uSTX, sBTC not sats)

## Why agents need it

Agents responding to market signals need to execute token swaps without manual intervention. This skill provides a safe, auditable swap primitive with hardcoded slippage limits, gas reserve enforcement, and a mandatory confirmation gate — so agents can act on-chain without risking runaway spend.

## Quick Start

```bash
# 1. Install dependencies
bun run bitflow-spot-swap/bitflow-spot-swap.ts install-packs

# 2. Health check
bun run bitflow-spot-swap/bitflow-spot-swap.ts doctor

# 3. Get a live quote (no funds moved)
bun run bitflow-spot-swap/bitflow-spot-swap.ts quote \
  --token-in STX --token-out sBTC --amount 10

# 4. Execute the swap (preview first — returns blocked without --confirm)
export AIBTC_WALLET_PASSWORD="your-password"
bun run bitflow-spot-swap/bitflow-spot-swap.ts swap \
  --token-in STX --token-out sBTC --amount 10 --slippage 3

# 5. Confirm execution
bun run bitflow-spot-swap/bitflow-spot-swap.ts swap \
  --token-in STX --token-out sBTC --amount 10 --slippage 3 --confirm
```

## Commands

### `doctor`
Checks: Bitflow API reachable, Stacks mainnet reachable, wallet file present, STX balance readable.

### `install-packs`
One-time setup: installs `@bitflowlabs/core-sdk`, `@stacks/transactions`, `@stacks/network`, `@stacks/wallet-sdk`, `@stacks/encryption`, `commander`.

### `quote --token-in <symbol> --token-out <symbol> --amount <number>`
Fetch a live swap quote. Returns expected output, price impact, and minimum received at default 1% slippage. No funds move. No confirmation required.

| Flag | Required | Description |
|------|----------|-------------|
| `--token-in` | Yes | Input token symbol (`STX`, `sBTC`, `WELSH`, `ALEX`, etc.) |
| `--token-out` | Yes | Output token symbol |
| `--amount` | Yes | Amount in human units (e.g. `10` = 10 STX) |

### `swap --token-in <symbol> --token-out <symbol> --amount <number> [--slippage <pct>] [--confirm]`
Execute a swap. Without `--confirm`, returns live quote as `blocked`. With `--confirm`, broadcasts the transaction.

| Flag | Required | Description |
|------|----------|-------------|
| `--token-in` | Yes | Input token symbol |
| `--token-out` | Yes | Output token symbol |
| `--amount` | Yes | Amount in human units |
| `--slippage` | No | Max slippage % (default `1`, hard max `5`) |
| `--confirm` | No | Required to execute — omit to preview |
| `--wallet-password` | No | Fallback (prefer `AIBTC_WALLET_PASSWORD` env var) |

## Safety notes

| Guardrail | Limit | Enforcement |
|-----------|-------|-------------|
| Max slippage | 5% | Hard error `SLIPPAGE_LIMIT` |
| Confirmation gate | Always | `blocked` status without `--confirm` |
| Balance check | Pre-execution | Error `INSUFFICIENT_BALANCE` |
| Minimum STX reserve | 500,000 uSTX (0.5 STX) | Error `INSUFFICIENT_GAS_RESERVE` |
| Network | Mainnet only | Hard-coded `STACKS_MAINNET` |
| Private key exposure | Never | Zero-exposure in all output |
| Token decimals | SDK-enforced | Returns error if SDK provides no decimal metadata |

## Token Amounts

Pass `--amount` in human-readable units:

| Token | Example | Meaning |
|-------|---------|---------|
| STX | `--amount 10` | 10 STX (= 10,000,000 uSTX) |
| sBTC | `--amount 0.001` | 0.001 sBTC (= 100,000 sats) |
| WELSH | `--amount 500` | 500 WELSH |

## Output contract

All commands emit strict JSON to stdout:

```json
{
  "status": "success | error | blocked",
  "action": "Human-readable next step",
  "data": {
    "tokenIn": "STX",
    "tokenOut": "sBTC",
    "amountIn": 10,
    "amountOut": 0.0000343,
    "priceImpactPct": 0.12,
    "minimumReceived": 0.0000340,
    "txId": "0x...",
    "explorerUrl": "https://explorer.hiro.so/txid/0x..."
  },
  "error": null
}
```

Error format:

```json
{
  "status": "error",
  "action": "Check error and retry",
  "data": {},
  "error": {
    "code": "SLIPPAGE_LIMIT",
    "message": "Slippage 6% exceeds hard limit of 5%",
    "next": "Reduce --slippage to ≤ 5"
  }
}
```

## Environment Variables

| Variable | Description |
|----------|-------------|
| `AIBTC_WALLET_PASSWORD` | Wallet password (preferred over `--wallet-password` flag) |
| `STACKS_PRIVATE_KEY` | Direct private key for testing only |
| `AIBTC_DRY_RUN=1` | Simulate — no transaction broadcast |

## HODLMM Integration

Bitflow's SDK automatically routes through HODLMM pools when they offer better rates. Use `quote` first to see which route is selected. The `data.routeDescription` field shows whether the route passes through a HODLMM DLMM pool.

## Wallet Support

Three sources checked in order:
1. `STACKS_PRIVATE_KEY` env var (testing only)
2. AIBTC MCP wallet (`~/.aibtc/wallets.json` + keystore)
3. Legacy `~/.aibtc/wallet.json`
