---
name: bitflow-stop-loss-agent
skill: bitflow-stop-loss
description: "Agent behavior rules for the bitflow-stop-loss skill — manages price-triggered sell orders to protect token positions on Stacks mainnet via Bitflow."
---

# bitflow-stop-loss Agent Rules

## Primary goal

Protect token positions from downside price moves. Execute a sell on Bitflow when market price drops below the configured stop-loss threshold.

## Decision order

1. **`doctor`** — Always run first to confirm Bitflow API, wallet, and Stacks connectivity are healthy.
2. **`run`** (without `--confirm`) — Sample current prices for all active orders. If any are triggered, present the quote to the operator.
3. **`run --confirm`** — Only after operator review (or if operating autonomously with confirmed position risk).
4. **`set`** — Only create new orders after confirming the token pair route exists (validated automatically on set).
5. **`cancel`** — Cancel orders that are no longer needed.

## Refusal conditions

- **Refuse** to execute if slippage exceeds 15% (hard enforced in code).
- **Refuse** to execute if the wallet balance is insufficient for the full sell amount.
- **Refuse** to create more than 20 active orders (hard enforced in code).
- **Refuse** to execute if `AIBTC_WALLET_PASSWORD` is not set and `--wallet-password` is not provided — wallet decryption will fail.
- **Refuse** to execute on testnet or simnet — mainnet only.
- **Refuse** to create orders for unverified token pairs (no Bitflow route).

## Risk controls

- **Amount limit**: Hard cap of 1,000,000 units per order (any token). Flag amounts above 10,000 STX / 0.1 sBTC for operator confirmation.
- **Slippage**: Default 3%, maximum 15%. Recommend ≤5% for liquid pairs, ≤10% for lower-liquidity tokens.
- **Expiry**: Default 7d. For large positions (>10,000 STX equivalent), recommend short expiry (1d–3d) so stop prices stay relevant.
- **Order limit**: Maximum 20 active orders at once. Helps prevent runaway automation.
- **Post-condition mode**: Always `Deny` — never approve transactions without post-conditions matching expected output.
- **Confirmation gate**: `run --confirm` requires explicit opt-in. Without `--confirm`, always returns a preview (blocked status).

## Autonomous operation rules

When operating on a heartbeat schedule:

- Call `run` (no confirm) every heartbeat to sample prices.
- Only call `run --confirm` if at least one order is triggered AND the expected output meets a minimum threshold (> 1 STX equivalent in gas costs).
- Do NOT retry a failed execution in the same run — let the next heartbeat retry.
- If `run` returns an error (API down, wallet locked), log and skip. Do not cancel orders.
- If `run --confirm` fails with `INSUFFICIENT_BALANCE`, log the error and flag for operator. Do not cancel the order.

## Safety notes

- **Never log or output the wallet mnemonic, private key, or raw password.**
- Price samples are approximate (based on 1-unit quotes). For large orders, the actual execution price may differ from the sampled price. This is documented and expected.
- Expired orders are cleaned up automatically on `run` — no manual action needed.
- A stop-loss order does not guarantee execution at the exact stop price — it guarantees execution attempt when price falls below threshold. Slippage applies.

## Cooldown

After a successful execution, the order is marked `triggered` and removed from active monitoring. No cooldown is needed — executed orders cannot re-trigger.

## Escalation

If `run --confirm` fails more than 2 times in succession for the same order, set a flag in the order file and log for operator review. Do not keep retrying indefinitely.
