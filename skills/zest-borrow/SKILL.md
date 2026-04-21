---
name: zest-borrow
description: "Zest Protocol borrow/repay manager. Checks collateral health, enforces a 1.30 health-factor floor, and outputs MCP call parameters for parent-agent execution — never executes writes autonomously."
metadata:
  author: "sonic-mast"
  author-agent: "Sonic Mast"
  user-invocable: "false"
  arguments: "doctor | status | borrow | repay"
  entry: "zest-borrow/zest-borrow.ts"
  requires: "zest_borrow (aibtc MCP), zest_repay (aibtc MCP), zest_get_position (aibtc MCP)"
  tags: "zest, defi, write, mainnet-only, stacks, lending, borrowing"
---

# zest-borrow

## What it does

Manages Zest Protocol borrowing positions for autonomous agents. Reads Zest-supported token balances directly from the Stacks blockchain via Hiro API, validates borrow/repay parameters against a configurable health-factor floor, and outputs structured `BORROW_READY` / `REPAY_READY` payloads for parent-agent execution via AIBTC MCP tools.

**Safety-first design**: `borrow` and `repay` are blocked without `--confirm`. Any borrow where the post-borrow health factor would fall below 1.30 must be caught by the parent agent before calling `zest_borrow` — the skill outputs the checklist.

## Supported assets

| Symbol | Mainnet contract | Decimals |
|---|---|---|
| wSTX | `SP1A27KFY4XERQCCRCARCYD1CC5N7M6688BSYADJ7.wstx` | 6 |
| sBTC | `SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token` | 8 |
| stSTX | `SP4SZE494VC2YC5JYG7AYFQ44F5Q4PYV7DVMDPBG.ststx-token` | 6 |
| USDC | `SP120SBRBQJ00MCWS7TM5R8WJNTTKD5K0HFRC2CNE.usdcx` | 6 |
| USDH | `SPN5AKG35QZSK2M8GAMR4AFX45659RJHDW353HSG.usdh-token-v1` | 8 |
| stSTXbtc | `SP4SZE494VC2YC5JYG7AYFQ44F5Q4PYV7DVMDPBG.ststxbtc-token-v2` | 6 |

Asset addresses sourced from `zest_list_assets` AIBTC MCP tool.

## Safety notes

- `doctor` and `status` are read-only — no wallet required.
- `borrow` and `repay` require `--confirm`; without it, output is `blocked` (preview only).
- Health factor floor: **1.30** — parent agent must verify via `zest_get_position` before executing `zest_borrow`.
- Default max single borrow: **50,000 units** (override with `--max-units`).
- All MCP payloads include `postConditionMode: "deny"`.

## Commands

### doctor
Verifies Hiro API connectivity and confirms asset contracts are reachable.

```bash
bun run zest-borrow/zest-borrow.ts doctor
```

### status
Reads token balances for all Zest-supported assets at a given Stacks address.

```bash
bun run zest-borrow/zest-borrow.ts status --address SP...
```

### borrow
Validates parameters and outputs `BORROW_READY` payload for parent-agent execution.

```bash
# Preview (no --confirm)
bun run zest-borrow/zest-borrow.ts borrow --asset USDC --amount 500 --address SP...

# Generate payload
bun run zest-borrow/zest-borrow.ts borrow --asset USDC --amount 500 --address SP... --confirm
```

### repay
Validates parameters and outputs `REPAY_READY` payload for parent-agent execution.

```bash
# Preview
bun run zest-borrow/zest-borrow.ts repay --asset USDC --amount 100 --address SP...

# Generate payload
bun run zest-borrow/zest-borrow.ts repay --asset USDC --amount 100 --address SP... --confirm
```
