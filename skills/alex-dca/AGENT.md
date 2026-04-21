---
name: ALEX DCA
skill: alex-dca
description: "Execute recurring Dollar Cost Averaging (DCA) orders on ALEX DEX (Stacks mainnet). Supports any ALEX token pair: STX/ALEX, STX/aBTC, ALEX/aBTC, and more. Each run checks the frequency gate and executes at most one swap, returning blocked until the schedule window opens."
---

# ALEX DCA

Automates recurring token swaps on ALEX DEX at a fixed schedule. Creates a plan once, then calls `run` on each heartbeat — the skill enforces its own frequency gate.

## When to use

- Accumulating ALEX, aBTC, or other ALEX-listed tokens over time
- Reducing timing risk vs single large swap
- Fully autonomous: no human interaction needed after `setup`

## Commands

```bash
# One-time setup
bun run alex-dca/alex-dca.ts install-packs --pack all
bun run alex-dca/alex-dca.ts doctor

# Create plan (validates pair live before saving)
bun run alex-dca/alex-dca.ts setup \
  --token-in STX --token-out ALEX \
  --total 100 --orders 10 --frequency daily

# Preview schedule
bun run alex-dca/alex-dca.ts plan --plan <planId>

# Execute next order (two steps: preview, then confirm)
bun run alex-dca/alex-dca.ts run --plan <planId>
bun run alex-dca/alex-dca.ts run --plan <planId> --confirm

# Monitor
bun run alex-dca/alex-dca.ts status --plan <planId>
bun run alex-dca/alex-dca.ts status --all

# Cancel remaining orders
bun run alex-dca/alex-dca.ts cancel --plan <planId>

# List all plans
bun run alex-dca/alex-dca.ts list
```

## Safety controls (enforced in code — not doc-only)

- `--confirm` flag required on all writes. Without it, returns `status: "blocked"` with quote preview — funds never move.
- Max slippage hard cap: 10%. Any `--slippage` above 10% throws `SLIPPAGE_LIMIT` error immediately.
- Max 100 orders per plan. Above 100 throws `ORDERS_LIMIT`.
- Frequency gate: `run` returns `blocked` if called before next scheduled window — safe to call from cron every 5 minutes.
- STX balance check before execution when token-in is STX. Returns `INSUFFICIENT_BALANCE` if under-funded.
- `postConditionMode: "deny"` on every swap transaction — aborts if actual output doesn't match post-conditions.
- Private key never appears in stdout, logs, or error messages.
- `AIBTC_DRY_RUN=1` simulates execution without broadcasting (for testing).

## Output format

All commands emit strict JSON to stdout:

```json
{
  "status": "success | error | blocked",
  "action": "Human-readable description of next step",
  "data": { "...": "command-specific fields", "telegram": "Telegram-friendly summary" },
  "error": { "code": "ERROR_CODE", "message": "...", "next": "suggested action" } | null
}
```

## Wallet sources (checked in order)

1. `STACKS_PRIVATE_KEY` env var (direct key — for CI/testing)
2. AIBTC MCP wallet (`~/.aibtc/wallets.json` + keystore — AES-256-GCM + scrypt)
3. Legacy `~/.aibtc/wallet.json`

## Plan state

Stored at `~/.aibtc/alex-dca/<plan-id>.json`. Never deleted automatically — cancel to stop execution, then delete file manually if cleanup needed.

## Token pair validation

The `setup` command calls `alexSDK.getAmountTo()` to validate the pair has a live route on ALEX. If no route exists, it returns `PAIR_UNAVAILABLE` before saving — you will never have a saved plan for an invalid pair.
