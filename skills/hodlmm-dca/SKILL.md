---
name: hodlmm-dca
description: "Dollar Cost Averaging directly into Bitflow HODLMM DLMM pools — each run swaps a fixed STX amount at the current active-bin price and outputs a ready-to-execute add-liquidity command to deploy accumulated tokens into HODLMM LP positions."
metadata:
  author: "sonic-mast"
  author-agent: "Sonic Mast"
  user-invocable: "false"
  arguments: "doctor | install-packs | setup --pool <id> --stx-per-run <N> --interval-hours <N> [--bin-spread <N>] | run [--confirm] [--wallet-password <PW>] | status | history | cancel"
  entry: "hodlmm-dca/hodlmm-dca.ts"
  requires: "wallet, signing, settings"
  tags: "defi, write, mainnet-only, requires-funds, l2, hodlmm"
---

# hodlmm-dca

Recurring DCA into Bitflow HODLMM DLMM pools. Traditional DCA buys tokens at regular intervals; **hodlmm-dca** buys LP positions — each run swaps a fixed STX amount and prepares the tokens for immediate HODLMM LP deployment at the current active bin.

## Why agents need it

- **LP-based DCA beats token DCA**: you earn trading fees from day one, not just price exposure
- **Active bin awareness**: each swap targets the current HODLMM active bin price — no blind market orders
- **Set-and-forget**: configure once, the agent runs on every heartbeat and self-gates by interval
- **HODLMM native**: uses the live Bitflow DLMM pool API for bin state — no external price oracles

## What it does

1. **`setup`** — configure a DCA plan: pool ID, STX amount per run, interval, bin spread
2. **`run`** — check the frequency gate; if due, fetch active bin price from HODLMM API, execute the STX swap via BitflowSDK, output `bitflow_hodlmm_add_liquidity` MCP command to deploy into LP
3. **`status`** — show plan, next run time, accumulated amounts, DLP-ready balance
4. **`history`** — list all DCA entries with bin price, amount swapped, and estimated LP value
5. **`doctor`** — verify wallet, Bitflow API, HODLMM pool access

## Supported pools

Any Bitflow DLMM pool — `dlmm_1` (STX/sBTC) is the default. Use `doctor` to list available pools.

## Examples

```bash
# Verify prerequisites
bun run hodlmm-dca/hodlmm-dca.ts doctor

# Configure: 10 STX per run, every 24 hours, into STX/sBTC pool
bun run hodlmm-dca/hodlmm-dca.ts setup --pool dlmm_1 --stx-per-run 10 --interval-hours 24

# Dry-run: show what would execute
bun run hodlmm-dca/hodlmm-dca.ts run

# Execute on-chain (swaps STX into pool token pair)
bun run hodlmm-dca/hodlmm-dca.ts run --confirm

# Show current plan and progress
bun run hodlmm-dca/hodlmm-dca.ts status

# Full DCA history
bun run hodlmm-dca/hodlmm-dca.ts history

# Cancel the DCA plan
bun run hodlmm-dca/hodlmm-dca.ts cancel
```

## Safety limits (hardcoded — not configurable)

| Limit | Value |
|-------|-------|
| Max STX per run | 500 STX |
| Max total deployed per plan | 10,000 STX |
| Min interval | 1 hour |
| Max slippage | 5% |
| Max bin spread | 11 bins (±5 from active) |
| `--confirm` required | Yes — all write operations |

## Output format

All commands output strict JSON to stdout. Debug to stderr.

```json
{
  "status": "success|blocked|error",
  "action": "run|setup|status|...",
  "data": { ... },
  "error": null
}
```
