---
name: stx-stack-delegate
description: "Delegate STX to the Mechanism Capital Fast Pool (pox4-fast-pool-v3) for liquid, non-custodial stacking on Stacks PoX4. One command to delegate or re-delegate each cycle — no separate allow-contract-caller step required. Revoke at any time via PoX4 system contract."
metadata:
  author: "sonic-mast"
  author-agent: "Sonic Mast"
  user-invocable: "false"
  arguments: "doctor | status | delegate | revoke"
  entry: "stx-stack-delegate/stx-stack-delegate.ts"
  requires: "wallet, signing"
  tags: "defi, write, mainnet-only, requires-funds, stacking, yield, l2"
---

# STX Stack Delegate

Delegate STX to [Mechanism Capital Fast Pool v3](https://explorer.hiro.so/txid/0x4abafe07d549148d881e2c808ba9dde8bf1dcb82478f7a482b569e631bc0607b) (`SP21YTSM60CAY6D011EZVEVNKXVW8FVZE198XEFFP.pox4-fast-pool-v3`) for liquid, non-custodial PoX4 stacking on Stacks mainnet.

## What it does

The Fast Pool is a self-service pool: `delegate-stx` revokes any existing delegation, re-delegates the new amount, and immediately stacks for 1 cycle. No pre-authorization or multi-step setup needed. Each cycle renews automatically if `delegate-stack-stx-many` is called by pool operators or community members.

## Why agents need it

An autonomous agent holding STX can put idle capital to work without human intervention. This skill handles the full delegation lifecycle — delegate, check status, and revoke — so the agent can programmatically earn PoX4 yield and revoke when liquidity is needed, without touching a UI or custodying funds with a third party.

## Quick Start

```bash
# 1. Install dependencies
bun add @stacks/transactions @stacks/network @stacks/wallet-sdk @stacks/encryption commander

# 2. Health check
bun run stx-stack-delegate/stx-stack-delegate.ts doctor

# 3. Check current delegation status
bun run stx-stack-delegate/stx-stack-delegate.ts status

# 4. Preview delegation (--confirm required to execute)
bun run stx-stack-delegate/stx-stack-delegate.ts delegate --amount 1000

# 5. Execute delegation
bun run stx-stack-delegate/stx-stack-delegate.ts delegate --amount 1000 --confirm

# 6. Revoke delegation (preview)
bun run stx-stack-delegate/stx-stack-delegate.ts revoke

# 7. Revoke delegation (execute)
bun run stx-stack-delegate/stx-stack-delegate.ts revoke --confirm
```

## Commands

### `doctor`
System health check — verifies wallet file, Stacks API connectivity, Fast Pool contract availability, and PoX4 status.

### `status`
Read-only: shows current delegation amount to Fast Pool, current PoX cycle, estimated unlock height, and whether the wallet is currently stacking.

### `delegate --amount <STX> [--confirm] [--wallet-password <pw>]`
Delegate STX to Fast Pool for PoX4 stacking.

| Flag | Required | Description |
|------|----------|-------------|
| `--amount` | ✅ | STX to delegate in human units (e.g. `1000` = 1000 STX = 1,000,000,000 uSTX) |
| `--confirm` | — | Required to broadcast transaction. Without it, returns blocked preview. |
| `--wallet-password` | — | Wallet password (prefer `AIBTC_WALLET_PASSWORD` env var) |

- **Without `--confirm`**: Returns preview showing amount, pool address, and estimated cycle. Safe to inspect.
- **With `--confirm`**: Broadcasts transaction, returns txId and explorer link.

Hard limits enforced in code:
- Maximum: 10,000,000 STX (10M STX per delegation)
- Minimum: 100 STX (below minimum stacking threshold is pointless)
- Balance check: must have `amount + 1 STX gas buffer` in unlocked balance

### `revoke [--confirm] [--wallet-password <pw>]`
Revoke delegation via `SP000000000000000000002Q6VF78.pox-4` `revoke-delegate-stx`.

- **Without `--confirm`**: Returns preview of the revoke action.
- **With `--confirm`**: Broadcasts revoke transaction. STX unlocks at the end of the current stacking cycle.

## Safety notes

| Guardrail | Limit | Enforcement |
|-----------|-------|-------------|
| Confirmation gate | Always | `blocked` without `--confirm` |
| Max delegation | 10,000,000 STX | Hard error `AMOUNT_EXCEEDS_LIMIT` |
| Min delegation | 100 STX | Hard error `AMOUNT_TOO_SMALL` |
| Balance check | unlocked balance ≥ amount + 1 STX | Error `INSUFFICIENT_BALANCE` |
| Post-condition mode | deny | `postConditionMode: PostConditionMode.Deny` |
| Private key exposure | Never | Zero-exposure in all output |
| Network | Mainnet only | Hard error on non-mainnet |

## Output contract

All commands emit strict JSON to stdout:

```json
{
  "status": "success | error | blocked",
  "action": "Human-readable next step",
  "data": {
    "...": "command-specific fields"
  },
  "error": null
}
```

## Environment Variables

| Variable | Description |
|----------|-------------|
| `AIBTC_WALLET_PASSWORD` | Wallet password (alternative to `--wallet-password`) |
| `STACKS_PRIVATE_KEY` | Direct private key for testing (bypasses wallet file) |

## Contracts Used

| Contract | Address | Purpose |
|----------|---------|---------|
| `pox4-fast-pool-v3` | `SP21YTSM60CAY6D011EZVEVNKXVW8FVZE198XEFFP` | Self-service delegation (delegate-stx) |
| `pox-4` | `SP000000000000000000002Q6VF78` | Revocation (revoke-delegate-stx) and status reads |
