---
name: defi-position-safety-checker-agent
skill: defi-position-safety-checker
description: "Monitor DeFi positions for liquidation risk and alert on LTV/health factor threshold breach."
---

# DeFi Position Safety Checker — Agent Behavior

## Core Purpose

Autonomous monitoring of Zest Protocol v2 lending positions. Detects when LTV or health factor approaches liquidation thresholds and triggers alerts without executing corrective actions.

## Decision Order

1. **Load configuration** → Read thresholds from CLI args or defaults
2. **Validate wallet** → Check Stacks address and signing capability
3. **Query Zest position** → Fetch collateral, debt, and health metrics
4. **Calculate LTV and health factor** → Derive risk metrics from on-chain data
5. **Compare against thresholds** → Determine alert level (soft/warning/critical)
6. **Generate alert** → Emit JSON event with timestamp and details
7. **Deliver alert** → Post to stdout, logs, or webhooks
8. **Schedule next check** → If in watch mode, sleep until next interval

## Threshold Tiers

- **Soft (60%):** Informational — position is healthy but approaching monitoring zone
- **Warning (75%):** Position nearing Zest soft limit — consider reducing debt
- **Critical (85%):** Position nearing partial liquidation zone — urgent action recommended
- **Emergency (95%):** Position at severe liquidation risk — manual override required

## Guardrails & Constraints

### What This Skill CANNOT Do

- Execute borrowing or repayment
- Liquidate positions
- Force liquidation calls
- Swap assets or rebalance collateral
- Access other users' positions
- Sign transactions on behalf of the position owner

### What This Skill CAN Do

- Query position data (read-only)
- Calculate LTV and health factor
- Emit alerts based on thresholds
- Deliver alerts to webhooks or logs
- Provide monitoring loop infrastructure

### Safety Controls

- **No side effects:** All queries are read-only; no state changes
- **Timeout enforcement:** 10-second maximum per API call; fails fast on network issues
- **Error handling:** Parse errors logged with full context; no silent failures
- **Threshold validation:** User-supplied thresholds must be 0 ≤ x ≤ 100; invalid thresholds rejected
- **Rate limiting:** Default 5-minute check interval to respect API quota; user can configure
- **Alert deduplication:** Do not emit duplicate alerts within same interval; track last alert state

## Autonomous Execution Profile

**Role:** Watcher (read-only, non-blocking)  
**Invocation:** Scheduled or event-triggered via heartbeat/cron  
**Latency:** Up to 5 minutes acceptable between checks  
**Failure mode:** Degrade to logging; do not interrupt primary operations  
**User intervention:** Alerts inform but do not force action  

## Example Autonomous Scenario

```
08:00 - Heartbeat triggered, start monitor mode
08:00 - Query position: LTV = 72%, health = 2.1 (healthy)
08:05 - Query again: LTV = 74%, health = 1.9 (approaching warning)
08:10 - Query again: LTV = 76%, health = 1.7 (ALERT: warning threshold breached)
        → Emit alert to webhook + log
        → Continue monitoring
08:15 - Query: LTV = 78% → Log info, no new alert (within dedup window)
08:20 - Query: LTV = 74% → Alert cleared, log recovery

Agent responds to alert:
- Evaluates position health: LTV > 75%, health < 2.0 → risk elevated
- Does NOT auto-borrow or liquidate
- Posts alert to user's Telegram topic
- Waits for user direction (manual rebalance or accept risk)
```

## Refusal Conditions

Skill MUST refuse and log error if:

1. **No wallet loaded** → Cannot validate signer identity
2. **Invalid address format** → Not a valid Stacks address
3. **Zest API unreachable** → Cannot fetch position data
4. **Invalid threshold values** → Non-numeric or out-of-range thresholds
5. **Timeout on API query** → Retry up to 2x, then fail with error

## Integration with Broader Agent

This skill is designed as a **read-only monitoring layer** for other execution skills:

- **Upstream:** Signal researcher or portfolio manager identifies position
- **This skill:** Monitors LTV/health; triggers alert when threshold breached
- **Downstream:** Position rebalancer (future skill) consumes alert and decides corrective action

---

**Day 9 — BFF Skills Competition**  
**Status:** Safety-first design; guardrails enforced in code  
**Next:** Test with mock position data, then live Zest integration
