---
name: alex-swap
description: "Execute token swaps on ALEX DEX (Stacks L2) with live quotes, multi-hop routing, slippage protection, and autonomous spend limits. Supports STX, USDA, sUSDT, wBTC, ALEX token, and all ALEX-listed pairs."
metadata:
  author: "sonic-mast"
  author-agent: "Sonic Mast"
  user-invocable: "false"
  arguments: "doctor | install-packs | tokens | quote | run"
  entry: "alex-swap/alex-swap.ts"
  requires: "wallet, signing"
  tags: "defi, write, mainnet-only, requires-funds, l2, dex, alex"
---

# alex-swap — ALEX DEX Token Swaps

Execute token swaps on [ALEX](https://app.alexlab.co) — the second-largest DEX on Stacks — with live quotes, multi-hop routing, and autonomous safety controls.

## How It Works

1. `quote` fetches a live price from the ALEX DEX via `alex-sdk`
2. `run` (without `--confirm`) shows the quote and blocks
3. `run --confirm` executes the swap via `swap-helper-v1-03` on Stacks mainnet
4. Result includes tx hash, explorer link, and Telegram-friendly summary

## Quick Start

```bash
# 1. Install dependencies
bun run alex-swap/alex-swap.ts install-packs

# 2. Health check
bun run alex-swap/alex-swap.ts doctor

# 3. List supported tokens
bun run alex-swap/alex-swap.ts tokens

# 4. Get a quote
bun run alex-swap/alex-swap.ts quote --token-in STX --token-out USDA --amount 100

# 5. Execute a swap (preview first)
bun run alex-swap/alex-swap.ts run --token-in STX --token-out USDA --amount 100

# 6. Confirm and execute
export AIBTC_WALLET_PASSWORD="your-password"
bun run alex-swap/alex-swap.ts run --token-in STX --token-out USDA --amount 100 --confirm
```

## Commands

### `doctor`
System health check — verifies wallet, Stacks API, alex-sdk, and `swap-helper-v1-03` contract on mainnet.

### `install-packs`
One-time setup: `bun add alex-sdk @stacks/transactions @stacks/network @stacks/wallet-sdk @stacks/encryption commander`

### `tokens`
List all tokens swappable on ALEX DEX via the live SDK token registry.

### `quote --token-in <symbol> --token-out <symbol> --amount <number>`
Get a live price quote for a swap. Read-only — no transaction required.

### `run` Options

| Flag | Required | Description |
|------|----------|-------------|
| `--token-in` | ✅ | Input token symbol (e.g. `STX`, `USDA`, `WBTC`) |
| `--token-out` | ✅ | Output token symbol |
| `--amount` | ✅ | Amount in human-readable units (e.g. `100` = 100 STX) |
| `--slippage` | ❌ | Max slippage % (default `2`, max `5`) |
| `--confirm` | ❌ | Authorize swap execution (required to write) |
| `--wallet-password` | ❌ | Fallback for `AIBTC_WALLET_PASSWORD` env var |

## Supported Tokens (built-in aliases)

| Alias | ALEX Token ID |
|-------|--------------|
| `STX` | `token-wstx` |
| `USDA` | `token-usda` |
| `USDT` / `SUSDT` | `token-susdt` |
| `WBTC` / `BTC` | `token-wbtc` |
| `ALEX` | `age000-governance-token` |
| `SBTC` | `token-sbtc` |
| `XBTC` | `token-xbtc` |
| `DIKO` | `arkadiko-token` |

## On-Chain Contracts (verified on mainnet)

| Contract | Address |
|----------|---------|
| `swap-helper-v1-03` | `SP3K8BC0PPEVCV7NZ6QSRWPQ2JE9E5B6N3PA0KBR9` |
| `amm-swap-pool-v1-1` | `SP3K8BC0PPEVCV7NZ6QSRWPQ2JE9E5B6N3PA0KBR9` |

## Output Format

```json
{
  "status": "success | error | blocked",
  "action": "Human-readable next step",
  "data": {
    "txid": "0x...",
    "explorer": "https://explorer.hiro.so/txid/...",
    "token_in": "STX",
    "token_out": "USDA",
    "amount_in": 100,
    "min_out": 98.5,
    "slippage": 2,
    "telegram": "✅ Swap summary..."
  },
  "error": null
}
```

## Safety Controls (enforced in code)

| Control | Limit | Enforcement |
|---------|-------|-------------|
| Max slippage | 5% | Hard error `SLIPPAGE_LIMIT` |
| Autonomous swap cap | 10,000 STX | Hard error `SPEND_LIMIT` |
| Gas reserve | 0.05 STX min | Error `INSUFFICIENT_GAS` |
| STX balance check | Before execution | Error `INSUFFICIENT_BALANCE` |
| Confirmation gate | Always | `blocked` without `--confirm` |
| Post-condition mode | `deny` | Reject tx if conditions unmet |
| Private key exposure | Never | Zero-exposure in all output |

## Environment Variables

| Variable | Description |
|----------|-------------|
| `AIBTC_WALLET_PASSWORD` | Wallet password (preferred over `--wallet-password`) |
| `STACKS_PRIVATE_KEY` | Direct private key for testing |

## Wallet Support

Three sources (checked in order):
1. `STACKS_PRIVATE_KEY` env var (testing only)
2. AIBTC MCP wallet (`~/.aibtc/wallets.json` — AES-256-GCM + scrypt)
3. Legacy `~/.aibtc/wallet.json`

## Known Constraints

- Mainnet only
- Requires funded wallet (STX for gas + input token)
- ALEX SDK must be installed (`install-packs`)
- Token routing depends on ALEX AMM liquidity
