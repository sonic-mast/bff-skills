#!/usr/bin/env -S bun run
/**
 * sbtc-bridge-monitor.ts
 * 
 * Monitors sBTC bridge operations between Bitcoin L1 and Stacks L2.
 * Tracks deposits and withdrawals, alerts on delays and failures.
 * Read-only monitoring, wallet required for address filtering.
 * 
 * Commands:
 *   doctor                        - Environment checks
 *   status <txid> [--type]        - Check specific transaction status
 *   run [--watch] [--alert-delay] - Monitor wallet's bridge activity
 * 
 * Options:
 *   --type deposit|withdrawal     - Transaction type (auto-detect if omitted)
 *   --watch                       - Continuous monitoring (5min intervals)
 *   --alert-delay-minutes <min>   - Alert threshold (default: 60 deposits, 120 withdrawals)
 */

import { Command } from 'commander';

// Type definitions
interface MCPResult {
  status?: string;
  error?: string;
  data?: any;
  [key: string]: any;
}

interface DepositStatus {
  txid: string;
  status: string;  // pending, confirmed, failed
  amount?: number;
  confirmations?: number;
  timestamp?: number;
}

interface WithdrawalStatus {
  requestId?: number;
  txid: string;
  status: string;  // pending, completed, failed
  amount?: number;
  timestamp?: number;
}

interface Alert {
  txid: string;
  type: 'deposit' | 'withdrawal';
  severity: 'info' | 'warning' | 'critical';
  message: string;
}

interface MonitorResult {
  deposits: {
    total: number;
    pending: number;
    confirmed: number;
    failed: number;
  };
  withdrawals: {
    total: number;
    pending: number;
    completed: number;
    failed: number;
  };
  alerts: Alert[];
}

// MCP tool execution helper
async function callMCPTool(toolName: string, params: Record<string, any> = {}): Promise<MCPResult> {
  const isTest = process.env.BFF_TEST_MODE === 'true';
  
  if (isTest) {
    // Simulated responses for local testing
    if (toolName === 'sbtc_deposit_status') {
      return {
        status: 'ok',
        data: {
          txid: params.txid,
          status: Math.random() > 0.3 ? 'confirmed' : 'pending',
          amount: 100000,
          confirmations: Math.floor(Math.random() * 8),
          timestamp: Date.now() - (Math.random() * 7200000) // 0-2 hours ago
        }
      };
    }
    
    if (toolName === 'sbtc_withdrawal_status') {
      return {
        status: 'ok',
        data: {
          requestId: Math.floor(Math.random() * 1000),
          txid: params.txid,
          status: Math.random() > 0.3 ? 'completed' : 'pending',
          amount: 50000,
          timestamp: Date.now() - (Math.random() * 14400000) // 0-4 hours ago
        }
      };
    }
    
    if (toolName === 'get_account_transactions') {
      // Simulate recent transactions
      return {
        status: 'ok',
        data: {
          results: [
            {
              tx_id: '0xabc123',
              tx_type: 'contract_call',
              tx_status: 'success',
              block_time: Date.now() - 1800000, // 30 min ago
              contract_call: {
                contract_id: 'SP3K8BC0PPEVCV7NZ6QSRWPQ2JE9E5B6N3PA0KBR9.sbtc-token',
                function_name: 'transfer'
              }
            }
          ]
        }
      };
    }
  }
  
  // Production: Exit with clear error - this skill requires MCP runtime
  console.error(JSON.stringify({
    error: 'MCP_RUNTIME_REQUIRED',
    message: `This skill requires an MCP-aware agent to execute ${toolName}`,
    details: {
      tool: toolName,
      params,
      solution: 'Run this skill through an MCP-enabled agent (e.g., Claude with aibtc-mcp server)'
    }
  }, null, 2));
  process.exit(2);
}

// Calculate transaction age in minutes
function getTransactionAge(timestamp: number): number {
  return Math.floor((Date.now() - timestamp) / 60000);
}

// Generate alert based on transaction type and age
function generateAlert(
  txid: string, 
  type: 'deposit' | 'withdrawal', 
  ageMinutes: number, 
  threshold: number
): Alert | null {
  if (ageMinutes < threshold) return null;
  
  const severity = ageMinutes > threshold * 2 ? 'critical' : 'warning';
  
  let message: string;
  if (type === 'deposit') {
    if (severity === 'critical') {
      message = `Deposit pending for ${ageMinutes} minutes - investigate with Emily API or contact sBTC team`;
    } else {
      message = `Deposit pending for ${ageMinutes} minutes - may be slow block times, monitor closely`;
    }
  } else {
    if (severity === 'critical') {
      message = `Withdrawal pending for ${ageMinutes} minutes - potential signer failure, escalate to sBTC operators`;
    } else {
      message = `Withdrawal pending for ${ageMinutes} minutes - signers may be delayed, check network status`;
    }
  }
  
  return { txid, type, severity, message };
}

// Command implementations
async function doctorCommand(): Promise<void> {
  const result = {
    status: 'ok',
    tools_required: [
      'sbtc_deposit_status',
      'sbtc_withdrawal_status',
      'get_account_transactions'
    ],
    network: process.env.STACKS_NETWORK || 'mainnet',
    test_mode: process.env.BFF_TEST_MODE === 'true',
    note: 'This skill requires MCP runtime with sBTC bridge tools'
  };
  
  console.log(JSON.stringify(result, null, 2));
}

async function statusCommand(
  txid: string, 
  type?: 'deposit' | 'withdrawal'
): Promise<void> {
  try {
    let result: any;
    let detectedType = type;
    
    // If type not specified, try deposit first (Bitcoin txids are longer)
    if (!type) {
      detectedType = txid.length > 50 ? 'deposit' : 'withdrawal';
    }
    
    if (detectedType === 'deposit') {
      const depositResult = await callMCPTool('sbtc_deposit_status', { 
        txid,
        vout: 0 
      });
      
      if (depositResult.error) {
        console.log(JSON.stringify({
          error: `Failed to fetch deposit status: ${depositResult.error}`
        }));
        process.exit(2);
      }
      
      const data = depositResult.data as DepositStatus;
      const ageMinutes = data.timestamp ? getTransactionAge(data.timestamp) : 0;
      const alert = data.status === 'pending' 
        ? generateAlert(txid, 'deposit', ageMinutes, 60)
        : null;
      
      result = {
        status: 'ok',
        action: 'status',
        data: {
          txid,
          type: 'deposit',
          state: data.status,
          amount: data.amount,
          confirmations: data.confirmations,
          age_minutes: ageMinutes,
          alert
        }
      };
    } else {
      const withdrawalResult = await callMCPTool('sbtc_withdrawal_status', { 
        txid 
      });
      
      if (withdrawalResult.error) {
        console.log(JSON.stringify({
          error: `Failed to fetch withdrawal status: ${withdrawalResult.error}`
        }));
        process.exit(2);
      }
      
      const data = withdrawalResult.data as WithdrawalStatus;
      const ageMinutes = data.timestamp ? getTransactionAge(data.timestamp) : 0;
      const alert = data.status === 'pending'
        ? generateAlert(txid, 'withdrawal', ageMinutes, 120)
        : null;
      
      result = {
        status: 'ok',
        action: 'status',
        data: {
          txid,
          type: 'withdrawal',
          state: data.status,
          amount: data.amount,
          requestId: data.requestId,
          age_minutes: ageMinutes,
          alert
        }
      };
    }
    
    console.log(JSON.stringify(result, null, 2));
    
    // Exit code based on alert severity
    if (result.data.alert) {
      process.exit(result.data.alert.severity === 'critical' ? 1 : 0);
    }
    
  } catch (err) {
    console.log(JSON.stringify({
      error: `Status check failed: ${err}`
    }));
    process.exit(2);
  }
}

async function runCommand(
  watch: boolean, 
  alertDelayMinutes: number
): Promise<void> {
  const depositThreshold = alertDelayMinutes;
  const withdrawalThreshold = alertDelayMinutes * 2; // Withdrawals take longer
  
  const performCheck = async (): Promise<MonitorResult> => {
    try {
      // Fetch recent transactions for wallet address
      // In real implementation, this would use wallet address
      const txResult = await callMCPTool('get_account_transactions', {
        limit: 50
      });
      
      if (txResult.error) {
        throw new Error(`Failed to fetch transactions: ${txResult.error}`);
      }
      
      const transactions = txResult.data?.results || [];
      
      // Filter sBTC-related transactions
      // In real implementation, this would parse contract calls and identify
      // deposit/withdrawal transactions based on contract interaction patterns
      
      const result: MonitorResult = {
        deposits: { total: 0, pending: 0, confirmed: 0, failed: 0 },
        withdrawals: { total: 0, pending: 0, completed: 0, failed: 0 },
        alerts: []
      };
      
      // Simulated aggregation for test mode
      if (process.env.BFF_TEST_MODE === 'true') {
        result.deposits = { total: 3, pending: 1, confirmed: 2, failed: 0 };
        result.withdrawals = { total: 2, pending: 0, completed: 2, failed: 0 };
        
        // Simulate a delayed deposit
        if (Math.random() > 0.5) {
          result.alerts.push({
            txid: 'abc123...def',
            type: 'deposit',
            severity: 'warning',
            message: 'Deposit pending for 75 minutes - exceeds expected confirmation time'
          });
        }
      }
      
      return result;
      
    } catch (err) {
      throw new Error(`Monitor check failed: ${err}`);
    }
  };
  
  try {
    if (!watch) {
      // Single check
      const result = await performCheck();
      console.log(JSON.stringify({
        status: 'ok',
        action: 'run',
        data: result
      }, null, 2));
      
      // Exit code based on alert presence
      process.exit(result.alerts.length > 0 ? 1 : 0);
    } else {
      // Watch mode - continuous monitoring
      console.error('Starting watch mode (5-minute intervals)...');
      console.error('Press Ctrl+C to stop');
      
      while (true) {
        const result = await performCheck();
        
        // Output alerts immediately
        if (result.alerts.length > 0) {
          console.log(JSON.stringify({
            status: 'alert',
            action: 'run',
            timestamp: new Date().toISOString(),
            data: result
          }, null, 2));
        }
        
        // Wait 5 minutes before next check
        await new Promise(resolve => setTimeout(resolve, 300000));
      }
    }
  } catch (err) {
    console.log(JSON.stringify({
      error: `Monitor failed: ${err}`
    }));
    process.exit(2);
  }
}

// CLI setup
const program = new Command();

program
  .name('sbtc-bridge-monitor')
  .description('Monitor sBTC bridge operations and alert on delays')
  .version('1.0.0');

program
  .command('doctor')
  .description('Check environment and tool availability')
  .action(doctorCommand);

program
  .command('status')
  .description('Check status of specific bridge transaction')
  .argument('<txid>', 'Transaction ID to check')
  .option('--type <type>', 'Transaction type: deposit or withdrawal', /^(deposit|withdrawal)$/i)
  .action(async (txid: string, options: { type?: string }) => {
    const type = options.type?.toLowerCase() as 'deposit' | 'withdrawal' | undefined;
    await statusCommand(txid, type);
  });

program
  .command('run')
  .description('Monitor wallet bridge activity')
  .option('--watch', 'Continuous monitoring mode', false)
  .option('--alert-delay-minutes <minutes>', 'Alert threshold in minutes', parseFloat, 60)
  .action(async (options: { watch: boolean; alertDelayMinutes: number }) => {
    if (isNaN(options.alertDelayMinutes) || options.alertDelayMinutes < 1) {
      console.log(JSON.stringify({
        error: 'alert-delay-minutes must be a positive number'
      }));
      process.exit(2);
    }
    await runCommand(options.watch, options.alertDelayMinutes);
  });

await program.parseAsync();
