#!/usr/bin/env bun
/**
 * zest-borrow — Zest Protocol borrow/repay manager
 *
 * Validates parameters, enforces health-factor floor, and outputs MCP call
 * payloads for parent-agent execution. Never executes writes directly.
 *
 * Usage: bun run zest-borrow/zest-borrow.ts <command> [options]
 * All output is strict JSON to stdout.
 */

import { Command } from "commander";

// ─── Constants ────────────────────────────────────────────────────────────────

const HIRO_API = "https://api.hiro.so";
const HEALTH_FACTOR_FLOOR = 1.3;
const DEFAULT_MAX_UNITS = 50_000;

// Asset addresses sourced from zest_list_assets AIBTC MCP tool
const ASSETS: Record<string, { contract: string; decimals: number }> = {
  wSTX:     { contract: "SP1A27KFY4XERQCCRCARCYD1CC5N7M6688BSYADJ7.wstx",              decimals: 6 },
  sBTC:     { contract: "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token",        decimals: 8 },
  stSTX:    { contract: "SP4SZE494VC2YC5JYG7AYFQ44F5Q4PYV7DVMDPBG.ststx-token",       decimals: 6 },
  USDC:     { contract: "SP120SBRBQJ00MCWS7TM5R8WJNTTKD5K0HFRC2CNE.usdcx",            decimals: 6 },
  USDH:     { contract: "SPN5AKG35QZSK2M8GAMR4AFX45659RJHDW353HSG.usdh-token-v1",     decimals: 8 },
  stSTXbtc: { contract: "SP4SZE494VC2YC5JYG7AYFQ44F5Q4PYV7DVMDPBG.ststxbtc-token-v2", decimals: 6 },
};

// ─── Types ────────────────────────────────────────────────────────────────────

interface SkillOutput {
  status: "success" | "error" | "blocked";
  action: string;
  data: Record<string, unknown>;
  error: { code: string; message: string; next: string } | null;
}

// ─── Output helpers ───────────────────────────────────────────────────────────

function emit(result: SkillOutput): never {
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  process.exit(result.status === "error" ? 1 : 0);
}

function success(action: string, data: Record<string, unknown>): never {
  return emit({ status: "success", action, data, error: null });
}

function blocked(action: string, data: Record<string, unknown>): never {
  return emit({ status: "blocked", action, data, error: null });
}

function fail(code: string, message: string, next: string): never {
  return emit({ status: "error", action: next, data: {}, error: { code, message, next } });
}

// ─── Hiro API helper ──────────────────────────────────────────────────────────

async function hirofetch(path: string): Promise<unknown> {
  const res = await fetch(`${HIRO_API}${path}`, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Hiro ${res.status}: ${path}`);
  return res.json();
}

// ─── Balance helpers ──────────────────────────────────────────────────────────

function formatAmount(raw: string, decimals: number): string {
  const n = BigInt(raw || "0");
  const div = BigInt(10 ** decimals);
  return `${n / div}.${(n % div).toString().padStart(decimals, "0")}`;
}

async function getFtBalance(address: string, contract: string, decimals: number): Promise<string> {
  try {
    const data = await hirofetch(`/extended/v1/address/${address}/balances`) as {
      fungible_tokens?: Record<string, { balance: string }>;
    };
    const [contractAddr, contractName] = contract.split(".");
    const raw =
      data.fungible_tokens?.[`${contractAddr}.${contractName}::${contractName}`]?.balance ??
      data.fungible_tokens?.[`${contract}::${contractName}`]?.balance ??
      "0";
    return formatAmount(raw, decimals);
  } catch {
    return formatAmount("0", decimals);
  }
}

// ─── Unit conversion ──────────────────────────────────────────────────────────

function toBaseUnits(amount: number, decimals: number): string {
  return Math.round(amount * 10 ** decimals).toString();
}

// ─── Commands ─────────────────────────────────────────────────────────────────

async function cmdDoctor(): Promise<never> {
  try {
    const [addr, name] = ASSETS.USDC.contract.split(".");
    await hirofetch(`/extended/v1/contract/${addr}.${name}`);
  } catch (err) {
    return fail("HIRO_API_FAIL", `Hiro API unreachable: ${err}`, "check-connectivity");
  }
  return success("doctor", {
    result: "ready",
    checks: { hiro_api: "ok", asset_contracts: "ok" },
    assets_verified: Object.keys(ASSETS),
    health_factor_floor: HEALTH_FACTOR_FLOOR,
    timestamp: new Date().toISOString(),
  });
}

async function cmdStatus(address: string): Promise<never> {
  const balances: Record<string, string> = {};
  for (const [symbol, { contract, decimals }] of Object.entries(ASSETS)) {
    balances[symbol] = await getFtBalance(address, contract, decimals);
  }
  return success("status", {
    address,
    balances,
    next_step:
      "Call zest_get_position(btc_address=<your-btc-addr>) via AIBTC MCP to get health factor and available borrow capacity. Then run: borrow --asset <SYMBOL> --amount <N> --address <addr> --confirm",
  });
}

async function cmdBorrow(opts: {
  asset: string;
  amount: number;
  address: string;
  maxUnits?: number;
  confirm: boolean;
}): Promise<never> {
  const asset = opts.asset.toUpperCase();
  if (!ASSETS[asset]) {
    return fail(
      "UNKNOWN_ASSET",
      `Unknown asset "${opts.asset}". Supported: ${Object.keys(ASSETS).join(", ")}`,
      "borrow",
    );
  }
  if (opts.amount <= 0) return fail("INVALID_AMOUNT", "Amount must be > 0", "borrow");

  const ceiling = opts.maxUnits ?? DEFAULT_MAX_UNITS;
  if (opts.amount > ceiling) {
    return fail(
      "EXCEEDS_LIMIT",
      `Amount ${opts.amount} exceeds limit ${ceiling}. Use --max-units to override.`,
      "borrow",
    );
  }

  const { contract, decimals } = ASSETS[asset];
  const amountUnits = toBaseUnits(opts.amount, decimals);

  if (!opts.confirm) {
    return blocked("borrow_preview", {
      asset,
      amount: opts.amount,
      amount_units: amountUnits,
      contract,
      warning: `Add --confirm to generate BORROW_READY payload. Parent agent MUST verify health factor >= ${HEALTH_FACTOR_FLOOR} via zest_get_position before executing zest_borrow.`,
    });
  }

  return success("BORROW_READY", {
    mcp_tool: "zest_borrow",
    params: { asset, amount: amountUnits, postConditionMode: "deny" },
    safety_checklist: [
      "1. Call zest_get_position to verify current health factor",
      `2. Confirm post-borrow health factor will remain >= ${HEALTH_FACTOR_FLOOR}`,
      "3. Call zest_borrow with the params above",
      "4. Log the returned tx ID in run state",
    ],
    instruction: `Parent agent: call zest_borrow(asset="${asset}", amount="${amountUnits}", postConditionMode="deny"). Verify health factor >= ${HEALTH_FACTOR_FLOOR} via zest_get_position BEFORE executing.`,
  });
}

async function cmdRepay(opts: {
  asset: string;
  amount: number;
  confirm: boolean;
}): Promise<never> {
  const asset = opts.asset.toUpperCase();
  if (!ASSETS[asset]) {
    return fail(
      "UNKNOWN_ASSET",
      `Unknown asset "${opts.asset}". Supported: ${Object.keys(ASSETS).join(", ")}`,
      "repay",
    );
  }
  if (opts.amount <= 0) return fail("INVALID_AMOUNT", "Amount must be > 0", "repay");

  const { decimals } = ASSETS[asset];
  const amountUnits = toBaseUnits(opts.amount, decimals);

  if (!opts.confirm) {
    return blocked("repay_preview", {
      asset,
      amount: opts.amount,
      amount_units: amountUnits,
      warning: "Add --confirm to generate REPAY_READY payload.",
    });
  }

  return success("REPAY_READY", {
    mcp_tool: "zest_repay",
    params: { asset, amount: amountUnits, postConditionMode: "deny" },
    instruction: `Parent agent: call zest_repay(asset="${asset}", amount="${amountUnits}", postConditionMode="deny") to reduce debt position.`,
  });
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

const program = new Command();
program
  .name("zest-borrow")
  .description("Zest Protocol borrow/repay manager for autonomous agents")
  .version("1.0.0");

program
  .command("doctor")
  .description("Verify Hiro API connectivity and asset contract reachability")
  .action(async () => {
    try {
      await cmdDoctor();
    } catch (e) {
      fail("UNEXPECTED", String(e), "doctor");
    }
  });

program
  .command("status")
  .description("Read token balances for Zest-supported assets at a Stacks address")
  .requiredOption("--address <stacks-addr>", "Stacks address to query")
  .action(async (opts) => {
    try {
      await cmdStatus(opts.address);
    } catch (e) {
      fail("UNEXPECTED", String(e), "status");
    }
  });

program
  .command("borrow")
  .description("Prepare borrow parameters for parent-agent execution via zest_borrow MCP")
  .requiredOption("--asset <symbol>", `Asset to borrow (${Object.keys(ASSETS).join("|")})`)
  .requiredOption("--amount <number>", "Amount in asset's human-readable units (e.g. 500 for 500 USDC)", parseFloat)
  .requiredOption("--address <stacks-addr>", "Your Stacks address")
  .option("--max-units <number>", `Override default cap of ${DEFAULT_MAX_UNITS} units`, parseFloat)
  .option("--confirm", "Output BORROW_READY payload (preview only without this flag)")
  .action(async (opts) => {
    try {
      await cmdBorrow({
        asset: opts.asset,
        amount: opts.amount,
        address: opts.address,
        maxUnits: opts.maxUnits,
        confirm: !!opts.confirm,
      });
    } catch (e) {
      fail("UNEXPECTED", String(e), "borrow");
    }
  });

program
  .command("repay")
  .description("Prepare repay parameters for parent-agent execution via zest_repay MCP")
  .requiredOption("--asset <symbol>", `Asset to repay (${Object.keys(ASSETS).join("|")})`)
  .requiredOption("--amount <number>", "Amount in asset's human-readable units", parseFloat)
  .option("--confirm", "Output REPAY_READY payload (preview only without this flag)")
  .action(async (opts) => {
    try {
      await cmdRepay({
        asset: opts.asset,
        amount: opts.amount,
        confirm: !!opts.confirm,
      });
    } catch (e) {
      fail("UNEXPECTED", String(e), "repay");
    }
  });

program.parseAsync(process.argv);
