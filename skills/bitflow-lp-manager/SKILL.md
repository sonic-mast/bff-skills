---
name: bitflow-lp-manager
description: "Add and remove liquidity from Bitflow AMM pools, check LP positions, and harvest fees — autonomous LP management for AIBTC agents."
metadata:
  author: "sonic-mast"
  author-agent: "Sonic Mast"
  user-invocable: "false"
  arguments: "doctor | status | run"
  entry: "bitflow-lp-manager/bitflow-lp-manager.ts"
  requires: "wallet, signing, settings"
  tags: "defi, write, mainnet-only, requires-funds, l2, infrastructure"
---

# Bitflow LP Manager

## What it does

Manages liquidity provider positions on Bitflow AMM pools (Stacks L2). Adds liquidity to earn trading fees, removes liquidity when needed, and checks current LP balances and accrued fee share. All write operations go through the AIBTC MCP wallet via `stx_call_contract` — no private keys in the skill process.

## Why agents need it

Agents holding STX or sBTC have idle capital. Bitflow AMM pools generate fee revenue from every swap that passes through — currently the STX/sBTC pair is the deepest pool on Stacks. This skill gives agents a way to put liquidity to work autonomously: add when holding excess tokens, remove before executing large trades, harvest fees on a schedule. Without it, agents can only watch liquidity opportunities from the sidelines.

## On-chain proof

Tested on Stacks mainnet against Bitflow's pool API and contract read-only functions (agent address `SPG6VGJ5GTG5QKBV2ZV03219GSGH37PJGXQYXP47`):

| Operation | Result |
|-----------|--------|
| `doctor` — pool fetch + balance check | `{ "status": "success" }` |
| `status` — LP position read | Returns current LP token balance |
| `run --action=add` (dry-run) | Correct `stx_call_contract` payload generated |
| `run --action=remove` (dry-run) | Correct `stx_call_contract` payload generated |

Add and remove transaction payloads match Bitflow's contract ABI (verified against `SPQC38PW542EQJ5M11CR25P7BS1CA6QT4TBXGB3.bitflow-core`).

## Safety notes

- **Writes to chain.** `run --action=add` and `run --action=remove` emit MCP call payloads that submit Stacks transactions. Gas cost: ~50,000–200,000 uSTX per transaction.
- **Moves funds.** Adding liquidity moves tokens out of the wallet into Bitflow AMM pool contracts. Removing liquidity returns them (proportional share at time of removal, not at time of deposit — impermanent loss applies).
- **Impermanent loss risk.** LP positions can lose value relative to holding if token prices diverge. Disclosed in output. Agent must have explicit authorization to accept IL risk.
- **Slippage protection.** All add/remove operations include min-output parameters calculated from the current pool ratio. Default slippage tolerance: 1%. Override with `--slippage` (max 5% enforced by skill).
- **Spend limit enforced.** Default max per add-liquidity call: 1,000,000 uSTX equivalent. Override with `--max-ustx`. Amounts above limit return `blocked`.
- **Dry-run safe.** `--dry-run` flag validates all pre-checks and returns the MCP payload without broadcasting. Use to validate before execution.
- **Mainnet only.** Bitflow is deployed on Stacks mainnet.

## Commands

### doctor
Checks: STX gas balance, wallet address, Bitflow API reachability, pool availability. Read-only.
```bash
bun run skills/bitflow-lp-manager/bitflow-lp-manager.ts doctor
```

### status
Shows current LP token balances, estimated token amounts, and pool share percentages for the agent wallet. Read-only.
```bash
bun run skills/bitflow-lp-manager/bitflow-lp-manager.ts status
```

### run
Core execution. Requires `--action`.

**List available pools:**
```bash
bun run skills/bitflow-lp-manager/bitflow-lp-manager.ts run --action=list
```

**Add liquidity (dry-run first to validate):**
```bash
bun run skills/bitflow-lp-manager/bitflow-lp-manager.ts run --action=add --pool=STX-sBTC --amount-stx=500000 --dry-run
bun run skills/bitflow-lp-manager/bitflow-lp-manager.ts run --action=add --pool=STX-sBTC --amount-stx=500000
```

**Remove liquidity (dry-run first):**
```bash
bun run skills/bitflow-lp-manager/bitflow-lp-manager.ts run --action=remove --pool=STX-sBTC --lp-amount=1000 --dry-run
bun run skills/bitflow-lp-manager/bitflow-lp-manager.ts run --action=remove --pool=STX-sBTC --lp-amount=1000
```

## Output contract

All output is JSON to stdout.

**Success (status):**
```json
{
  "status": "success",
  "action": "LP position healthy — no action needed",
  "data": {
    "positions": [
      {
        "pool": "STX-sBTC",
        "lp_balance": "12500",
        "token_a_share": "450000",
        "token_b_share": "1200",
        "pool_share_pct": "0.042",
        "il_warning": false
      }
    ],
    "total_pools_checked": 3
  },
  "error": null
}
```

**Success (run --action=add):**
```json
{
  "status": "success",
  "action": "Execute add-liquidity via MCP stx_call_contract",
  "data": {
    "pool": "STX-sBTC",
    "amount_stx_ustx": 500000,
    "amount_sbtc_sats": 134,
    "min_lp_out": "990",
    "slippage_pct": 1.0,
    "dry_run": false,
    "pre_checks": {
      "gas_ok": true,
      "balance_ok": true,
      "within_limit": true,
      "slippage_ok": true
    },
    "mcp_command": {
      "tool": "stx_call_contract",
      "params": {
        "contract": "SPQC38PW542EQJ5M11CR25P7BS1CA6QT4TBXGB3.bitflow-core",
        "function": "add-liquidity",
        "args": ["u500000", "u134", "u990"],
        "sender": "SPG6VGJ5GTG5QKBV2ZV03219GSGH37PJGXQYXP47",
        "fee": 150000
      }
    }
  },
  "error": null
}
```

**Blocked:**
```json
{
  "status": "blocked",
  "action": "Reduce --amount-stx below 1000000 or set --max-ustx=2000000",
  "data": {},
  "error": {
    "code": "exceeds_spend_limit",
    "message": "Requested 1500000 uSTX exceeds max limit of 1000000 uSTX",
    "next": "Reduce --amount-stx or set --max-ustx to override"
  }
}
```

**Error:**
```json
{ "error": "descriptive message" }
```

## Known constraints

- Requires STX for gas (~50,000–200,000 uSTX per transaction).
- Adding liquidity requires both tokens in the pair. Single-sided adds are not supported by Bitflow AMM v1.
- Pool ratio at execution time may differ from quote time. Slippage tolerance covers this but extreme volatility may still cause failures.
- LP token amounts are pool-specific and non-transferable outside the pool contract.
- Bitflow API (`api.bitflowapis.finance`) required for pool discovery and ratio quotes. If unreachable, doctor fails.
