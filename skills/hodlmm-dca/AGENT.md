---
name: hodlmm-dca-agent
skill: hodlmm-dca
description: "Agent behavior rules for hodlmm-dca — recurring STX-to-HODLMM-LP dollar-cost averaging with active-bin price awareness and mandatory spend limits."
---

# hodlmm-dca Agent Rules

## Primary goal

Execute recurring, size-limited STX swaps into a Bitflow HODLMM pool's token pair on a fixed schedule, accumulating LP-ready tokens for deployment. The agent IS the scheduler — no external keeper required.

## Decision order

1. **`doctor` first** — On first use or any error, run `doctor` to verify wallet, Bitflow API, and HODLMM pool access before any other command.
2. **Check before acting** — Always run `status` or `run` (without `--confirm`) before executing to confirm the plan is live and the frequency gate is open.
3. **One run per interval** — The frequency gate is enforced in code. Never call `run --confirm` more than once per `interval_hours` window.
4. **Never exceed limits** — The 500 STX per-run cap and 10,000 STX total cap are hardcoded. Do not attempt to work around them.
5. **Balance first** — Always verify sufficient STX balance before executing. If balance is below `stx_per_run + gas_buffer`, skip the cycle and set a low-balance flag.

## Guardrails

### Spend limits (hardcoded — NOT configurable)
- **Max per run:** 500 STX (or equivalent input token)
- **Max total per plan:** 10,000 STX equivalent
- **Min interval:** 1 hour between runs
- **Max slippage:** 5% (enforced even if operator requests higher)
- **Max bin spread:** 11 bins centered on active (±5 bins max)

### Refusal conditions

- **Refuse** to execute if `stx_per_run` > 500 STX — reject at `setup` time.
- **Refuse** to execute if total deployed would exceed 10,000 STX — block at `run` time.
- **Refuse** to execute if the frequency gate is closed (not yet due).
- **Refuse** to execute if STX balance < `stx_per_run + 0.1 STX gas buffer`.
- **Refuse** to execute if Bitflow API is unreachable — do not guess pool state.
- **Refuse** to execute on testnet — this skill is mainnet only.
- **Refuse** to execute without `--confirm` flag — all on-chain writes require explicit confirmation.
- **Refuse** to execute if HODLMM active bin has not been fetched successfully — stale bin data could result in a misaligned LP position.

### Error handling

- If a swap fails due to slippage: log the error in history, keep the plan active, do not retry in the same cycle.
- If a swap fails due to insufficient balance: mark `low_balance` in status, pause DCA.
- If the plan reaches `max_runs` (if set): mark `completed`, do not auto-execute further.
- Consecutive failures ≥ 3: set `status: paused_errors` and alert via status output.

## Autonomous operation cadence

```
every heartbeat (e.g., every 5 min):
  run hodlmm-dca status          # fast check — no wallet needed
  if next_run_at < now:
    run hodlmm-dca run --confirm  # execute the DCA
    call bitflow_hodlmm_add_liquidity with the output mcpDepositCmd (optional LP step)
```

## Safety notes

- This skill executes real on-chain swaps. Each `run --confirm` call broadcasts a Stacks transaction.
- The `bitflow_hodlmm_add_liquidity` LP deployment step is optional and separate — the agent should only call it when the accumulated token balance justifies the gas cost.
- Never auto-compound: do not automatically reinvest received LP tokens without explicit operator approval.
- Slippage enforcement (5% max) is implemented in code via `PostConditionMode.Deny` post-conditions. If the actual output is below the min-amount threshold, the transaction will abort on-chain.
