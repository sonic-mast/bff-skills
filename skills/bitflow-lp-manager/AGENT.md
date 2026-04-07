---
name: bitflow-lp-manager-agent
skill: bitflow-lp-manager
description: "Autonomous LP position manager for Bitflow AMM — adds and removes liquidity with spend limits, slippage protection, and IL disclosure."
---

# Agent Behavior — Bitflow LP Manager

## Decision order

1. Run `doctor` first. If gas < 200,000 uSTX or Bitflow API unreachable, stop and surface the blocker. Do not proceed.
2. Run `status` to check current LP positions.
3. Decide based on position + wallet state:
   - If wallet has idle STX above reserve AND no existing position → consider `run --action=add --dry-run` first, confirm, then execute.
   - If agent needs liquid STX/sBTC for another operation → `run --action=remove --dry-run` first, confirm, then execute.
   - If position exists and no action needed → report status and move on.
4. Always run with `--dry-run` before live execution. Confirm the MCP payload makes sense.
5. Parse JSON output; route on `status` field.

## Capital allocation strategy

- **Liquid reserve (never LP'd):** 500,000 uSTX minimum for gas and operational costs.
- **LP eligible:** STX balance above reserve threshold → eligible for adding liquidity.
- **IL awareness:** Only add liquidity when confident on holding timeframe. LP positions exposed to impermanent loss if prices diverge > 10%.
- **Max per call:** 1,000,000 uSTX equivalent (default). Override with `--max-ustx` only after operator approval.

## Guardrails

- **Never proceed past `blocked` without explicit operator confirmation.** Blocked means a safety check failed.
- **Always dry-run first.** Live execution requires a preceding dry-run with `pre_checks` all passing.
- **Never add both tokens if STX reserve < 500,000 uSTX after transaction.** Check post-transaction balance before confirming.
- **Slippage hard cap: 5%.** Never pass `--slippage > 5` to the skill. Default 1% is recommended.
- **Never remove > 100% of LP position in a single call.** Partial removes are fine.
- **Single-sided adds are not supported.** If agent only has one token of a pair, do not attempt add-liquidity. Surface as blocked.
- **IL warning:** If `il_warning: true` in status output, disclose to operator before any position modification.
- **Never expose wallet private keys or mnemonics** in arguments or logs.

## On error

- `insufficient_gas`: Agent must acquire STX before retrying. Minimum 200,000 uSTX recommended.
- `api_unreachable`: Bitflow API down — skip LP operations this cycle, retry next.
- `exceeds_spend_limit`: Reduce amount or request operator to raise limit.
- `slippage_exceeded`: Pool moved significantly during quote window. Re-quote and retry, or reduce amount.
- `insufficient_token_balance`: Wallet lacks the second token for pair. Cannot add liquidity.
- Do not retry silently. Always surface error with `action` guidance.

## On success

- Confirm MCP command was dispatched.
- Log: "Added X uSTX / Y sats to Bitflow STX-sBTC LP" or "Removed Z LP tokens from Bitflow STX-sBTC pool".
- Update agent's position tracking state.
- Re-run `status` after 1 block (~10 seconds) to verify new LP balance.

## Confirmation gates

| Action | Requires dry-run first | Requires operator confirmation |
|--------|----------------------|-------------------------------|
| `status` | No | No |
| `doctor` | No | No |
| `run --action=list` | No | No |
| `run --action=add` | Yes | If amount > 500,000 uSTX |
| `run --action=remove` | Yes | Always (irreversible proportional loss) |

## Output routing

```
status == "success" → parse data, proceed with mcp_command if present
status == "blocked"  → stop, surface error.message to operator, wait for instruction
status == "error"    → log error, do not retry automatically
```
