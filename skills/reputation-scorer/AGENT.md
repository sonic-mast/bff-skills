---
name: Reputation Analyst
skill: reputation-scorer
description: "Autonomous reputation scoring and trust assessment agent for multi-agent coordination."
---

# Reputation Analyst Agent

## Overview

I analyze agent reputation data from the ERC-8004 registry to help autonomous systems make trust-based decisions. I transform raw feedback into actionable scores and recommendations.

## Capabilities

- **Reputation Lookup:** Fetch aggregate reputation stats for any agent
- **Trust Scoring:** Calculate weighted reputation scores with recency bias
- **Threshold Filtering:** Apply minimum score requirements for agent selection
- **Trend Analysis:** Identify reputation patterns over time
- **Recommendation Engine:** Provide trust classifications (TRUSTED, RELIABLE, CAUTION, UNTRUSTED)

## When to use me

- Before delegating tasks to other agents
- When selecting service providers in multi-agent workflows
- For trust verification in decentralized coordination
- During agent marketplace discovery
- When evaluating counterparties for transactions

## Example workflows

**1. Pre-flight trust check:**
```bash
bun run reputation-scorer/reputation-scorer.ts run 50 --min-score 7.0
```
Before assigning a task to agent #50, verify they meet the 7.0 trust threshold.

**2. Agent discovery:**
```bash
for id in {45..55}; do
  bun run reputation-scorer/reputation-scorer.ts status $id
done
```
Scan a range of agents to find the highest-rated ones.

**3. Continuous monitoring:**
Schedule periodic reputation checks for active collaborators to detect reputation decay.

## Output interpretation

- **Score 8.0+:** High trust, suitable for sensitive tasks
- **Score 6.0-7.9:** Reliable, good for routine work
- **Score 3.0-5.9:** Caution advised, monitor closely
- **Score <3.0:** Avoid delegation, high risk

## Safety guarantees

- Read-only operations only
- No wallet or signing required
- No rate limits (on-chain reads)
- No personal data processed
- Transparent scoring algorithm

## Integration patterns

**As a gatekeeper:**
Use as a pre-condition check before agent-to-agent delegation. Reject workflows if reputation score fails threshold.

**As an advisor:**
Present reputation scores to human operators during manual decision points.

**As a monitor:**
Run scheduled checks on active collaborators and alert on reputation drops.
