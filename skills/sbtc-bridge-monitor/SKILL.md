---
name: sbtc-bridge-monitor
description: "Monitors sBTC bridge operations, tracks deposit and withdrawal status, and alerts on delays or failures."
metadata:
  author: "sonic-mast"
  author-agent: "Sonic Mast"
  user-invocable: "false"
  arguments: "doctor | status <txid> [--type deposit|withdrawal] | run [--watch] [--alert-delay-minutes]"
  entry: "sbtc-bridge-monitor/sbtc-bridge-monitor.ts"
  requires: ""
  tags: "infrastructure, read-only"
---

# sBTC Bridge Monitor

## What it does

Monitors sBTC bridge operations between Bitcoin L1 and Stacks L2. Tracks deposit and withdrawal status, detects delays and failures, and provides actionable alerts for stuck or failed bridge transactions.

Read-only monitoring. Wallet required only for checking deposits/withdrawals tied to your address. Safe for autonomous monitoring.

## Why agents need it

When agents move value between Bitcoin and Stacks via sBTC bridge, they need reliable status tracking. This skill enables:

- **Proactive monitoring:** Detect stuck deposits/withdrawals before users notice
- **Alert generation:** Flag delays exceeding expected confirmation times
- **Status transparency:** Clear transaction lifecycle visibility
- **Recovery guidance:** Actionable next steps when transactions fail

Critical for agents managing liquidity, executing cross-chain strategies, or providing bridge infrastructure services.

## Safety notes

- **Read-only:** No chain writes, no bridge operations triggered
- **Wallet context:** Uses wallet address for filtering your transactions only
- **No rate limits:** Reasonable polling intervals built-in
- **No PII:** Only processes public on-chain transaction data

## Runtime requirements

⚠️ **MCP Runtime Required**: This skill requires an MCP-aware execution environment (e.g., Claude with aibtc-mcp server). It depends on MCP tools:
- `sbtc_deposit_status` - Check BTC→sBTC deposit status
- `sbtc_withdrawal_status` - Check sBTC→BTC withdrawal status
- `get_stx_balance` - Verify address has activity

**Local testing:** Set `BFF_TEST_MODE=true` to use simulated data.

**Production:** Must be executed by an agent with access to sBTC bridge MCP tools.

## Commands

### doctor

Checks environment and MCP server connectivity. Validates sBTC bridge tool availability.

```bash
bun run sbtc-bridge-monitor/sbtc-bridge-monitor.ts doctor
```

**Returns:**
```json
{
  "status": "ok",
  "tools_required": ["sbtc_deposit_status", "sbtc_withdrawal_status"],
  "network": "mainnet",
  "test_mode": false,
  "note": "This skill requires MCP runtime with sBTC bridge tools"
}
```

### status

Check status of a specific sBTC bridge transaction. Auto-detects type or specify via --type flag.

```bash
bun run sbtc-bridge-monitor/sbtc-bridge-monitor.ts status <txid> [--type deposit|withdrawal]
```

**Example (deposit):**
```bash
bun run sbtc-bridge-monitor/sbtc-bridge-monitor.ts status abc123...def --type deposit
```

**Returns:**
```json
{
  "status": "ok",
  "action": "status",
  "data": {
    "txid": "abc123...def",
    "type": "deposit",
    "state": "confirmed",
    "amount": 100000,
    "confirmations": 6,
    "age_minutes": 45,
    "alert": null
  }
}
```

**Example (withdrawal):**
```bash
bun run sbtc-bridge-monitor/sbtc-bridge-monitor.ts status 0x456...789 --type withdrawal
```

**Returns:**
```json
{
  "status": "ok",
  "action": "status",
  "data": {
    "txid": "0x456...789",
    "type": "withdrawal",
    "state": "pending",
    "amount": 50000,
    "requestId": 123,
    "age_minutes": 180,
    "alert": {
      "severity": "warning",
      "message": "Withdrawal pending for 3 hours - signers may be delayed"
    }
  }
}
```

### run

Monitor recent bridge activity for the wallet's address. Optionally watch continuously with alerts.

```bash
bun run sbtc-bridge-monitor/sbtc-bridge-monitor.ts run [--watch] [--alert-delay-minutes <minutes>]
```

**Options:**
- `--watch`: Continuous monitoring mode (polls every 5 minutes)
- `--alert-delay-minutes`: Trigger alerts after this many minutes (default: 60 for deposits, 120 for withdrawals)

**Example (single check):**
```bash
bun run sbtc-bridge-monitor/sbtc-bridge-monitor.ts run
```

**Returns:**
```json
{
  "status": "ok",
  "action": "run",
  "data": {
    "deposits": {
      "total": 3,
      "pending": 1,
      "confirmed": 2,
      "failed": 0
    },
    "withdrawals": {
      "total": 2,
      "pending": 0,
      "completed": 2,
      "failed": 0
    },
    "alerts": [
      {
        "txid": "abc123...def",
        "type": "deposit",
        "severity": "warning",
        "message": "Deposit pending for 75 minutes - exceeds expected confirmation time"
      }
    ]
  }
}
```

**Example (watch mode):**
```bash
bun run sbtc-bridge-monitor/sbtc-bridge-monitor.ts run --watch --alert-delay-minutes 90
```

In watch mode, polls every 5 minutes and outputs alerts immediately when detected. Use SIGINT (Ctrl+C) to stop.

## Output contract

All commands output JSON to stdout:

**Success:**
```json
{
  "status": "ok",
  "action": "doctor|status|run",
  "data": { ... }
}
```

**Error:**
```json
{
  "error": "descriptive error message",
  "details": { ... }
}
```

## Alert thresholds

**Deposits (BTC→sBTC):**
- Normal: 0-60 minutes (6 BTC confirmations)
- Warning: 60-120 minutes
- Critical: >120 minutes

**Withdrawals (sBTC→BTC):**
- Normal: 0-120 minutes (signer processing)
- Warning: 120-240 minutes
- Critical: >240 minutes

## Implementation notes

- Uses MCP `sbtc_deposit_status` and `sbtc_withdrawal_status` tools
- Fetches transaction history via Stacks API for wallet's address
- Monitors only sBTC-related transactions (deposits, withdrawals, transfers)
- Watch mode uses 5-minute poll intervals to respect API rate limits
- Alert severity: info < warning < critical
- Returns exit code 0 for success, 1 for alerts triggered, 2 for errors
