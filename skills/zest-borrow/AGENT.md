---
name: zest-borrow-agent
skill: zest-borrow
description: "Zest Protocol borrow/repay agent. Evaluates collateral health, enforces a 1.30 health-factor floor, and outputs MCP call parameters for parent execution — never borrows autonomously without confirmation."
---

# Agent Behavior — zest-borrow

## Purpose
Manage leveraged borrowing positions on Zest Protocol. The skill enforces strict safety rules to prevent over-leveraging and unplanned liquidations.

## Safety Rules
- NEVER call `zest_borrow` without first checking health factor via `zest_get_position` MCP tool
- NEVER borrow if post-borrow health factor would fall below **1.30**
- NEVER borrow more than **50,000 units** in a single call without explicit `--max-units` override
- ALWAYS require `--confirm` flag on write commands — without it, skill outputs preview only
- ALWAYS use `postConditionMode: "deny"` in all MCP payloads
- NEVER repay more than current debt balance (would fail on-chain and waste fees)

## Decision Order
1. Run `doctor` — if result is not `ready`, stop and surface the connectivity error.
2. Run `status --address <stacks-addr>` to see current token balances.
3. Call `zest_get_position` via AIBTC MCP to get health factor, total debt, and available borrow capacity.
4. If `healthFactor < 1.50`, consider repaying first before borrowing more.
5. Calculate safe borrow ceiling: `availableToBorrowUsd * 0.80` is the conservative maximum.
6. Run `borrow --asset <SYMBOL> --amount <N> --address <addr> --confirm` to get `BORROW_READY` payload.
7. Verify post-borrow health factor via `zest_get_position` — if >= 1.30, call `zest_borrow` with the payload params.

## Spend Limits
- `doctor` and `status`: zero spend, no wallet required.
- `borrow`: up to 50,000 asset units by default; parent agent controls actual execution.
- `repay`: reduces debt only; confirm the repay amount does not exceed outstanding balance.

## Recommended Scenarios
- **Yield loop**: Supply stSTX as collateral → borrow USDC → deploy USDC in another yield strategy → rebalance monthly.
- **Emergency liquidity**: Hold sBTC collateral → borrow wSTX for protocol fees or stacking entries.
- **Debt reduction automation**: Monitor health factor on a schedule; trigger `repay --confirm` when HF < 1.40.

## Autonomous Use
- `doctor` and `status` are safe for autonomous scheduled runs.
- `borrow --confirm` and `repay --confirm` require explicit parent agent confirmation flow.
- `BORROW_READY` and `REPAY_READY` outputs are the explicit handoff points — parent agent must verify health factor and then execute via `zest_borrow` / `zest_repay` MCP tools.
- Log every executed tx ID in run state for auditing.

## Error Handling
- Hiro API timeout: exit with `{ "error": "..." }` JSON. Do not proceed with stale balance data.
- Unknown asset symbol: exit with supported asset list.
- Amount <= 0: exit with validation error.
- `--confirm` missing on write commands: output `blocked` preview — this is expected behavior, not an error.
