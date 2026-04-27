---
name: hodlmm-compound-agent
skill: hodlmm-compound
description: "Autonomous agent that compounds Bitflow HODLMM DLMM positions by withdrawing liquidity, rebalancing token ratio via Bitflow swap, and re-adding to active bins."
---

# Agent Behavior — HODLMM Compound

## Decision order

1. Run `doctor` first. If any check fails (wallet missing, Bitflow unreachable), stop and surface the blocker. Do not proceed to write operations.
2. Run `scan` to identify positions and check imbalance. If no positions exist, report and exit.
3. Check cooldown: if a compound was executed within the last 4 hours for the target pool, skip.
4. Evaluate compound trigger: proceed only if `drift > 10 bins` OR `imbalance > 10%` OR explicitly instructed.
5. Run `run --pool <slug>` (dry-run) to preview the full cycle: withdrawal amounts, swap quote, and redeposit plan.
6. Show the dry-run to the operator if running interactively. In `auto` mode, proceed if the swap's `priceImpact < 3%` and `slippage < 5%`.
7. Execute `run --pool <slug> --confirm` to execute the compound cycle.
8. Verify all three transaction IDs are returned. Report success with explorer links.

## Guardrails

- **Never execute without `--confirm`** in interactive mode. The dry-run is the gate.
- **Minimum position value**: do not compound if the position is below 100 STX equivalent — the gas overhead exceeds the benefit.
- **Maximum slippage**: abort the swap step if the Bitflow route quotes >5% price impact. Log and exit cleanly.
- **Cooldown**: enforce a 4-hour minimum between compounds per pool. Store the last compound timestamp in state.
- **Post-condition mode `deny`**: all transactions are submitted with `postConditionMode: "deny"`. Token amounts are bounded by pre-computed values.
- **Do not expose private keys** in logs, args, or JSON output under any circumstances.
- **Stop on any error** in the multi-step cycle. If the withdraw tx fails, do not attempt the swap. If the swap fails, do not attempt the re-add. Report the failure and the tokens' current state so the operator can recover manually.

## Compound trigger thresholds (defaults)

| Condition | Threshold | Action |
|---|---|---|
| Active-bin drift | >10 bins | Trigger compound |
| Token imbalance | >10% from 50/50 | Trigger compound |
| Elapsed since last compound | >24 hours | Trigger compound (once per day minimum) |
| Price impact on swap | >5% | Abort — do not compound |
| Position value | <100 STX equivalent | Skip — not worth the gas |

## On error

- Log the full error payload to stderr
- Do not retry silently — surface the error with `{ "error": "...", "next": "..." }`
- If the position is in a partial state (withdrawn but not re-added), log the token balances and the recommended next step: call `run --pool <slug> --confirm` manually after reviewing the state
- If Bitflow API is unreachable, skip the compound cycle and retry next run

## On success

- Record the three transaction IDs and the pool slug in the compound state file
- Update `lastCompoundAt` for the pool
- Report final token balances and new bin range to stdout
- Log total compound cycles completed for the pool
