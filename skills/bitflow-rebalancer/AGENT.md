---
name: bitflow-rebalancer-agent
skill: bitflow-rebalancer
description: "Maintains target portfolio allocations on Stacks by swapping tokens via Bitflow when drift exceeds threshold. Requires explicit confirmation before executing any swap."
---

# Bitflow Rebalancer Agent

## Decision Order

1. Call `doctor` to verify Bitflow API and wallet health before any operation.
2. Call `status --plan <id>` to check current allocation vs target.
3. If drift < threshold OR within cooldown: output the `blocked` response and stop. Do not run.
4. Call `preview --plan <id>` to show the required trades. Present the preview to the operator.
5. Wait for operator to confirm. Then call `run --plan <id> --confirm`.
6. Log tx hashes and updated allocation after successful run.

## Safety Rules

- **Never execute `run --confirm` without first showing a `preview`.**
- **Never call `configure` with `--threshold` below 2%** — sub-2% thresholds trigger excessive trading and gas waste.
- **Never rebalance with slippage above 5%** unless the operator explicitly overrides. Default is 3%.
- **Respect the cooldown.** Do not attempt to bypass or re-configure a shorter cooldown to force a rebalance.
- **Minimum reserves**: Do not rebalance if post-swap STX balance would fall below 100,000 uSTX (0.1 STX). Leave buffer for gas.
- **Max single rebalance trade**: Do not execute swaps larger than 20% of portfolio value in a single run. If more is needed, set status to `blocked` and ask operator.
- **Dry-run on first use**: On initial deployment, run with `AIBTC_DRY_RUN=1` to verify the plan works before executing real swaps.

## Refusal Conditions

Refuse (return `blocked`) if:
- Plan is in `cancelled` status.
- `--confirm` is absent.
- Drift is below threshold.
- Cooldown has not elapsed.
- STX balance is insufficient for gas.
- Required trade exceeds 20% of portfolio value.
- No valid Bitflow route exists for the pair.

## Autonomous Scheduling

When called on a heartbeat/cron:
1. Run `preview` first.
2. If `status: blocked` — log and exit. No action needed.
3. If `status: success` (trades needed) — present preview and await `--confirm`. Do not auto-confirm unless operator has explicitly enabled autonomous mode.

## Error Handling

- On `ROUTE_NOT_FOUND`: wait for the next schedule tick. Bitflow routing is occasionally unavailable.
- On `BROADCAST_FAILED`: log the error. Do not retry automatically — check mempool and operator before retrying.
- On `INSUFFICIENT_GAS`: alert operator to top up STX balance before proceeding.
- On `SLIPPAGE_EXCEEDED`: do not retry with higher slippage. Wait for market conditions to improve.

## Portfolio Context

Use this skill when managing multi-token agent treasuries that should maintain defined risk allocations. Common patterns:
- Conservative (80% STX / 20% sBTC) — stability-focused
- Balanced (60% STX / 40% sBTC) — yield + BTC exposure
- Growth (40% STX / 60% sBTC) — BTC-heavy for appreciation

For yield optimization on top of a target allocation, consider combining with `dca` or `zest-yield-manager`.
