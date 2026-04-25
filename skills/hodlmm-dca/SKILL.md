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

## Commands

### `doctor`

Verify wallet configuration, HODLMM API access, and available pools.

```bash
bun run hodlmm-dca/hodlmm-dca.ts doctor
```

### `setup`

Configure a DCA plan.

```bash
bun run hodlmm-dca/hodlmm-dca.ts setup \
  --pool dlmm_1 \
  --stx-per-run 10 \
  --interval-hours 24 \
  --bin-spread 3 \
  --slippage 1
```

| Flag | Required | Default | Description |
|------|----------|---------|-------------|
| `--pool` | Yes | — | HODLMM pool ID (e.g. `dlmm_1`) |
| `--stx-per-run` | Yes | — | STX to swap per DCA run (max 500) |
| `--interval-hours` | Yes | — | Minimum hours between runs (min 1) |
| `--bin-spread` | No | 3 | Bins each side of active for LP deploy (max 5) |
| `--slippage` | No | 1 | Max swap slippage % (max 5) |
| `--max-runs` | No | unlimited | Optional cap on total DCA runs |

### `run`

Check frequency gate and execute DCA if due.

```bash
# Dry-run (no on-chain execution)
bun run hodlmm-dca/hodlmm-dca.ts run

# Execute on-chain
bun run hodlmm-dca/hodlmm-dca.ts run --confirm
```

### `status`

Show current plan and progress.

```bash
bun run hodlmm-dca/hodlmm-dca.ts status
```

### `history`

List all DCA entries.

```bash
bun run hodlmm-dca/hodlmm-dca.ts history --limit 20
```

### `cancel`

Cancel the active DCA plan.

```bash
bun run hodlmm-dca/hodlmm-dca.ts cancel
```

## Safety notes

| Guard | Value | Configurable |
|-------|-------|-------------|
| Max STX per run | 500 STX | No (hardcoded) |
| Max total per plan | 10,000 STX | No (hardcoded) |
| Min interval between runs | 1 hour | No (hardcoded) |
| Max slippage | 5% | Via `--slippage` (max 5%) |
| Max bin spread | ±5 bins from active | Via `--bin-spread` (max 5) |
| Confirmation gate | `--confirm` required | Always enforced |
| Balance check | Before every execution | Always enforced |
| Consecutive failure limit | 3 — auto-pauses plan | Always enforced |

**Refusal conditions (hardcoded):**
- Refuses `run` if frequency gate is closed
- Refuses `run` if STX balance < `stx_per_run + 0.1 STX` gas buffer
- Refuses `setup` if `stx_per_run` > 500 STX
- Refuses `run` if total deployed would exceed 10,000 STX
- Refuses execution without `--confirm` flag
- Refuses if HODLMM API is unreachable

## Output contract

All output is JSON to stdout. Logs go to stderr.

```json
// setup — plan created
{ "status": "success", "action": "setup", "data": { "plan": { "pool_id": "dlmm_1", "stx_per_run": 10, "interval_hours": 24 }, "pool": { "pair": "STX/sBTC", "activeBin": 284 } }, "error": null }

// run --confirm — DCA executed
{ "status": "success", "action": "run", "data": { "dryRun": false, "entry": { "stx_amount": 10, "tx_id": "0xabc...", "active_bin": 284, "mcp_deposit_cmd": "bitflow_hodlmm_add_liquidity\npool_id: \"dlmm_1\"\nbins: [...]" } }, "error": null }

// run — not due yet
{ "status": "blocked", "action": "run", "data": { "minutesUntilDue": 42 }, "error": "Not due yet — 42m remaining" }

// status
{ "status": "success", "action": "status", "data": { "plan": { "status": "active", "run_count": 3, "total_deployed": 30 }, "stats": { "is_due": false, "minutes_until_due": 1380 } }, "error": null }
```

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
