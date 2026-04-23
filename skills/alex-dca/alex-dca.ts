#!/usr/bin/env bun
/**
 * ALEX DCA — Dollar Cost Averaging on ALEX DEX (Stacks mainnet)
 *
 * The agent IS the scheduler. Each `run` call executes one order when due.
 * No Keeper contracts or third-party scheduling required.
 *
 * Usage: bun run alex-dca/alex-dca.ts <command> [options]
 *
 * All commands emit strict JSON to stdout. Debug goes to stderr.
 */

import { Command } from "commander";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as crypto from "crypto";

// ─── Constants ────────────────────────────────────────────────────────────────

const ALEX_DCA_DIR = path.join(os.homedir(), ".aibtc", "alex-dca");
const WALLETS_FILE = path.join(os.homedir(), ".aibtc", "wallets.json");
const WALLETS_DIR  = path.join(os.homedir(), ".aibtc", "wallets");
const STACKS_API   = "https://api.hiro.so";
const EXPLORER_BASE = "https://explorer.hiro.so/txid";
const ALEX_API     = "https://api.alexgo.io";

const FREQUENCIES: Record<string, number> = {
  hourly:   3600,
  daily:    86400,
  weekly:   604800,
  biweekly: 1209600,
};

// Hard limits — thrown as errors, not suggestions
const MAX_SLIPPAGE_PCT = 10;
const MAX_ORDERS       = 100;

// ALEX token symbol → SDK currency ID mapping
// Currency IDs from @alexgo-io/alex-sdk
const SYMBOL_TO_CURRENCY: Record<string, string> = {
  STX:   "token-wstx",
  ALEX:  "token-alex",
  ABTC:  "token-wbtc",   // ALEX-wrapped BTC
  SUSDT: "token-susdt",  // Stacks USDT
  DIKO:  "token-diko",
  WELSH: "token-welsh",
  VXBTC: "token-vxbtc",
};

// Decimal places per token
const TOKEN_DECIMALS: Record<string, number> = {
  "token-wstx":  6,
  "token-alex":  8,
  "token-wbtc":  8,
  "token-susdt": 8,
  "token-diko":  6,
  "token-welsh": 6,
  "token-vxbtc": 8,
};

// ─── Types ────────────────────────────────────────────────────────────────────

interface OrderLog {
  orderIndex: number;
  status: "completed" | "failed" | "dry-run";
  scheduledAt: number;
  executedAt: number;
  amountInHuman: number;
  amountOutHuman: number | null;
  txId: string | null;
  explorerUrl: string | null;
  quoteAtExecution: number | null;
  errorMessage: string | null;
}

interface AlexDcaPlan {
  planId: string;
  createdAt: number;
  status: "pending" | "active" | "completed" | "cancelled";
  currencyIn: string;
  currencyOut: string;
  tokenInSymbol: string;
  tokenOutSymbol: string;
  tokenInDecimals: number;
  tokenOutDecimals: number;
  totalAmountHuman: number;
  ordersTotal: number;
  orderSizeHuman: number;
  frequencyLabel: string;
  frequencySeconds: number;
  slippagePct: number;
  walletAddress: string;
  startAt: number;
  nextOrderAt: number;
  ordersCompleted: number;
  totalSpentHuman: number;
  totalReceivedHuman: number;
  orderLog: OrderLog[];
}

interface SkillOutput {
  status: "success" | "error" | "blocked";
  action: string;
  data: Record<string, unknown>;
  error: { code: string; message: string; next: string } | null;
}

// ─── Output helpers ───────────────────────────────────────────────────────────

function out(result: SkillOutput): void {
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
}

function success(action: string, data: Record<string, unknown>): void {
  out({ status: "success", action, data, error: null });
}

function blocked(action: string, data: Record<string, unknown>): void {
  out({ status: "blocked", action, data, error: null });
}

function fail(code: string, message: string, next: string, data: Record<string, unknown> = {}): void {
  out({ status: "error", action: next, data, error: { code, message, next } });
}

// ─── Formatting helpers ───────────────────────────────────────────────────────

function fmtNum(n: number, decimals = 6): string {
  if (n === 0) return "0";
  if (n < 0.000001) return n.toExponential(4);
  return n.toLocaleString("en-US", { maximumFractionDigits: decimals, minimumFractionDigits: 0 });
}

function fmtDuration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86400) return `${(seconds / 3600).toFixed(1)}h`;
  return `${(seconds / 86400).toFixed(1)}d`;
}

function fmtTimeLeft(targetMs: number): string {
  const diff = targetMs - Date.now();
  if (diff <= 0) return "ready now";
  return "in " + fmtDuration(diff / 1000);
}

function fmtDate(epochMs: number): string {
  return new Date(epochMs).toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

function humanToMicro(amount: number, decimals: number): bigint {
  return BigInt(Math.round(amount * Math.pow(10, decimals)));
}

function microToHuman(amount: bigint | number, decimals: number): number {
  return Number(amount) / Math.pow(10, decimals);
}

// ─── Plan file helpers ────────────────────────────────────────────────────────

function ensurePlanDir(): void {
  if (!fs.existsSync(ALEX_DCA_DIR)) fs.mkdirSync(ALEX_DCA_DIR, { recursive: true });
}

function listPlans(): AlexDcaPlan[] {
  ensurePlanDir();
  return fs.readdirSync(ALEX_DCA_DIR)
    .filter(f => f.endsWith(".json"))
    .map(f => {
      try { return JSON.parse(fs.readFileSync(path.join(ALEX_DCA_DIR, f), "utf-8")) as AlexDcaPlan; }
      catch { return null; }
    })
    .filter(Boolean) as AlexDcaPlan[];
}

function loadPlan(planId: string): AlexDcaPlan | null {
  const p = path.join(ALEX_DCA_DIR, `${planId}.json`);
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, "utf-8")) as AlexDcaPlan; }
  catch { return null; }
}

function savePlan(plan: AlexDcaPlan): void {
  ensurePlanDir();
  fs.writeFileSync(path.join(ALEX_DCA_DIR, `${plan.planId}.json`), JSON.stringify(plan, null, 2));
}

// ─── Token helpers ────────────────────────────────────────────────────────────

function resolveToken(symbol: string): { currencyId: string; decimals: number } | null {
  const upper = symbol.toUpperCase();
  const currencyId = SYMBOL_TO_CURRENCY[upper];
  if (!currencyId) return null;
  const decimals = TOKEN_DECIMALS[currencyId] ?? 6;
  return { currencyId, decimals };
}

// ─── Wallet helpers ───────────────────────────────────────────────────────────

function walletExists(): boolean {
  return fs.existsSync(WALLETS_FILE) || fs.existsSync(path.join(os.homedir(), ".aibtc", "wallet.json"));
}

async function decryptAibtcKeystore(enc: any, password: string): Promise<string> {
  const { scryptSync, createDecipheriv } = await import("crypto" as any);
  const { N, r, p, keyLen } = enc.scryptParams;
  const salt       = Buffer.from(enc.salt, "base64");
  const iv         = Buffer.from(enc.iv, "base64");
  const authTag    = Buffer.from(enc.authTag, "base64");
  const ciphertext = Buffer.from(enc.ciphertext, "base64");
  const key = scryptSync(password, salt, keyLen ?? 32, { N, r, p });
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return decrypted.toString("utf-8").trim();
}

async function getWalletKeys(password: string): Promise<{ stxPrivateKey: string; stxAddress: string }> {
  if (process.env.STACKS_PRIVATE_KEY) {
    const { getAddressFromPrivateKey, TransactionVersion } = await import("@stacks/transactions" as any);
    const key = process.env.STACKS_PRIVATE_KEY;
    const address = getAddressFromPrivateKey(key, TransactionVersion.Mainnet);
    return { stxPrivateKey: key, stxAddress: address };
  }

  const { generateWallet, deriveAccount, getStxAddress } = await import("@stacks/wallet-sdk" as any);

  if (fs.existsSync(WALLETS_FILE)) {
    try {
      const walletsJson = JSON.parse(fs.readFileSync(WALLETS_FILE, "utf-8"));
      const activeWallet = (walletsJson.wallets ?? [])[0];
      if (activeWallet?.id) {
        const keystorePath = path.join(WALLETS_DIR, activeWallet.id, "keystore.json");
        if (fs.existsSync(keystorePath)) {
          const keystore = JSON.parse(fs.readFileSync(keystorePath, "utf-8"));
          const enc = keystore.encrypted;
          if (enc?.ciphertext) {
            const mnemonic = await decryptAibtcKeystore(enc, password);
            const wallet   = await generateWallet({ secretKey: mnemonic, password: "" });
            const account  = wallet.accounts[0] ?? deriveAccount(wallet, 0);
            return { stxPrivateKey: account.stxPrivateKey, stxAddress: getStxAddress(account) };
          }
          const legacyEnc = keystore.encryptedMnemonic ?? keystore.encrypted_mnemonic;
          if (legacyEnc) {
            const { decryptMnemonic } = await import("@stacks/encryption" as any);
            const mnemonic = await decryptMnemonic(legacyEnc, password);
            const wallet   = await generateWallet({ secretKey: mnemonic, password: "" });
            const account  = wallet.accounts[0] ?? deriveAccount(wallet, 0);
            return { stxPrivateKey: account.stxPrivateKey, stxAddress: getStxAddress(account) };
          }
        }
      }
    } catch (e: any) {
      process.stderr.write(`Wallet decrypt error: ${e.message}\n`);
    }
  }

  const legacyPath = path.join(os.homedir(), ".aibtc", "wallet.json");
  if (fs.existsSync(legacyPath)) {
    try {
      const w        = JSON.parse(fs.readFileSync(legacyPath, "utf-8"));
      const mnemonic = w.mnemonic ?? w.encrypted_mnemonic ?? w.encryptedMnemonic;
      if (mnemonic) {
        const wallet  = await generateWallet({ secretKey: mnemonic, password });
        const account = deriveAccount(wallet, 0);
        return { stxPrivateKey: account.stxPrivateKey, stxAddress: getStxAddress(account) };
      }
    } catch { /* fall through */ }
  }

  throw new Error(
    "No wallet found or decryption failed.\n" +
    "Options:\n" +
    "  1. Run: npx @aibtc/mcp-server@latest --install\n" +
    "  2. Set STACKS_PRIVATE_KEY env var for direct key access"
  );
}

async function getStxBalance(address: string): Promise<number> {
  const res = await fetch(`${STACKS_API}/v2/accounts/${address}?proof=0`, {
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Balance fetch failed: ${res.status}`);
  const data = await res.json() as { balance: string };
  return parseInt(data.balance, 16);
}

// ─── ALEX SDK helpers ─────────────────────────────────────────────────────────

async function getAlexSDK(): Promise<any> {
  const { AlexSDK } = await import("@alexgo-io/alex-sdk" as any);
  return new AlexSDK();
}

async function fetchAlexQuote(
  currencyIn: string,
  amountInHuman: number,
  tokenInDecimals: number,
  currencyOut: string,
  tokenOutDecimals: number
): Promise<{ amountOutHuman: number } | null> {
  try {
    const sdk = await getAlexSDK();
    const amountInMicro = humanToMicro(amountInHuman, tokenInDecimals);
    const amountOutMicro: bigint = await sdk.getAmountTo(currencyIn, amountInMicro, currencyOut);
    return { amountOutHuman: microToHuman(amountOutMicro, tokenOutDecimals) };
  } catch {
    return null;
  }
}

/**
 * Build a minimal StacksProvider for CLI use.
 * ALEX SDK calls openContractCall with the prepared contract call options;
 * this provider signs and broadcasts it using our private key.
 */
function createCLIProvider(stxPrivateKey: string): any {
  return {
    openContractCall: async (options: any): Promise<string> => {
      const {
        makeContractCall, broadcastTransaction, PostConditionMode, AnchorMode,
      } = await import("@stacks/transactions" as any);
      const { STACKS_MAINNET } = await import("@stacks/network" as any);

      const tx = await makeContractCall({
        contractAddress:  options.contractAddress,
        contractName:     options.contractName,
        functionName:     options.functionName,
        functionArgs:     options.functionArgs,
        postConditions:   options.postConditions ?? [],
        postConditionMode: PostConditionMode.Deny,
        network:          STACKS_MAINNET,
        senderKey:        stxPrivateKey,
        anchorMode:       AnchorMode.Any,
        fee:              10000n,
      });

      const result = await broadcastTransaction({ transaction: tx, network: STACKS_MAINNET });
      if ((result as any).error) {
        throw new Error(`Broadcast failed: ${(result as any).error} — ${(result as any).reason ?? ""}`);
      }
      return (result as any).txid as string;
    },
    getProductInfo: () => ({ version: "1.0", name: "alex-dca-cli" }),
  };
}

async function executeAlexSwap(opts: {
  currencyIn: string;
  currencyOut: string;
  tokenInDecimals: number;
  tokenOutDecimals: number;
  amountHuman: number;
  slippagePct: number;
  senderAddress: string;
  stxPrivateKey: string;
  dryRun: boolean;
}): Promise<{ txId: string; explorerUrl: string; amountOutHuman: number }> {
  if (opts.dryRun) {
    const fakeTxId = "dry-run-" + crypto.randomBytes(8).toString("hex");
    const quote = await fetchAlexQuote(
      opts.currencyIn, opts.amountHuman, opts.tokenInDecimals,
      opts.currencyOut, opts.tokenOutDecimals
    );
    return {
      txId: fakeTxId,
      explorerUrl: `${EXPLORER_BASE}/${fakeTxId}?chain=mainnet`,
      amountOutHuman: quote?.amountOutHuman ?? 0,
    };
  }

  const sdk = await getAlexSDK();
  const amountInMicro  = humanToMicro(opts.amountHuman, opts.tokenInDecimals);
  const amountOutMicro = await sdk.getAmountTo(opts.currencyIn, amountInMicro, opts.currencyOut) as bigint;
  const slippageBasisPoints = Math.round((100 - opts.slippagePct) * 100);
  const minOutMicro         = amountOutMicro * BigInt(slippageBasisPoints) / 10000n;
  const amountOutHuman = microToHuman(amountOutMicro, opts.tokenOutDecimals);

  const provider = createCLIProvider(opts.stxPrivateKey);
  const txId: string = await sdk.runSwap(
    opts.senderAddress,
    opts.currencyIn,
    opts.currencyOut,
    amountInMicro,
    minOutMicro,
    provider
  );

  return {
    txId,
    explorerUrl: `${EXPLORER_BASE}/${txId}?chain=mainnet`,
    amountOutHuman,
  };
}

// ─── Stats helpers ────────────────────────────────────────────────────────────

function calcAvgEntryPrice(plan: AlexDcaPlan): number | null {
  const done = plan.orderLog.filter(o => o.status === "completed" || o.status === "dry-run");
  if (done.length === 0) return null;
  const totalIn  = done.reduce((s, o) => s + o.amountInHuman, 0);
  const totalOut = done.reduce((s, o) => s + (o.amountOutHuman ?? 0), 0);
  if (totalOut === 0) return null;
  return totalIn / totalOut;
}

// ─── Telegram builders ────────────────────────────────────────────────────────

function telegramStatus(plan: AlexDcaPlan): string {
  const pct = plan.ordersTotal > 0 ? Math.round((plan.ordersCompleted / plan.ordersTotal) * 100) : 0;
  const bar  = "▓".repeat(Math.round(pct / 10)) + "░".repeat(10 - Math.round(pct / 10));
  const avg  = calcAvgEntryPrice(plan);

  const statusEmoji: Record<string, string> = {
    pending: "⏳", active: "🔄", completed: "✅", cancelled: "❌",
  };

  const avgHuman = avg !== null && avg > 0
    ? `${fmtNum(plan.orderSizeHuman / avg, 4)} ${plan.tokenOutSymbol} per ${fmtNum(plan.orderSizeHuman)} ${plan.tokenInSymbol}`
    : null;

  const done = plan.orderLog.filter(
    o => (o.status === "completed" || o.status === "dry-run") && o.amountOutHuman
  );
  const ordersLeft = plan.ordersTotal - plan.ordersCompleted;
  const freqMs: Record<string, number> = {
    hourly: 3600000, daily: 86400000, weekly: 604800000, biweekly: 1209600000,
  };
  const msLeft   = ordersLeft * (freqMs[plan.frequencyLabel] ?? 86400000);
  const daysLeft = msLeft / 86400000;
  const etaLabel = plan.status === "active" && ordersLeft > 0
    ? daysLeft < 1 ? "< 1 day remaining" : `~${Math.ceil(daysLeft)} day${daysLeft > 1 ? "s" : ""} remaining`
    : null;

  const orderLines = done.slice(-5).map((o, i) => {
    const idx = done.length > 5 ? done.length - 5 + i + 1 : i + 1;
    return `  ${idx}. ${fmtNum(o.amountInHuman, 6)} ${plan.tokenInSymbol} → ${fmtNum(o.amountOutHuman ?? 0, 4)} ${plan.tokenOutSymbol}`;
  });

  const lines = [
    `${statusEmoji[plan.status] ?? "📊"} *ALEX DCA — ${plan.tokenInSymbol} → ${plan.tokenOutSymbol}*`,
    `\`${plan.planId.slice(0, 16)}\``,
    ``,
    `📊 ${bar} ${pct}%`,
    `• Orders: ${plan.ordersCompleted}/${plan.ordersTotal} complete`,
    `• Spent: ${fmtNum(plan.totalSpentHuman, 6)} ${plan.tokenInSymbol}`,
    `• Received: ${fmtNum(plan.totalReceivedHuman, 4)} ${plan.tokenOutSymbol}`,
    avgHuman !== null ? `• Avg price: ${avgHuman}` : "",
    etaLabel !== null ? `• ETA: ${etaLabel}` : "",
    ``,
    orderLines.length > 0 ? `📋 *Orders (last ${orderLines.length}):*` : "",
    ...orderLines,
    ``,
    `⚙️ ${plan.frequencyLabel} · ${fmtNum(plan.orderSizeHuman)} ${plan.tokenInSymbol}/order · ${plan.slippagePct}% slippage`,
    plan.status === "active"
      ? `⏳ Next order: ${fmtTimeLeft(plan.nextOrderAt)} (${fmtDate(plan.nextOrderAt)})`
      : plan.status === "completed"
        ? `🏁 All ${plan.ordersTotal} orders complete`
        : plan.status === "cancelled"
          ? `❌ Cancelled — ${plan.ordersTotal - plan.ordersCompleted} orders skipped`
          : `⏳ Not yet started`,
  ];

  return lines.filter(l => l !== "").join("\n");
}

function telegramQuotePreview(plan: AlexDcaPlan, expectedOut: number): string {
  return [
    `📋 *ALEX DCA Order Preview*`,
    ``,
    `🔄 ${fmtNum(plan.orderSizeHuman)} ${plan.tokenInSymbol} → ~${fmtNum(expectedOut, 8)} ${plan.tokenOutSymbol}`,
    `📉 Max slippage: ${plan.slippagePct}%`,
    `📊 Order ${plan.ordersCompleted + 1} of ${plan.ordersTotal}`,
    ``,
    `⚠️ Add \`--confirm\` to execute this swap on ALEX DEX.`,
  ].join("\n");
}

// ─── Commands ─────────────────────────────────────────────────────────────────

async function cmdDoctor(): Promise<void> {
  const checks: Record<string, { ok: boolean; message: string }> = {};

  // ALEX SDK + API
  try {
    const sdk = await getAlexSDK();
    // Probe with a known pair (STX → ALEX)
    const amountOut = await sdk.getAmountTo("token-wstx", BigInt(1_000_000), "token-alex");
    checks.alex = {
      ok: true,
      message: `ALEX API reachable — 1 STX → ~${microToHuman(amountOut as bigint, 8).toFixed(4)} ALEX`,
    };
  } catch (e: any) {
    checks.alex = {
      ok: false,
      message: `ALEX SDK error: ${e.message}. Run: install-packs --pack all`,
    };
  }

  // Wallet presence
  checks.wallet = walletExists()
    ? { ok: true, message: "Wallet found" }
    : {
        ok: false,
        message: "No wallet found. Run: npx @aibtc/mcp-server@latest --install (or set STACKS_PRIVATE_KEY)",
      };

  // Stacks mainnet RPC
  try {
    const res  = await fetch(`${STACKS_API}/v2/info`, { signal: AbortSignal.timeout(10_000) });
    const info = await res.json() as any;
    checks.network = {
      ok: res.ok,
      message: `Stacks mainnet OK — block height ${info.burn_block_height ?? "?"}`,
    };
  } catch (e: any) {
    checks.network = { ok: false, message: `Stacks API unreachable: ${e.message}` };
  }

  // Plan state dir
  ensurePlanDir();
  const planCount = fs.readdirSync(ALEX_DCA_DIR).filter(f => f.endsWith(".json")).length;
  checks.plans = { ok: true, message: `State dir OK — ${planCount} plan(s) stored` };

  const allOk  = Object.values(checks).every(c => c.ok);
  const lines  = Object.entries(checks).map(([k, v]) => `${v.ok ? "✅" : "❌"} ${k}: ${v.message}`);
  const telegram = `${allOk ? "✅" : "❌"} *ALEX DCA Doctor*\n\n${lines.join("\n")}`;

  if (allOk) {
    success("ALEX DCA skill is ready", { checks, telegram });
  } else {
    blocked(
      `Fix: ${Object.entries(checks).filter(([, v]) => !v.ok).map(([k]) => k).join(", ")}`,
      { checks, telegram }
    );
  }
}

async function cmdInstallPacks(pack: string): Promise<void> {
  if (pack !== "all") {
    fail("INVALID_PACK", `Unknown pack: ${pack}`, "Run: install-packs --pack all");
    return;
  }

  const packages = [
    "@alexgo-io/alex-sdk",
    "@stacks/transactions",
    "@stacks/network",
    "@stacks/wallet-sdk",
    "@stacks/encryption",
    "commander",
    "tslib",
  ];

  const { spawnSync } = require("child_process");
  const result = spawnSync("bun", ["add", ...packages], { stdio: "inherit" });

  if (result.status !== 0) {
    fail("INSTALL_FAILED", "bun add failed", "Check internet connection and retry");
    return;
  }

  success("All packages installed", {
    installed: packages,
    telegram: `✅ *ALEX DCA — Packages Installed*\n\n${packages.map(p => `• ${p}`).join("\n")}\n\nRun \`doctor\` to verify.`,
  });
}

async function cmdSetup(opts: {
  tokenIn: string;
  tokenOut: string;
  total: string;
  orders: string;
  frequency: string;
  slippage?: string;
  startDelayHours?: string;
  walletPassword?: string;
}): Promise<void> {
  // ── Validate: orders ──
  const ordersNum = parseInt(opts.orders, 10);
  if (isNaN(ordersNum) || ordersNum < 2) {
    fail("INVALID_ORDERS", "Orders must be >= 2", "Use --orders 2..100");
    return;
  }
  if (ordersNum > MAX_ORDERS) {
    fail("ORDERS_LIMIT", `Exceeds hard limit of ${MAX_ORDERS} orders`, "Use --orders 2..100");
    return;
  }

  // ── Validate: slippage ──
  const slippageNum = parseFloat(opts.slippage ?? "3");
  if (isNaN(slippageNum) || slippageNum <= 0) {
    fail("INVALID_SLIPPAGE", "Slippage must be > 0", "Use --slippage 1..10");
    return;
  }
  if (slippageNum > MAX_SLIPPAGE_PCT) {
    fail("SLIPPAGE_LIMIT", `${slippageNum}% exceeds hard limit of ${MAX_SLIPPAGE_PCT}%`, "Use --slippage 1..10");
    return;
  }

  // ── Validate: frequency ──
  const freqKey     = opts.frequency.toLowerCase();
  const freqSeconds = FREQUENCIES[freqKey];
  if (!freqSeconds) {
    fail("INVALID_FREQ", `Unknown frequency: ${opts.frequency}`, `Use: ${Object.keys(FREQUENCIES).join(" | ")}`);
    return;
  }

  // ── Validate: total ──
  const totalHuman = parseFloat(opts.total);
  if (isNaN(totalHuman) || totalHuman <= 0) {
    fail("INVALID_TOTAL", "Total must be > 0", "Use --total 100 for 100 STX");
    return;
  }

  const orderSizeHuman = totalHuman / ordersNum;

  // ── Resolve tokens ──
  const tokenIn  = resolveToken(opts.tokenIn);
  const tokenOut = resolveToken(opts.tokenOut);

  if (!tokenIn) {
    const supported = Object.keys(SYMBOL_TO_CURRENCY).join(", ");
    fail("TOKEN_NOT_FOUND", `"${opts.tokenIn}" not found. Supported: ${supported}`, "Use a supported symbol");
    return;
  }
  if (!tokenOut) {
    const supported = Object.keys(SYMBOL_TO_CURRENCY).join(", ");
    fail("TOKEN_NOT_FOUND", `"${opts.tokenOut}" not found. Supported: ${supported}`, "Use a supported symbol");
    return;
  }

  if (humanToMicro(orderSizeHuman, tokenIn.decimals) === 0n) {
    fail("ORDER_TOO_SMALL", `Order size ${orderSizeHuman} rounds to zero atomic units for ${opts.tokenIn.toUpperCase()}`, "Increase --total or decrease --orders");
    return;
  }
  if (tokenIn.currencyId === tokenOut.currencyId) {
    fail("SAME_TOKEN", "Input and output tokens must be different", "Choose different --token-in and --token-out");
    return;
  }

  // ── Validate pair has a live route ──
  const quote = await fetchAlexQuote(
    tokenIn.currencyId, orderSizeHuman, tokenIn.decimals,
    tokenOut.currencyId, tokenOut.decimals
  );
  if (!quote || quote.amountOutHuman === 0) {
    fail(
      "PAIR_UNAVAILABLE",
      `No swap route for ${opts.tokenIn.toUpperCase()} → ${opts.tokenOut.toUpperCase()} on ALEX`,
      "Try a different pair or check ALEX for supported routes"
    );
    return;
  }

  // ── Resolve wallet address (best-effort at setup time) ──
  let walletAddress = "pending";
  const pwd = opts.walletPassword ?? process.env.AIBTC_WALLET_PASSWORD;
  if (pwd) {
    try {
      const w = await getWalletKeys(pwd);
      walletAddress = w.stxAddress;
    } catch { /* Non-fatal — resolved at run time */ }
  }

  // ── Build plan ──
  const now           = Date.now();
  const startDelayMs  = parseFloat(opts.startDelayHours ?? "0") * 3600 * 1000;
  const startAt       = now + startDelayMs;

  const tokenInSymbol  = opts.tokenIn.toUpperCase();
  const tokenOutSymbol = opts.tokenOut.toUpperCase();

  const plan: AlexDcaPlan = {
    planId:            `alex-dca-${crypto.randomBytes(4).toString("hex")}`,
    createdAt:         now,
    status:            "pending",
    currencyIn:        tokenIn.currencyId,
    currencyOut:       tokenOut.currencyId,
    tokenInSymbol,
    tokenOutSymbol,
    tokenInDecimals:   tokenIn.decimals,
    tokenOutDecimals:  tokenOut.decimals,
    totalAmountHuman:  totalHuman,
    ordersTotal:       ordersNum,
    orderSizeHuman,
    frequencyLabel:    freqKey,
    frequencySeconds:  freqSeconds,
    slippagePct:       slippageNum,
    walletAddress,
    startAt,
    nextOrderAt:       startAt,
    ordersCompleted:   0,
    totalSpentHuman:   0,
    totalReceivedHuman: 0,
    orderLog:          [],
  };

  savePlan(plan);

  const completionDate = new Date(startAt + (ordersNum - 1) * freqSeconds * 1000)
    .toISOString().slice(0, 10);

  const telegram = [
    `✅ *ALEX DCA Plan Created*`,
    ``,
    `📈 ${tokenInSymbol} → ${tokenOutSymbol}`,
    `• Plan ID: \`${plan.planId}\``,
    `• Total: ${fmtNum(totalHuman)} ${tokenInSymbol}`,
    `• Orders: ${ordersNum} × ${fmtNum(orderSizeHuman)} ${tokenInSymbol}`,
    `• Frequency: ${freqKey}`,
    `• Slippage: ${slippageNum}%`,
    `• Live quote: ~${fmtNum(quote.amountOutHuman, 8)} ${tokenOutSymbol} per order`,
    `• Est. completion: ${completionDate}`,
    ``,
    `▶️ \`plan --plan ${plan.planId}\` to preview schedule`,
    `▶️ \`run --plan ${plan.planId}\` to execute first order`,
  ].join("\n");

  success(`Plan ${plan.planId} created`, {
    planId: plan.planId,
    tokenIn: tokenInSymbol,
    tokenOut: tokenOutSymbol,
    orderSize: orderSizeHuman,
    ordersTotal: ordersNum,
    frequency: freqKey,
    currentQuote: quote.amountOutHuman,
    estimatedCompletion: completionDate,
    telegram,
  });
}

async function cmdPlan(planId: string): Promise<void> {
  const plan = loadPlan(planId);
  if (!plan) {
    fail("PLAN_NOT_FOUND", `Plan ${planId} not found`, "Run: list");
    return;
  }

  let currentQuote: number | null = null;
  try {
    const q = await fetchAlexQuote(
      plan.currencyIn, plan.orderSizeHuman, plan.tokenInDecimals,
      plan.currencyOut, plan.tokenOutDecimals
    );
    currentQuote = q?.amountOutHuman ?? null;
  } catch { /* non-fatal */ }

  const orders = Array.from({ length: plan.ordersTotal }, (_, i) => {
    const scheduledAt = plan.startAt + i * plan.frequencySeconds * 1000;
    const log         = plan.orderLog.slice().reverse().find(o => o.orderIndex === i);
    return {
      orderIndex:        i + 1,
      scheduledAt:       new Date(scheduledAt).toISOString().slice(0, 10),
      status:            log?.status ?? "scheduled",
      estimatedAmountIn: plan.orderSizeHuman,
      estimatedAmountOut: currentQuote,
      txId:              log?.txId ?? null,
    };
  });

  const telegramLines = [
    `📋 *ALEX DCA Schedule — ${plan.tokenInSymbol} → ${plan.tokenOutSymbol}*`,
    `\`${plan.planId}\``,
    ``,
    ...orders.slice(0, 8).map(o => {
      const e = { completed: "✅", "dry-run": "🧪", failed: "❌", scheduled: "⏳" }[o.status] ?? "⏳";
      const q = o.estimatedAmountOut ? ` → ~${fmtNum(o.estimatedAmountOut, 8)} ${plan.tokenOutSymbol}` : "";
      return `${e} #${o.orderIndex} ${o.scheduledAt}${q}`;
    }),
    orders.length > 8 ? `  ...and ${orders.length - 8} more` : "",
    ``,
    `💰 ${fmtNum(plan.orderSizeHuman)} ${plan.tokenInSymbol}/order · ${plan.frequencyLabel} · ${plan.slippagePct}% slippage`,
  ].filter(l => l !== "").join("\n");

  success("Schedule loaded", {
    planId,
    totalOrders: plan.ordersTotal,
    currentQuote,
    orders,
    telegram: telegramLines,
  });
}

async function cmdRun(planId: string, confirm: boolean, walletPassword?: string): Promise<void> {
  const plan = loadPlan(planId);
  if (!plan) {
    fail("PLAN_NOT_FOUND", `Plan ${planId} not found`, "Run: list");
    return;
  }

  if (plan.status === "cancelled") {
    fail("PLAN_CANCELLED", "Plan is cancelled", "Run: list for active plans");
    return;
  }
  if (plan.status === "completed") {
    fail("PLAN_COMPLETE", "All orders already complete", "Run: setup for a new plan");
    return;
  }

  // ── Guard: frequency ──
  const now = Date.now();
  if (now < plan.nextOrderAt) {
    const timeLeft = fmtTimeLeft(plan.nextOrderAt);
    blocked(`Next order due ${timeLeft}`, {
      nextOrderAt: new Date(plan.nextOrderAt).toISOString(),
      timeLeft,
      telegram: [
        `⏳ *ALEX DCA: Order Not Yet Due*`,
        `Plan: \`${planId}\``,
        `Next order: ${timeLeft}`,
        `(${fmtDate(plan.nextOrderAt)})`,
      ].join("\n"),
    });
    return;
  }

  // ── Get live quote ──
  const quote = await fetchAlexQuote(
    plan.currencyIn, plan.orderSizeHuman, plan.tokenInDecimals,
    plan.currencyOut, plan.tokenOutDecimals
  );
  if (!quote) {
    fail("QUOTE_FAILED", `No quote for ${plan.tokenInSymbol}→${plan.tokenOutSymbol}`, "Check ALEX API status and retry");
    return;
  }

  // ── Guard: confirmation required ──
  if (!confirm) {
    blocked("Add --confirm to authorize this swap on ALEX DEX", {
      planId,
      orderNumber:   plan.ordersCompleted + 1,
      ordersTotal:   plan.ordersTotal,
      amountIn:      plan.orderSizeHuman,
      tokenIn:       plan.tokenInSymbol,
      estimatedOut:  quote.amountOutHuman,
      tokenOut:      plan.tokenOutSymbol,
      slippagePct:   plan.slippagePct,
      telegram:      telegramQuotePreview(plan, quote.amountOutHuman),
    });
    return;
  }

  // ── Require wallet password ──
  const pwd = walletPassword ?? process.env.AIBTC_WALLET_PASSWORD;
  if (!pwd && !process.env.STACKS_PRIVATE_KEY) {
    fail("NO_PASSWORD", "Wallet password required", "Pass --wallet-password or set AIBTC_WALLET_PASSWORD");
    return;
  }

  let walletKeys: { stxPrivateKey: string; stxAddress: string };
  try {
    walletKeys = await getWalletKeys(pwd ?? "");
  } catch (e: any) {
    fail("WALLET_ERROR", e.message, "Check wallet file and password");
    return;
  }

  if (plan.walletAddress === "pending") {
    plan.walletAddress = walletKeys.stxAddress;
  }

  // ── Guard: STX balance check ──
  if (plan.tokenInSymbol.toUpperCase() === "STX") {
    try {
      const balAtomic    = await getStxBalance(walletKeys.stxAddress);
      const neededAtomic = Number(humanToMicro(plan.orderSizeHuman, plan.tokenInDecimals)) + 10000;
      if (balAtomic < neededAtomic) {
        const balHuman = microToHuman(balAtomic, 6);
        fail(
          "INSUFFICIENT_BALANCE",
          `Balance ${fmtNum(balHuman)} STX < required ${fmtNum(plan.orderSizeHuman)} STX + fee`,
          "Top up wallet and retry"
        );
        return;
      }
    } catch {
      process.stderr.write("Warning: could not verify balance\n");
    }
  } else {
    try {
      const balAtomic = await getStxBalance(walletKeys.stxAddress);
      if (balAtomic < 10000) {
        fail("INSUFFICIENT_STX_FOR_FEES", "Wallet needs ≥ 0.01 STX to pay transaction fees", "Top up STX balance");
        return;
      }
    } catch {
      process.stderr.write("Warning: could not verify STX fee balance\n");
    }
  }

  const dryRun = process.env.AIBTC_DRY_RUN === "1";

  // ── Execute swap ──
  let swapResult: { txId: string; explorerUrl: string; amountOutHuman: number };
  try {
    swapResult = await executeAlexSwap({
      currencyIn:      plan.currencyIn,
      currencyOut:     plan.currencyOut,
      tokenInDecimals: plan.tokenInDecimals,
      tokenOutDecimals: plan.tokenOutDecimals,
      amountHuman:     plan.orderSizeHuman,
      slippagePct:     plan.slippagePct,
      senderAddress:   walletKeys.stxAddress,
      stxPrivateKey:   walletKeys.stxPrivateKey,
      dryRun,
    });
  } catch (e: any) {
    plan.orderLog.push({
      orderIndex:       plan.ordersCompleted,
      status:           "failed",
      scheduledAt:      plan.nextOrderAt,
      executedAt:       now,
      amountInHuman:    plan.orderSizeHuman,
      amountOutHuman:   null,
      txId:             null,
      explorerUrl:      null,
      quoteAtExecution: quote.amountOutHuman,
      errorMessage:     e.message,
    });
    savePlan(plan);
    fail("SWAP_FAILED", e.message, "Review error; retry or cancel plan");
    return;
  }

  // ── Update plan state ──
  plan.orderLog.push({
    orderIndex:       plan.ordersCompleted,
    status:           dryRun ? "dry-run" : "completed",
    scheduledAt:      plan.nextOrderAt,
    executedAt:       now,
    amountInHuman:    plan.orderSizeHuman,
    amountOutHuman:   swapResult.amountOutHuman,
    txId:             swapResult.txId,
    explorerUrl:      swapResult.explorerUrl,
    quoteAtExecution: quote.amountOutHuman,
    errorMessage:     null,
  });

  plan.ordersCompleted    += 1;
  plan.totalSpentHuman    += plan.orderSizeHuman;
  plan.totalReceivedHuman += swapResult.amountOutHuman;
  plan.walletAddress       = walletKeys.stxAddress;
  plan.nextOrderAt         = now + plan.frequencySeconds * 1000;
  plan.status              = plan.ordersCompleted >= plan.ordersTotal ? "completed" : "active";

  savePlan(plan);

  const avg      = calcAvgEntryPrice(plan);
  const dryLabel = dryRun ? " 🧪 DRY RUN" : "";
  const allDone  = plan.status === "completed";

  const telegram = [
    `${dryRun ? "🧪" : "✅"} *ALEX DCA Order ${plan.ordersCompleted}/${plan.ordersTotal}${dryLabel}*`,
    ``,
    `🔄 ${fmtNum(plan.orderSizeHuman)} ${plan.tokenInSymbol} → ~${fmtNum(swapResult.amountOutHuman, 8)} ${plan.tokenOutSymbol}`,
    `🔗 TX: \`${swapResult.txId}\``,
    swapResult.explorerUrl,
    ``,
    `📊 Progress: ${plan.ordersCompleted}/${plan.ordersTotal}`,
    avg !== null ? `💰 Avg entry: ${fmtNum(avg)} ${plan.tokenInSymbol}/1 ${plan.tokenOutSymbol}` : "",
    allDone
      ? `🏁 All ${plan.ordersTotal} orders complete!`
      : `⏳ Next order: ${fmtTimeLeft(plan.nextOrderAt)} (${fmtDate(plan.nextOrderAt)})`,
  ].filter(l => l !== "").join("\n");

  success(
    allDone
      ? `All ${plan.ordersTotal} orders complete!`
      : `Order ${plan.ordersCompleted}/${plan.ordersTotal} done. Next: ${fmtTimeLeft(plan.nextOrderAt)}`,
    {
      planId,
      orderNumber:  plan.ordersCompleted,
      ordersTotal:  plan.ordersTotal,
      txId:         swapResult.txId,
      explorerUrl:  swapResult.explorerUrl,
      amountIn:     plan.orderSizeHuman,
      amountOut:    swapResult.amountOutHuman,
      avgEntryPrice: avg,
      nextOrderAt:  allDone ? null : new Date(plan.nextOrderAt).toISOString(),
      planStatus:   plan.status,
      dryRun,
      telegram,
    }
  );
}

async function cmdStatus(planId?: string, all = false): Promise<void> {
  if (all) {
    const plans = listPlans();
    const statusEmoji: Record<string, string> = {
      pending: "⏳", active: "🔄", completed: "✅", cancelled: "❌",
    };
    const telegram = plans.length === 0
      ? "📊 *No ALEX DCA plans.* Run `setup` to create one."
      : [
          `📊 *All ALEX DCA Plans (${plans.length})*`,
          "",
          ...plans.map(p =>
            `${statusEmoji[p.status] ?? "📊"} \`${p.planId}\` ${p.tokenInSymbol}→${p.tokenOutSymbol} ` +
            `${p.ordersCompleted}/${p.ordersTotal} (${p.frequencyLabel})`
          ),
        ].join("\n");

    success(`${plans.length} plan(s)`, {
      count: plans.length,
      plans: plans.map(p => ({
        planId:      p.planId,
        status:      p.status,
        pair:        `${p.tokenInSymbol}→${p.tokenOutSymbol}`,
        progress:    `${p.ordersCompleted}/${p.ordersTotal}`,
        frequency:   p.frequencyLabel,
        nextOrderAt: p.status === "active" ? new Date(p.nextOrderAt).toISOString() : null,
      })),
      telegram,
    });
    return;
  }

  if (!planId) {
    fail("NO_PLAN_ID", "Provide --plan <id> or --all", "Run: list");
    return;
  }

  const plan = loadPlan(planId);
  if (!plan) {
    fail("PLAN_NOT_FOUND", `Plan ${planId} not found`, "Run: list");
    return;
  }

  success("Plan status loaded", {
    planId:          plan.planId,
    status:          plan.status,
    tokenIn:         plan.tokenInSymbol,
    tokenOut:        plan.tokenOutSymbol,
    ordersCompleted: plan.ordersCompleted,
    ordersRemaining: plan.ordersTotal - plan.ordersCompleted,
    ordersTotal:     plan.ordersTotal,
    totalSpent:      plan.totalSpentHuman,
    totalReceived:   plan.totalReceivedHuman,
    avgEntryPrice:   calcAvgEntryPrice(plan),
    nextOrderAt:     plan.status === "active" ? new Date(plan.nextOrderAt).toISOString() : null,
    orderLog:        plan.orderLog,
    telegram:        telegramStatus(plan),
  });
}

async function cmdCancel(planId: string): Promise<void> {
  const plan = loadPlan(planId);
  if (!plan) {
    fail("PLAN_NOT_FOUND", `Plan ${planId} not found`, "Run: list");
    return;
  }
  if (plan.status === "cancelled") {
    fail("ALREADY_CANCELLED", "Plan already cancelled", "Run: list");
    return;
  }
  if (plan.status === "completed") {
    fail("ALREADY_COMPLETE", "Plan already complete", "Nothing to cancel");
    return;
  }

  const skipped = plan.ordersTotal - plan.ordersCompleted;
  plan.status   = "cancelled";
  savePlan(plan);

  success(`Cancelled. ${skipped} orders skipped.`, {
    planId,
    ordersCompleted: plan.ordersCompleted,
    ordersCancelled: skipped,
    telegram: [
      `❌ *ALEX DCA Plan Cancelled*`,
      `• Plan: \`${planId}\``,
      `• Completed: ${plan.ordersCompleted}/${plan.ordersTotal} orders`,
      `• Skipped: ${skipped} orders`,
      `• Total spent: ${fmtNum(plan.totalSpentHuman)} ${plan.tokenInSymbol}`,
      `• Total received: ${fmtNum(plan.totalReceivedHuman, 8)} ${plan.tokenOutSymbol}`,
    ].join("\n"),
  });
}

async function cmdList(): Promise<void> {
  const plans       = listPlans();
  const statusEmoji: Record<string, string> = {
    pending: "⏳", active: "🔄", completed: "✅", cancelled: "❌",
  };

  const telegram = plans.length === 0
    ? "📋 *No ALEX DCA plans.* Run `setup` to create one."
    : [
        `📋 *ALEX DCA Plans (${plans.length})*`,
        "",
        ...plans.map(p =>
          `${statusEmoji[p.status] ?? "📊"} \`${p.planId}\` — ` +
          `${p.tokenInSymbol}→${p.tokenOutSymbol} · ${p.ordersCompleted}/${p.ordersTotal} · ${p.frequencyLabel}`
        ),
      ].join("\n");

  success(`${plans.length} plan(s)`, {
    count: plans.length,
    plans: plans.map(p => ({
      planId:     p.planId,
      status:     p.status,
      pair:       `${p.tokenInSymbol}→${p.tokenOutSymbol}`,
      progress:   `${p.ordersCompleted}/${p.ordersTotal}`,
      frequency:  p.frequencyLabel,
      createdAt:  new Date(p.createdAt).toISOString().slice(0, 10),
    })),
    telegram,
  });
}

// ─── CLI wiring ───────────────────────────────────────────────────────────────

const program = new Command();
program
  .name("alex-dca")
  .description("Dollar Cost Averaging on ALEX DEX via Stacks mainnet")
  .version("1.0.0");

program
  .command("doctor")
  .description("Check environment, ALEX API, wallet, and Stacks network")
  .action(() => cmdDoctor().catch(e => fail("UNEXPECTED", e.message, "Check error and retry")));

program
  .command("install-packs")
  .description("Install required npm packages via bun")
  .option("--pack <name>", "Pack name (use: all)", "all")
  .action(o => cmdInstallPacks(o.pack).catch(e => fail("UNEXPECTED", e.message, "Check error")));

program
  .command("setup")
  .description("Create a new ALEX DCA plan")
  .requiredOption("--token-in <sym>", "Input token symbol (e.g. STX, ALEX)")
  .requiredOption("--token-out <sym>", "Output token symbol (e.g. ALEX, ABTC)")
  .requiredOption("--total <n>", "Total amount in human units (e.g. 100 for 100 STX)")
  .requiredOption("--orders <n>", "Number of orders (2..100)")
  .requiredOption("--frequency <f>", "hourly | daily | weekly | biweekly")
  .option("--slippage <pct>", "Slippage % (default 3, max 10)", "3")
  .option("--start-delay-hours <h>", "Hours before first order fires (default 0)", "0")
  .option("--wallet-password <pw>", "Wallet password (or AIBTC_WALLET_PASSWORD env)")
  .action(o =>
    cmdSetup({
      tokenIn:          o.tokenIn,
      tokenOut:         o.tokenOut,
      total:            o.total,
      orders:           o.orders,
      frequency:        o.frequency,
      slippage:         o.slippage,
      startDelayHours:  o.startDelayHours,
      walletPassword:   o.walletPassword,
    }).catch(e => fail("UNEXPECTED", e.message, "Check error"))
  );

program
  .command("plan")
  .description("Preview ALEX DCA schedule with per-order timing and quotes")
  .requiredOption("--plan <id>", "Plan ID")
  .action(o => cmdPlan(o.plan).catch(e => fail("UNEXPECTED", e.message, "Check error")));

program
  .command("run")
  .description("Execute the next pending order (cron-friendly)")
  .requiredOption("--plan <id>", "Plan ID")
  .option("--confirm", "Authorize swap — required to spend funds")
  .option("--wallet-password <pw>", "Wallet password (or AIBTC_WALLET_PASSWORD env)")
  .action(o =>
    cmdRun(o.plan, !!o.confirm, o.walletPassword).catch(e =>
      fail("UNEXPECTED", e.message, "Check error")
    )
  );

program
  .command("status")
  .description("Show ALEX DCA plan progress and stats")
  .option("--plan <id>", "Plan ID")
  .option("--all", "Show all plans")
  .action(o => cmdStatus(o.plan, !!o.all).catch(e => fail("UNEXPECTED", e.message, "Check error")));

program
  .command("cancel")
  .description("Cancel remaining orders for a plan")
  .requiredOption("--plan <id>", "Plan ID")
  .action(o => cmdCancel(o.plan).catch(e => fail("UNEXPECTED", e.message, "Check error")));

program
  .command("list")
  .description("List all local ALEX DCA plans")
  .action(() => cmdList().catch(e => fail("UNEXPECTED", e.message, "Check error")));

program.parseAsync(process.argv).catch(e => {
  fail("PARSE_ERROR", e.message, "Run: bun run alex-dca/alex-dca.ts --help");
});
