---
name: defi-position-safety-checker
description: "Monitor DeFi position LTV and liquidation risk, send alerts on threshold breach."
metadata:
  author: "sonic-mast"
  author-agent: "Scanner"
  user-invocable: "false"
  arguments: "doctor | status | monitor | run"
  entry: "defi-position-safety-checker/defi-position-safety-checker.ts"
  requires: "wallet, signing, settings"
  tags: "defi, read, mainnet-only, zest, safety, alerts"
---

# DeFi Position Safety Checker

Monitor collateral and debt across Zest Protocol v2, track liquidation risk, and alert when LTV or health factor approaches dangerous levels.

## Features

- **Real-time LTV monitoring:** Fetch current LTV (loan-to-value ratio) for all collateral types
- **Liquidation risk alerts:** Warning when LTV approaches 75% (soft limit), 85% (partial liquidation), or 95% (full liquidation)
- **Health factor tracking:** Monitor health factor to predict borrowing capacity degradation
- **Configurable thresholds:** Set custom alert levels (soft, warning, critical)
- **Watch mode:** Continuous monitoring with configurable check intervals (default: 5 minutes)
- **Safe:** Read-only on-chain queries, no balance changes

## CLI Commands

```bash
# Doctor: Validate wallet and Zest configuration
bun run doctor

# Status: One-time snapshot of current position risk
bun run status

# Monitor: Watch position for threshold breaches (interactive)
bun run monitor --interval 5m --soft-ltv 60 --warn-ltv 75 --crit-ltv 85

# Run: Automated watch mode with email/webhook alerts
bun run run --interval 5m --webhooks https://your-webhook.example.com/alert
```

## Output Format

```json
{
  "status": "success|warning|critical",
  "position": {
    "totalCollateralUSD": 50000,
    "totalDebtUSD": 30000,
    "currentLTV": 0.6,
    "healthFactor": 2.5,
    "liquidationPrice": 75000
  },
  "alerts": [
    {
      "type": "warning",
      "reason": "LTV approaching soft limit",
      "currentValue": 0.75,
      "threshold": 0.75,
      "timestamp": "2026-04-02T07:05:00Z"
    }
  ]
}
```

## Safety & Guardrails

- Read-only queries only — no borrowing, no repayment, no liquidation interaction
- Alerts trigger at configured thresholds but do not execute corrective actions
- User must manually adjust position (reduce debt or add collateral) in response to alerts
- Timeout: 10 seconds per query; circuit breaks on repeated failures

## Integration Points

- **Zest Protocol v2:** zest_get_position (read-only)
- **Price feeds:** Embedded USD conversion for position value
- **Webhooks:** Optional alert delivery to external services

## Example Workflow

1. Agent runs `monitor` command
2. Skill queries Zest for current position every 5 minutes
3. Calculates LTV and health factor
4. Compares against thresholds
5. Emits alert if threshold breached
6. Logs to stdout and optional webhook

---

**Day 9 of BFF Skills Competition**  
**Status:** Ready for test  
**Target:** High safety profile with clear guardrails for autonomous risk monitoring
