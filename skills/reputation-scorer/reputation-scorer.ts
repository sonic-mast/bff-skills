#!/usr/bin/env -S bun run
/**
 * reputation-scorer.ts
 * 
 * Agent reputation analytics using ERC-8004 feedback data.
 * Read-only, no wallet required.
 * 
 * Commands:
 *   doctor               - Environment checks
 *   status <agentId>     - Get reputation summary
 *   run <agentId> [opts] - Score agent with threshold filtering
 * 
 * Options:
 *   --min-score <0-10>   - Minimum acceptable score (default: 6.0)
 */

import { Command } from 'commander';

// Type definitions
interface MCPResult {
  status?: string;
  error?: string;
  data?: any;
  [key: string]: any;
}

interface ReputationSummary {
  agentId: number;
  averageRating: string;  // WAD format (18 decimals)
  totalFeedback: number;
}

interface FeedbackEntry {
  client: string;
  value: number;
  valueDecimals: number;
  timestamp: number;
  revoked?: boolean;
}

interface ScoringResult {
  agentId: number;
  score: number;
  totalFeedback: number;
  recentFeedback: number;
  threshold: number;
  passes: boolean;
  recommendation: string;
}

// MCP tool execution helper
async function callMCPTool(toolName: string, params: Record<string, any> = {}): Promise<MCPResult> {
  // In BFF skills, we output JSON that the MCP-aware agent will execute
  // For local testing, we simulate MCP responses
  const isTest = process.env.BFF_TEST_MODE === 'true';
  
  if (isTest) {
    // Simulated responses for testing
    if (toolName === 'reputation_get_summary') {
      return {
        status: 'ok',
        data: {
          agentId: params.agentId,
          averageRating: '8500000000000000000',
          totalFeedback: 12
        }
      };
    }
    
    if (toolName === 'reputation_read_all_feedback') {
      return {
        status: 'ok',
        data: {
          entries: Array(12).fill(null).map((_, i) => ({
            client: `SP${Math.random().toString(36).substring(2, 20).toUpperCase()}`,
            value: Math.floor(Math.random() * 10),
            valueDecimals: 0,
            timestamp: Date.now() - (i * 86400000),
            revoked: false
          })),
          total: 12
        }
      };
    }
  }
  
  // Real MCP execution - agent will handle this
  console.error(`[MCP] Calling ${toolName} with params:`, JSON.stringify(params));
  
  // Return placeholder - agent intercepts and executes
  return {
    status: 'pending',
    tool: toolName,
    params
  };
}

// Convert WAD (18 decimal) to normalized 0-10 score
function wadToScore(wadString: string): number {
  const wad = BigInt(wadString);
  const normalized = Number(wad) / 1e18;
  return Math.round(normalized * 100) / 100; // 2 decimal precision
}

// Calculate weighted score with recency bias
function calculateWeightedScore(feedback: FeedbackEntry[]): number {
  if (feedback.length === 0) return 0;
  
  const now = Date.now();
  const thirtyDaysMs = 30 * 86400000;
  
  let weightedSum = 0;
  let totalWeight = 0;
  
  for (const entry of feedback) {
    if (entry.revoked) continue;
    
    const normalizedValue = entry.value / Math.pow(10, entry.valueDecimals);
    const ageMs = now - entry.timestamp;
    
    // Recency weight: 1.0 for <30 days, decays to 0.5 for older
    const recencyWeight = ageMs < thirtyDaysMs 
      ? 1.0 
      : Math.max(0.5, 1.0 - ((ageMs - thirtyDaysMs) / (365 * 86400000)));
    
    weightedSum += normalizedValue * recencyWeight;
    totalWeight += recencyWeight;
  }
  
  return totalWeight > 0 
    ? Math.round((weightedSum / totalWeight) * 100) / 100
    : 0;
}

// Get recommendation tier
function getRecommendation(score: number): string {
  if (score >= 8.0) return 'TRUSTED';
  if (score >= 6.0) return 'RELIABLE';
  if (score >= 3.0) return 'CAUTION';
  return 'UNTRUSTED';
}

// Command implementations
async function doctorCommand(): Promise<void> {
  const result = {
    status: 'ok',
    tools_available: [
      'reputation_get_summary',
      'reputation_read_all_feedback'
    ],
    network: process.env.STACKS_NETWORK || 'mainnet',
    test_mode: process.env.BFF_TEST_MODE === 'true'
  };
  
  console.log(JSON.stringify(result, null, 2));
}

async function statusCommand(agentId: number): Promise<void> {
  try {
    const summary = await callMCPTool('reputation_get_summary', { agentId });
    
    if (summary.error) {
      console.log(JSON.stringify({
        error: `Failed to fetch reputation: ${summary.error}`
      }));
      process.exit(1);
    }
    
    const data = summary.data as ReputationSummary;
    const normalizedScore = wadToScore(data.averageRating);
    
    const result = {
      status: 'ok',
      action: 'status',
      data: {
        agentId: data.agentId,
        averageRating: data.averageRating,
        totalFeedback: data.totalFeedback,
        normalizedScore,
        rating: getRecommendation(normalizedScore)
      }
    };
    
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    console.log(JSON.stringify({
      error: `Status check failed: ${err}`
    }));
    process.exit(1);
  }
}

async function runCommand(agentId: number, minScore: number): Promise<void> {
  try {
    // Fetch detailed feedback for weighted scoring
    const feedbackResult = await callMCPTool('reputation_read_all_feedback', { 
      agentId,
      includeRevoked: false
    });
    
    if (feedbackResult.error) {
      console.log(JSON.stringify({
        error: `Failed to fetch feedback: ${feedbackResult.error}`
      }));
      process.exit(1);
    }
    
    const feedback = feedbackResult.data?.entries;
    if (!feedback || !Array.isArray(feedback)) {
      console.log(JSON.stringify({
        error: `No feedback data returned for agent ${agentId}`
      }));
      process.exit(1);
    }
    const score = calculateWeightedScore(feedback);
    
    // Count recent feedback (last 90 days)
    const ninetyDaysAgo = Date.now() - (90 * 86400000);
    const recentFeedback = feedback.filter((f: FeedbackEntry) => 
      f.timestamp >= ninetyDaysAgo && !f.revoked
    ).length;
    
    const result: ScoringResult = {
      agentId,
      score,
      totalFeedback: feedback.length,
      recentFeedback,
      threshold: minScore,
      passes: score >= minScore,
      recommendation: getRecommendation(score)
    };
    
    console.log(JSON.stringify({
      status: 'ok',
      action: 'run',
      data: result
    }, null, 2));
    
    // Exit code reflects pass/fail
    process.exit(result.passes ? 0 : 1);
    
  } catch (err) {
    console.log(JSON.stringify({
      error: `Scoring failed: ${err}`
    }));
    process.exit(1);
  }
}

// CLI setup
const program = new Command();

program
  .name('reputation-scorer')
  .description('Agent reputation analytics using ERC-8004 feedback data')
  .version('1.0.0');

program
  .command('doctor')
  .description('Check environment and tool availability')
  .action(doctorCommand);

program
  .command('status')
  .description('Get reputation summary for an agent')
  .argument('<agentId>', 'Agent ID to check', parseInt)
  .action((agentId: number) => {
    if (isNaN(agentId) || agentId < 0) {
      console.log(JSON.stringify({
        error: 'agentId must be a valid non-negative integer'
      }));
      process.exit(1);
    }
    return statusCommand(agentId);
  });

program
  .command('run')
  .description('Score agent with threshold filtering')
  .argument('<agentId>', 'Agent ID to score', parseInt)
  .option('--min-score <score>', 'Minimum acceptable score (0-10)', parseFloat, 6.0)
  .action(async (agentId: number, options: { minScore: number }) => {
    if (isNaN(agentId) || agentId < 0) {
      console.log(JSON.stringify({
        error: 'agentId must be a valid non-negative integer'
      }));
      process.exit(1);
    }
    if (isNaN(options.minScore) || options.minScore < 0 || options.minScore > 10) {
      console.log(JSON.stringify({
        error: 'min-score must be a number between 0 and 10'
      }));
      process.exit(1);
    }
    await runCommand(agentId, options.minScore);
  });

await program.parseAsync();
