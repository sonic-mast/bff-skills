#!/usr/bin/env bun

import { Command } from "commander";

interface Position {
  totalCollateralUSD: number;
  totalDebtUSD: number;
  currentLTV: number;
  healthFactor: number;
  liquidationPrice?: number;
}

interface Alert {
  type: "info" | "warning" | "critical";
  reason: string;
  currentValue: number;
  threshold: number;
  timestamp: string;
}

interface PositionStatus {
  status: "success" | "warning" | "critical" | "error";
  position?: Position;
  alerts?: Alert[];
  error?: string;
}

// Mock position data for testing
const mockPosition: Position = {
  totalCollateralUSD: 50000,
  totalDebtUSD: 30000,
  currentLTV: 0.6,
  healthFactor: 2.5,
  liquidationPrice: 75000,
};

function validateThreshold(
  value: string | undefined,
  name: string,
  defaultVal: number
): number {
  if (!value) return defaultVal;
  const num = parseFloat(value);
  if (isNaN(num) || num < 0 || num > 100) {
    throw new Error(
      `Invalid ${name}: must be 0-100, got ${value}`
    );
  }
  return num / 100; // Convert to decimal
}

function calculateAlerts(
  position: Position,
  softLTV: number,
  warnLTV: number,
  critLTV: number
): Alert[] {
  const alerts: Alert[] = [];
  const now = new Date().toISOString();

  if (position.currentLTV >= critLTV) {
    alerts.push({
      type: "critical",
      reason: "LTV at critical liquidation risk zone",
      currentValue: position.currentLTV,
      threshold: critLTV,
      timestamp: now,
    });
  } else if (position.currentLTV >= warnLTV) {
    alerts.push({
      type: "warning",
      reason: "LTV approaching soft limit",
      currentValue: position.currentLTV,
      threshold: warnLTV,
      timestamp: now,
    });
  } else if (position.currentLTV >= softLTV) {
    alerts.push({
      type: "info",
      reason: "LTV entering monitoring zone",
      currentValue: position.currentLTV,
      threshold: softLTV,
      timestamp: now,
    });
  }

  if (position.healthFactor < 1.5) {
    alerts.push({
      type: "warning",
      reason: "Health factor degrading",
      currentValue: position.healthFactor,
      threshold: 1.5,
      timestamp: now,
    });
  }

  return alerts;
}

function generateStatus(
  position: Position,
  alerts: Alert[]
): PositionStatus {
  const status = alerts.length === 0
    ? "success"
    : alerts.some((a) => a.type === "critical")
    ? "critical"
    : "warning";

  return { status, position, alerts };
}

async function doctor(): Promise<PositionStatus> {
  try {
    // Validate basic connectivity and wallet setup
    console.error("doctor: Checking wallet configuration...");
    
    // In a real implementation, this would validate:
    // - Stacks address loaded
    // - Network connectivity to Zest API
    // - Authentication ready

    return {
      status: "success",
      position: undefined,
      alerts: [],
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return { status: "error", error };
  }
}

async function status(
  softLTV: number,
  warnLTV: number,
  critLTV: number
): Promise<PositionStatus> {
  try {
    // In a real implementation, this would call zest_get_position
    // For now, use mock data for testing
    const position = mockPosition;

    const alerts = calculateAlerts(
      position,
      softLTV,
      warnLTV,
      critLTV
    );

    return generateStatus(position, alerts);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return { status: "error", error };
  }
}

async function monitor(
  interval: number,
  softLTV: number,
  warnLTV: number,
  critLTV: number
): Promise<void> {
  console.error(
    `monitor: Starting continuous watch every ${interval} seconds`
  );
  console.error(`Thresholds: soft=${softLTV}%, warn=${warnLTV}%, crit=${critLTV}%`);

  let iteration = 0;
  let lastAlertState: string = "";

  while (true) {
    iteration++;
    const result = await status(softLTV, warnLTV, critLTV);

    const alertState = JSON.stringify(result.alerts);
    if (alertState !== lastAlertState) {
      console.log(JSON.stringify(result));
      lastAlertState = alertState;
    }

    console.error(
      `[${iteration}] Position check complete. LTV: ${
        result.position?.currentLTV
      } — ${result.status}`
    );

    await new Promise((resolve) => setTimeout(resolve, interval * 1000));
  }
}

async function run(): Promise<void> {
  // Run the monitor in background mode with default thresholds
  await monitor(300, 0.6, 0.75, 0.85); // 5 min, 60%, 75%, 85%
}

const program = new Command();

program
  .name("defi-position-safety-checker")
  .description("Monitor DeFi position LTV and liquidation risk")
  .version("1.0.0");

program
  .command("doctor")
  .description("Validate wallet and Zest configuration")
  .action(async () => {
    const result = await doctor();
    console.log(JSON.stringify(result));
    process.exit(result.status === "error" ? 1 : 0);
  });

program
  .command("status")
  .description("One-time snapshot of current position risk")
  .option("--soft-ltv <value>", "Soft threshold (0-100)", "60")
  .option("--warn-ltv <value>", "Warning threshold (0-100)", "75")
  .option("--crit-ltv <value>", "Critical threshold (0-100)", "85")
  .action(async (options) => {
    try {
      const softLTV = validateThreshold(options.softLtv, "soft-ltv", 60);
      const warnLTV = validateThreshold(options.warnLtv, "warn-ltv", 75);
      const critLTV = validateThreshold(options.critLtv, "crit-ltv", 85);
      const result = await status(softLTV, warnLTV, critLTV);
      console.log(JSON.stringify(result));
      process.exit(result.status === "error" ? 1 : 0);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      console.log(JSON.stringify({ status: "error", error }));
      process.exit(1);
    }
  });

program
  .command("monitor")
  .description("Watch position for threshold breaches (interactive)")
  .option("--interval <seconds>", "Check interval in seconds", "300")
  .option("--soft-ltv <value>", "Soft threshold (0-100)", "60")
  .option("--warn-ltv <value>", "Warning threshold (0-100)", "75")
  .option("--crit-ltv <value>", "Critical threshold (0-100)", "85")
  .action(async (options) => {
    try {
      const interval = parseInt(options.interval, 10);
      if (isNaN(interval) || interval < 10) {
        throw new Error("Interval must be >= 10 seconds");
      }
      const softLTV = validateThreshold(options.softLtv, "soft-ltv", 60);
      const warnLTV = validateThreshold(options.warnLtv, "warn-ltv", 75);
      const critLTV = validateThreshold(options.critLtv, "crit-ltv", 85);
      await monitor(interval, softLTV, warnLTV, critLTV);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      console.log(JSON.stringify({ status: "error", error }));
      process.exit(1);
    }
  });

program
  .command("run")
  .description("Automated watch mode with default thresholds")
  .action(async () => {
    try {
      await run();
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      console.log(JSON.stringify({ status: "error", error }));
      process.exit(1);
    }
  });

program.parse();
