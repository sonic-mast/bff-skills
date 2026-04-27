---
name: hodlmm-compound
description: "Autocompound a HODLMM DLMM position: withdraw all liquidity, rebalance token ratio via Bitflow swap, then re-add balanced liquidity to the active bin range."
metadata:
  author: "sonic-mast"
  author-agent: "Sonic Mast"
  user-invocable: "false"
  arguments: "doctor | scan [--pool <slug>] | run --pool <slug> [--confirm] | auto [--pool <slug>]"
  entry: "hodlmm-compound/hodlmm-compound.ts"
  requires: "wallet, signing, settings"
  tags: "defi, write, mainnet-only, requires-funds, hodlmm, bitflow"
---

# HODLMM Compound

## What it does

Autocompounds a Bitflow HODLMM DLMM liquidity position. On each compound cycle it:
1. Withdraws all liquidity from the current position bins
2. Calculates the resulting token imbalance (drift from 50/50 after fees and price movement)
3. Executes a Bitflow swap to restore the target token ratio
4. Re-adds the fully balanced liquidity centered on the current active bin

Unlike `hodlmm-move-liquidity` which relocates bins without touching token balances, this skill realizes any accumulated fee value and resets the position to optimal deployment for the current price.

## Why agents need it

HODLMM positions drift in two ways: the active bin moves (addressed by hodlmm-move-liquidity) and the token ratio becomes lopsided as one token accumulates in out-of-range bins. A compound cycle corrects both simultaneously, maximizing effective LP fee capture on the next epoch.

## Safety notes

- **Writes to chain**: withdraws liquidity, executes a Bitflow swap, re-adds liquidity — three separate transactions.
- **Requires `--confirm`** on `run` and `auto`; without it, returns a dry-run preview with exact amounts.
- **Mainnet only**: HODLMM pools and Bitflow swap routes are mainnet contracts.
- **Minimum position guard**: refuses to compound if the position value is below the configured minimum (default 100 STX equivalent) to avoid wasting fees on dust.
- **Cooldown**: 4-hour minimum between compound cycles per pool.
- **Post-condition mode `deny`** on all transactions — wallet transfer amounts are bounded.

## Commands

### doctor
Checks environment, wallet connectivity, Bitflow API reachability, and pool access.
```bash
bun run skills/hodlmm-compound/hodlmm-compound.ts doctor
```

### scan
Lists your HODLMM positions, current bin range, active-bin drift, and estimated token imbalance. Read-only.
```bash
bun run skills/hodlmm-compound/hodlmm-compound.ts scan
bun run skills/hodlmm-compound/hodlmm-compound.ts scan --pool stx-sbtc
```

### run
Executes one compound cycle. Without `--confirm`, returns a dry-run with all amounts and the swap quote before touching the chain.
```bash
bun run skills/hodlmm-compound/hodlmm-compound.ts run --pool stx-sbtc
bun run skills/hodlmm-compound/hodlmm-compound.ts run --pool stx-sbtc --confirm
```

### auto
Autonomous compound loop. Checks each configured pool every 4 hours and executes a compound cycle when the position imbalance exceeds the threshold (default: >10% imbalance OR >20 bins drift).
```bash
bun run skills/hodlmm-compound/hodlmm-compound.ts auto
bun run skills/hodlmm-compound/hodlmm-compound.ts auto --pool stx-sbtc
```

## Output contract

All commands emit JSON to stdout.

**Success:**
```json
{
  "status": "success",
  "action": "compound",
  "data": {
    "pool": "stx-sbtc",
    "withdrawTxId": "0x...",
    "swapTxId": "0x...",
    "addTxId": "0x...",
    "tokenXBefore": "1000000000",
    "tokenYBefore": "5000000",
    "tokenXAfter": "950000000",
    "tokenYAfter": "4750000",
    "activeBin": 512
  },
  "error": null
}
```

**Dry-run (no --confirm):**
```json
{
  "status": "blocked",
  "action": "compound-dry-run",
  "data": {
    "pool": "stx-sbtc",
    "currentBins": [498, 503, 508],
    "activeBin": 512,
    "drift": 9,
    "estimatedTokenX": "1000000000",
    "estimatedTokenY": "3200000",
    "swapNeeded": { "from": "tokenX", "amount": "200000000" },
    "swapQuote": { "amountOut": "1000000", "priceImpact": 0.12 }
  },
  "error": null
}
```

**Error:**
```json
{ "error": "descriptive message" }
```

## Known constraints

- Requires STX and sBTC in the wallet to cover swap and redeposit slippage
- Each compound cycle requires three separate transactions (withdraw, swap, add)
- Pool slug must match the Bitflow API `pool_id` field (e.g. `stx-sbtc`)
- Max slippage on swap is 5% (hard-coded); abort if quote exceeds this
