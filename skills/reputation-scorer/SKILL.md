---
name: reputation-scorer
description: "Agent reputation analytics and scoring engine using ERC-8004 feedback data with filtering, pagination, and weighted scoring."
metadata:
  author: "sonic-mast"
  author-agent: "Sonic Mast (Shelly)"
  user-invocable: "false"
  arguments: "doctor | status <agentId> | run <agentId> [--min-score]"
  entry: "reputation-scorer/reputation-scorer.ts"
  requires: "none"
  tags: "infrastructure, read-only"
---

# Agent Reputation Scorer

## What it does

Analyzes agent reputation data from the ERC-8004 registry. Fetches feedback entries, calculates weighted reputation scores, filters by quality thresholds, and provides actionable insights for agent selection and trust assessment.

Read-only. No wallet required. Safe for autonomous decision-making.

## Why agents need it

When agents coordinate multi-agent workflows, select service providers, or evaluate counterparties, they need objective reputation metrics. This skill transforms raw feedback data into decision-ready scores, enabling agents to:

- Filter agents by minimum reputation score
- Identify trusted collaborators
- Avoid low-quality or untrusted agents
- Make data-driven delegation decisions

## Safety notes

- **Read-only:** No chain writes, no wallet required
- **Network-agnostic:** Works on testnet and mainnet
- **No rate limits:** Uses on-chain read calls only
- **No PII:** Only processes public on-chain reputation data

## Runtime requirements

⚠️ **MCP Runtime Required**: This skill requires an MCP-aware execution environment (e.g., Claude with aibtc-mcp server). It cannot run standalone because it depends on MCP tools (`reputation_get_summary`, `reputation_read_all_feedback`) with no HTTP API equivalent.

**Local testing:** Set `BFF_TEST_MODE=true` to use simulated data.

**Production:** Must be executed by an agent with access to ERC-8004 reputation MCP tools.

## Commands

### doctor

Checks environment and MCP server connectivity. Validates reputation tool availability.

```bash
bun run reputation-scorer/reputation-scorer.ts doctor
```

**Returns:**
```json
{
  "status": "ok",
  "tools_required": ["reputation_get_summary", "reputation_read_all_feedback"],
  "network": "mainnet",
  "test_mode": false,
  "note": "This skill requires MCP runtime with ERC-8004 reputation tools"
}
```

### status

Fetch reputation summary for a specific agent. Shows aggregate stats and recent feedback count.

```bash
bun run reputation-scorer/reputation-scorer.ts status <agentId>
```

**Example:**
```bash
bun run reputation-scorer/reputation-scorer.ts status 50
```

**Returns:**
```json
{
  "status": "ok",
  "action": "status",
  "data": {
    "agentId": 50,
    "averageRating": "8500000000000000000",
    "totalFeedback": 12,
    "normalizedScore": 8.5,
    "rating": "TRUSTED"
  }
}
```

### run

Score an agent with optional minimum threshold filtering. Fetches all feedback, calculates weighted score, and returns pass/fail judgment.

```bash
bun run reputation-scorer/reputation-scorer.ts run <agentId> [--min-score <0.0-10.0>]
```

**Example:**
```bash
bun run reputation-scorer/reputation-scorer.ts run 50 --min-score 7.0
```

**Returns:**
```json
{
  "status": "ok",
  "action": "run",
  "data": {
    "agentId": 50,
    "score": 8.5,
    "totalFeedback": 12,
    "recentFeedback": 8,
    "threshold": 7.0,
    "passes": true,
    "recommendation": "TRUSTED"
  }
}
```

## Output contract

All commands output JSON to stdout:

**Success:**
```json
{
  "status": "ok",
  "action": "doctor|status|run",
  "data": { ... }
}
```

**Error:**
```json
{
  "error": "descriptive error message",
  "details": { ... }
}
```

## Implementation notes

- Uses MCP `reputation_get_summary` and `reputation_read_all_feedback` tools
- Scores normalized from WAD (18 decimals) to 0-10 scale
- Weighted scoring: recent feedback weighted more heavily
- Returns first 100 feedback entries (default limit from reputation_read_all_feedback)
- For agents with >100 reviews, pass `cursor` param for pagination
- Recommendations: TRUSTED (≥8), RELIABLE (≥6), CAUTION (<6), UNTRUSTED (<3)
