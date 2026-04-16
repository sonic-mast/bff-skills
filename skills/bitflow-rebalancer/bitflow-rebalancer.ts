#!/usr/bin/env bun
/**
 * Bitflow Rebalancer — Portfolio rebalancing for Stacks DeFi via Bitflow
 *
 * Usage: bun run bitflow-rebalancer/bitflow-rebalancer.ts <command> [options]
 * All commands emit strict JSON to stdout. Debug goes to stderr.
 */

import { Command } from "commander";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as crypto from "crypto";

// ─── Constants ────────────────────────────────────────────────────────────────

const REBALANCER_DIR = path.join(os.homedir(), ".aibtc", "rebalancer");
const WALLETS_FILE = path.join(os.homedir(), ".aibtc", "wallets.json");
const WALLETS_DIR = path.join(os.homedir(), ".aibtc", "wallets");
const STACKS_API = "https://api.hiro.so";
const EXPLORER_BASE = "https://explorer.hiro.so/txid";

const MAX_SLIPPAGE_PCT = 10;
const MAX_TRADE_PCT = 20;
const MIN_GAS_USTX = 100_000;
const TX_FEE_USTX = 50_000;

// ─── Types ────────────────────────────────────────────────────────────────────

interface TokenInfo { id: string; symbol: string; decimals: number; }

interface RebalanceEntry {
  timestamp: number;
  direction: string;
  amountIn: number;
  amountOut: number;
  txId: string | null;
  explorerUrl: string | null;
  driftBefore: number;
  driftAfter: number | null;
}

interface RebalancePlan {
  planId: string;
  createdAt: number;
  status: "active" | "cancelled";
  tokenA: TokenInfo;
  tokenB: TokenInfo;
  targetA: number;
  targetB: number;
  thresholdPct: number;
  slippagePct: number;
  cooldownMs: number;
  hodlmmOnly: boolean;
  walletAddress: string;
  lastRebalanceAt: number | null;
  rebalanceLog: RebalanceEntry[];
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

// ─── Format helpers ──────────────────────────────────────────────────────────

function fmtNum(n: number, d = 6): string {
  if (n === 0) return "0";
  if (n < 0.000001) return n.toExponential(4);
  return n.toLocaleString("en-US", { maximumFractionDigits: d, minimumFractionDigits: 0 });
}

function fmtDuration(ms: number): string {
  const s = ms / 1000;
  if (s < 60) return `${Math.round(s)}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  return `${(s / 3600).toFixed(1)}h`;
}

function humanToAtomic(amount: number, decimals: number): bigint {
  return BigInt(Math.round(amount * Math.pow(10, decimals)));
}

function atomicToHuman(amount: number | bigint, decimals: number): number {
  return Number(amount) / Math.pow(10, decimals);
}


// ─── Plan file helpers ────────────────────────────────────────────────────────

function ensureDir(): void {
  if (!fs.existsSync(REBALANCER_DIR)) fs.mkdirSync(REBALANCER_DIR, { recursive: true });
}

function listPlans(): RebalancePlan[] {
  ensureDir();
  return fs.readdirSync(REBALANCER_DIR)
    .filter(f => f.endsWith(".json"))
    .map(f => { try { return JSON.parse(fs.readFileSync(path.join(REBALANCER_DIR, f), "utf-8")); } catch { return null; } })
    .filter(Boolean) as RebalancePlan[];
}

function loadPlan(id: string): RebalancePlan | null {
  const p = path.join(REBALANCER_DIR, `${id}.json`);
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, "utf-8")); } catch { return null; }
}

function savePlan(plan: RebalancePlan): void {
  ensureDir();
  fs.writeFileSync(path.join(REBALANCER_DIR, `${plan.planId}.json`), JSON.stringify(plan, null, 2));
}

// ─── Wallet helpers ───────────────────────────────────────────────────────────

function walletExists(): boolean {
  return fs.existsSync(WALLETS_FILE) || fs.existsSync(path.join(os.homedir(), ".aibtc", "wallet.json"));
}

async function decryptAibtcKeystore(enc: any, password: string): Promise<string> {
  const { scryptSync, createDecipheriv } = crypto;
  const { N, r, p, keyLen } = enc.scryptParams;
  const salt = Buffer.from(enc.salt, "base64");
  const iv = Buffer.from(enc.iv, "base64");
  const authTag = Buffer.from(enc.authTag, "base64");
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
    return { stxPrivateKey: key, stxAddress: getAddressFromPrivateKey(key, TransactionVersion.Mainnet) };
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
            const wallet = await generateWallet({ secretKey: mnemonic, password: "" });
            const account = wallet.accounts[0] ?? deriveAccount(wallet, 0);
            return { stxPrivateKey: account.stxPrivateKey, stxAddress: getStxAddress(account) };
          }
          const legacyEnc = keystore.encryptedMnemonic ?? keystore.encrypted_mnemonic;
          if (legacyEnc) {
            const { decryptMnemonic } = await import("@stacks/encryption" as any);
            const mnemonic = await decryptMnemonic(legacyEnc, password);
            const wallet = await generateWallet({ secretKey: mnemonic, password: "" });
            const account = wallet.accounts[0] ?? deriveAccount(wallet, 0);
            return { stxPrivateKey: account.stxPrivateKey, stxAddress: getStxAddress(account) };
          }
        }
      }
    } catch (e: any) { process.stderr.write(`Wallet decrypt error: ${e.message}\n`); }
  }
  const legacyPath = path.join(os.homedir(), ".aibtc", "wallet.json");
  if (fs.existsSync(legacyPath)) {
    try {
      const w = JSON.parse(fs.readFileSync(legacyPath, "utf-8"));
      const mnemonic = w.mnemonic ?? w.encrypted_mnemonic ?? w.encryptedMnemonic;
      if (mnemonic) {
        const wallet = await generateWallet({ secretKey: mnemonic, password });
        const account = deriveAccount(wallet, 0);
        return { stxPrivateKey: account.stxPrivateKey, stxAddress: getStxAddress(account) };
      }
    } catch { /* fall through */ }
  }
  throw new Error("No wallet found or decryption failed. Run: npx @aibtc/mcp-server@latest --install");
}


// ─── Bitflow + balance helpers ───────────────────────────────────────────────

async function getBitflow(): Promise<any> {
  const { BitflowSDK } = await import("@bitflowlabs/core-sdk" as any);
  return new BitflowSDK({
    BITFLOW_API_HOST: process.env.BITFLOW_API_HOST || "https://api.bitflowapis.finance",
    BITFLOW_API_KEY: process.env.BITFLOW_API_KEY || "",
    READONLY_CALL_API_HOST: process.env.READONLY_CALL_API_HOST || "https://api.mainnet.hiro.so",
    READONLY_CALL_API_KEY: process.env.READONLY_CALL_API_KEY || "",
    KEEPER_API_HOST: process.env.KEEPER_API_HOST || "https://api.bitflowapis.finance",
    KEEPER_API_URL: process.env.KEEPER_API_URL || "https://api.bitflowapis.finance",
    KEEPER_API_KEY: process.env.KEEPER_API_KEY || "",
    BITFLOW_PROVIDER_ADDRESS: process.env.BITFLOW_PROVIDER_ADDRESS || "",
  });
}

async function findToken(sdk: any, symbol: string): Promise<TokenInfo | null> {
  const tokens = await sdk.getAvailableTokens();
  const sym = symbol.toLowerCase();
  const match = tokens.find((t: any) =>
    (t.symbol ?? "").toLowerCase() === sym ||
    (t.tokenId ?? "").toLowerCase() === sym ||
    (t["token-id"] ?? "").toLowerCase() === sym
  );
  if (!match) return null;
  return { id: match.tokenId ?? match["token-id"], decimals: match.tokenDecimals ?? 6, symbol: match.symbol ?? symbol.toUpperCase() };
}

async function getStxBalance(address: string): Promise<number> {
  const res = await fetch(`${STACKS_API}/v2/accounts/${address}?proof=0`, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`Balance fetch failed: ${res.status}`);
  const data = await res.json() as { balance: string; locked: string };
  const total = parseInt(data.balance, 16);
  const locked = parseInt(data.locked ?? "0x0", 16);
  return total - locked; // spendable only — excludes STX locked in stacking
}

async function getTokenBalance(address: string, tokenContractId: string): Promise<number> {
  const res = await fetch(`${STACKS_API}/extended/v1/address/${address}/balances`, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`Token balance fetch failed: ${res.status}`);
  const data = await res.json() as any;
  const ft = data.fungible_tokens ?? {};
  for (const [key, val] of Object.entries(ft) as [string, any][]) {
    if (key.includes(tokenContractId) || key.toLowerCase().includes(tokenContractId.toLowerCase())) {
      return parseInt(val.balance ?? "0", 10);
    }
  }
  return 0;
}

async function getBalanceHuman(address: string, token: TokenInfo): Promise<number> {
  if (token.symbol.toUpperCase() === "STX") {
    const atomic = await getStxBalance(address);
    return atomicToHuman(atomic, 6);
  }
  const atomic = await getTokenBalance(address, token.id);
  return atomicToHuman(atomic, token.decimals);
}

async function fetchQuote(sdk: any, tokenInId: string, tokenOutId: string, amountHuman: number): Promise<{ expectedAmountOut: number; route: any; priceImpact: number | null } | null> {
  try {
    const result = await sdk.getQuoteForRoute(tokenInId, tokenOutId, amountHuman);
    if (!result?.bestRoute?.quote) return null;
    return { expectedAmountOut: result.bestRoute.quote, route: result.bestRoute.route, priceImpact: result.bestRoute.priceImpact ?? null };
  } catch { return null; }
}

async function executeSwap(opts: {
  sdk: any; tokenInId: string; tokenOutId: string; tokenInDecimals: number; tokenOutDecimals: number;
  amountHuman: number; senderAddress: string; stxPrivateKey: string; slippagePct: number; dryRun: boolean;
  hodlmmOnly: boolean;
}): Promise<{ txId: string; explorerUrl: string; expectedAmountOut: number }> {
  const { makeContractCall, broadcastTransaction, AnchorMode, PostConditionMode } = await import("@stacks/transactions" as any);
  const { STACKS_MAINNET } = await import("@stacks/network" as any);
  const slippageDecimal = opts.slippagePct / 100;
  const routeOpts = opts.hodlmmOnly ? { hodlmmOnly: true } : undefined;
  const quoteResult = await opts.sdk.getQuoteForRoute(opts.tokenInId, opts.tokenOutId, opts.amountHuman, routeOpts);
  if (!quoteResult?.bestRoute?.route) throw new Error(`No swap route for ${opts.tokenInId} → ${opts.tokenOutId}`);
  const expectedAmountOut: number = quoteResult.bestRoute.quote ?? 0;
  const swapParams = await opts.sdk.prepareSwap(
    { route: quoteResult.bestRoute.route, amount: opts.amountHuman, tokenXDecimals: opts.tokenInDecimals, tokenYDecimals: opts.tokenOutDecimals },
    opts.senderAddress, slippageDecimal
  );
  if (opts.dryRun) {
    const fakeTxId = "dry-run-" + crypto.randomBytes(8).toString("hex");
    return { txId: fakeTxId, explorerUrl: `${EXPLORER_BASE}/${fakeTxId}?chain=mainnet`, expectedAmountOut };
  }
  const tx = await makeContractCall({
    contractAddress: swapParams.contractAddress, contractName: swapParams.contractName,
    functionName: swapParams.functionName, functionArgs: swapParams.functionArgs,
    postConditions: swapParams.postConditions, postConditionMode: PostConditionMode.Deny,
    network: STACKS_MAINNET, senderKey: opts.stxPrivateKey, anchorMode: AnchorMode.Any, fee: 50_000n,
  });
  const broadcastRes = await broadcastTransaction({ transaction: tx, network: STACKS_MAINNET });
  if (broadcastRes.error) throw new Error(`Broadcast failed: ${broadcastRes.error} — ${broadcastRes.reason ?? ""}`);
  return { txId: broadcastRes.txid, explorerUrl: `${EXPLORER_BASE}/${broadcastRes.txid}?chain=mainnet`, expectedAmountOut };
}


// ─── Allocation calculation ──────────────────────────────────────────────────

async function computeAllocation(sdk: any, plan: RebalancePlan, address: string): Promise<{
  balA: number; balB: number; priceOfBinA: number; valueA: number; valueB: number;
  totalValue: number; actualPctA: number; actualPctB: number; driftA: number; driftB: number; maxDrift: number;
}> {
  const balA = await getBalanceHuman(address, plan.tokenA);
  const balB = await getBalanceHuman(address, plan.tokenB);

  // Get price of 1 tokenB in tokenA terms
  let priceOfBinA = 1;
  if (plan.tokenA.id !== plan.tokenB.id) {
    const quote = await fetchQuote(sdk, plan.tokenB.id, plan.tokenA.id, 1);
    if (quote) priceOfBinA = quote.expectedAmountOut;
    else throw new Error(`Cannot price ${plan.tokenB.symbol} in ${plan.tokenA.symbol} — no route`);
  }

  const valueA = balA;
  const valueB = balB * priceOfBinA;
  const totalValue = valueA + valueB;

  if (totalValue === 0) {
    return { balA, balB, priceOfBinA, valueA, valueB, totalValue, actualPctA: 0, actualPctB: 0, driftA: plan.targetA, driftB: plan.targetB, maxDrift: Math.max(plan.targetA, plan.targetB) };
  }

  const actualPctA = (valueA / totalValue) * 100;
  const actualPctB = (valueB / totalValue) * 100;
  const driftA = Math.abs(actualPctA - plan.targetA);
  const driftB = Math.abs(actualPctB - plan.targetB);
  const maxDrift = Math.max(driftA, driftB);

  return { balA, balB, priceOfBinA, valueA, valueB, totalValue, actualPctA, actualPctB, driftA, driftB, maxDrift };
}

// ─── Commands ────────────────────────────────────────────────────────────────

async function cmdDoctor(): Promise<void> {
  const checks: Record<string, { ok: boolean; message: string }> = {};

  try {
    const sdk = await getBitflow();
    const tokens = await sdk.getAvailableTokens();
    checks.bitflow = { ok: true, message: `Bitflow API reachable — ${tokens.length} tokens available` };
  } catch (e: any) {
    checks.bitflow = { ok: false, message: `Bitflow SDK error: ${e.message}. Run: install-packs` };
  }

  checks.wallet = walletExists()
    ? { ok: true, message: "Wallet found" }
    : { ok: false, message: "No wallet. Run: npx @aibtc/mcp-server@latest --install" };

  try {
    const res = await fetch(`${STACKS_API}/v2/info`, { signal: AbortSignal.timeout(10_000) });
    checks.stacks = res.ok ? { ok: true, message: "Stacks mainnet reachable" } : { ok: false, message: `Stacks API returned ${res.status}` };
  } catch (e: any) {
    checks.stacks = { ok: false, message: `Stacks API unreachable: ${e.message}` };
  }

  const plans = listPlans();
  checks.plans = { ok: true, message: `${plans.length} rebalancer plan(s) on disk` };

  const allOk = Object.values(checks).every(c => c.ok);
  if (allOk) success("All systems healthy. Ready to rebalance.", { checks });
  else fail("DOCTOR_FAILED", "Some checks failed", "Fix the failing checks above", { checks });
}

async function cmdInstallPacks(): Promise<void> {
  const { execSync } = await import("child_process" as any);
  try {
    execSync("bun add @bitflowlabs/core-sdk @stacks/transactions @stacks/network @stacks/wallet-sdk @stacks/encryption commander tslib", { stdio: "pipe" });
    success("Packages installed.", { packages: ["@bitflowlabs/core-sdk", "@stacks/transactions", "@stacks/network", "@stacks/wallet-sdk", "@stacks/encryption", "commander", "tslib"] });
  } catch (e: any) {
    fail("INSTALL_FAILED", e.message, "Check bun is installed and network is available");
  }
}

async function cmdConfigure(opts: { tokenA: string; targetA: string; tokenB: string; targetB: string; threshold: string; slippage: string; cooldown: string; hodlmmOnly: boolean }): Promise<void> {
  const targetA = parseFloat(opts.targetA);
  const targetB = parseFloat(opts.targetB);

  if (isNaN(targetA) || isNaN(targetB) || Math.abs(targetA + targetB - 100) > 0.01) {
    return fail("TARGETS_INVALID", `Targets must sum to 100 (got ${targetA} + ${targetB} = ${targetA + targetB})`, "Adjust --target-a and --target-b");
  }

  const threshold = parseFloat(opts.threshold);
  if (isNaN(threshold) || threshold < 1) return fail("THRESHOLD_TOO_LOW", "Threshold must be >= 1%", "Use --threshold >= 1");
  if (threshold > 20) return fail("THRESHOLD_TOO_HIGH", "Threshold must be <= 20%", "Use --threshold <= 20");

  const slippage = parseFloat(opts.slippage);
  if (isNaN(slippage) || slippage <= 0) return fail("SLIPPAGE_INVALID", "Slippage must be a positive number", "Use --slippage between 0.1 and 10");
  if (slippage > MAX_SLIPPAGE_PCT) return fail("SLIPPAGE_LIMIT", `Max slippage is ${MAX_SLIPPAGE_PCT}%`, "Lower --slippage");

  const cooldownMatch = opts.cooldown.match(/^(\d+)h$/);
  if (!cooldownMatch) return fail("COOLDOWN_INVALID", "Cooldown must be Xh (e.g. 24h)", "Use --cooldown 24h");
  const cooldownMs = parseInt(cooldownMatch[1]) * 3600 * 1000;

  const sdk = await getBitflow();
  const tokenAInfo = await findToken(sdk, opts.tokenA);
  if (!tokenAInfo) return fail("TOKEN_NOT_FOUND", `Token ${opts.tokenA} not found in Bitflow`, "Check available tokens with doctor");
  const tokenBInfo = await findToken(sdk, opts.tokenB);
  if (!tokenBInfo) return fail("TOKEN_NOT_FOUND", `Token ${opts.tokenB} not found in Bitflow`, "Check available tokens with doctor");

  // Verify route exists
  const testQuote = await fetchQuote(sdk, tokenAInfo.id, tokenBInfo.id, 1);
  if (!testQuote) return fail("ROUTE_NOT_FOUND", `No Bitflow route for ${opts.tokenA} → ${opts.tokenB}`, "Choose a different token pair");

  const planId = crypto.randomBytes(8).toString("hex");
  const plan: RebalancePlan = {
    planId, createdAt: Date.now(), status: "active",
    tokenA: tokenAInfo, tokenB: tokenBInfo,
    targetA, targetB, thresholdPct: threshold, slippagePct: slippage,
    cooldownMs, hodlmmOnly: opts.hodlmmOnly, walletAddress: "",
    lastRebalanceAt: null, rebalanceLog: [],
  };
  savePlan(plan);
  success("Plan created. Run `status --plan " + planId + "` to check allocation.", { plan });
}


async function cmdStatus(planId: string): Promise<void> {
  const plan = loadPlan(planId);
  if (!plan) return fail("PLAN_NOT_FOUND", `No plan with id ${planId}`, "Run `list` to see plans");

  const password = process.env.AIBTC_WALLET_PASSWORD || "";
  let address: string;
  try {
    const keys = await getWalletKeys(password);
    address = keys.stxAddress;
  } catch {
    return fail("WALLET_ERROR", "Cannot load wallet to check balances", "Set AIBTC_WALLET_PASSWORD");
  }

  const sdk = await getBitflow();
  const alloc = await computeAllocation(sdk, plan, address);

  const telegram = [
    `📊 *Rebalancer — ${plan.tokenA.symbol}/${plan.tokenB.symbol}*`,
    `Target: ${plan.targetA}% / ${plan.targetB}%`,
    `Actual: ${alloc.actualPctA.toFixed(1)}% / ${alloc.actualPctB.toFixed(1)}%`,
    `Drift: ${alloc.maxDrift.toFixed(1)}% (threshold: ${plan.thresholdPct}%)`,
    `${plan.tokenA.symbol}: ${fmtNum(alloc.balA)} (${fmtNum(alloc.valueA)} in ${plan.tokenA.symbol} terms)`,
    `${plan.tokenB.symbol}: ${fmtNum(alloc.balB)} (${fmtNum(alloc.valueB)} in ${plan.tokenA.symbol} terms)`,
    alloc.maxDrift >= plan.thresholdPct ? `⚠️ Drift exceeds threshold — rebalance recommended` : `✅ Within threshold — no action needed`,
  ].join("\n");

  success("Allocation status retrieved.", { telegram, plan: planId, address, allocation: alloc });
}

async function cmdPreview(planId: string): Promise<void> {
  const plan = loadPlan(planId);
  if (!plan) return fail("PLAN_NOT_FOUND", `No plan with id ${planId}`, "Run `list` to see plans");
  if (plan.status === "cancelled") return fail("PLAN_CANCELLED", "This plan is cancelled", "Create a new plan with configure");

  if (plan.lastRebalanceAt && Date.now() - plan.lastRebalanceAt < plan.cooldownMs) {
    const remaining = plan.cooldownMs - (Date.now() - plan.lastRebalanceAt);
    return blocked("Cooldown active — rebalance not due yet.", { planId, cooldownRemaining: fmtDuration(remaining), nextRebalanceAt: new Date(plan.lastRebalanceAt + plan.cooldownMs).toISOString() });
  }

  const password = process.env.AIBTC_WALLET_PASSWORD || "";
  const keys = await getWalletKeys(password);
  const sdk = await getBitflow();
  const alloc = await computeAllocation(sdk, plan, keys.stxAddress);

  if (alloc.maxDrift < plan.thresholdPct) {
    return blocked("Drift below threshold — no rebalance needed.", { planId, drift: alloc.maxDrift.toFixed(1), threshold: plan.thresholdPct, allocation: { actualA: alloc.actualPctA.toFixed(1), actualB: alloc.actualPctB.toFixed(1), targetA: plan.targetA, targetB: plan.targetB } });
  }

  // Determine trade direction and size
  const targetValueA = alloc.totalValue * (plan.targetA / 100);
  const diffA = alloc.valueA - targetValueA; // positive = sell A, negative = buy A

  let tradeDirection: string;
  let tradeAmountHuman: number;
  let tokenIn: TokenInfo;
  let tokenOut: TokenInfo;

  if (diffA > 0) {
    tradeDirection = `${plan.tokenA.symbol} → ${plan.tokenB.symbol}`;
    tradeAmountHuman = diffA; // in tokenA terms, sell excess A
    tokenIn = plan.tokenA;
    tokenOut = plan.tokenB;
  } else {
    tradeDirection = `${plan.tokenB.symbol} → ${plan.tokenA.symbol}`;
    tradeAmountHuman = Math.abs(diffA) / alloc.priceOfBinA; // convert to tokenB terms
    tokenIn = plan.tokenB;
    tokenOut = plan.tokenA;
  }

  // Enforce max trade size (20% of portfolio)
  const tradePctOfPortfolio = (Math.abs(diffA) / alloc.totalValue) * 100;
  if (tradePctOfPortfolio > MAX_TRADE_PCT) {
    return blocked("Trade exceeds 20% of portfolio — reduce threshold or split manually.", { planId, tradePct: tradePctOfPortfolio.toFixed(1), maxTradePct: MAX_TRADE_PCT });
  }

  const quote = await fetchQuote(sdk, tokenIn.id, tokenOut.id, tradeAmountHuman);
  if (!quote) return fail("ROUTE_NOT_FOUND", `No route for ${tradeDirection}`, "Check Bitflow API availability");

  const telegram = [
    `📋 *Rebalance Preview*`,
    `🔄 ${fmtNum(tradeAmountHuman)} ${tokenIn.symbol} → ~${fmtNum(quote.expectedAmountOut)} ${tokenOut.symbol}`,
    `📉 Max slippage: ${plan.slippagePct}%`,
    `📊 Drift: ${alloc.maxDrift.toFixed(1)}% (threshold: ${plan.thresholdPct}%)`,
    `⚠️ Add \`--confirm\` to execute this swap on-chain.`,
  ].join("\n");

  success("preview", { telegram, planId, trade: { direction: tradeDirection, amountIn: tradeAmountHuman, expectedOut: quote.expectedAmountOut, priceImpact: quote.priceImpact }, drift: alloc.maxDrift, allocation: { actualA: alloc.actualPctA.toFixed(1), actualB: alloc.actualPctB.toFixed(1) } });
}


async function cmdRun(planId: string, confirm: boolean, walletPassword?: string, hodlmmOnly?: boolean): Promise<void> {
  const plan = loadPlan(planId);
  if (!plan) return fail("PLAN_NOT_FOUND", `No plan with id ${planId}`, "Run `list` to see plans");
  if (plan.status === "cancelled") return fail("PLAN_CANCELLED", "This plan is cancelled", "Create a new plan");

  if (plan.lastRebalanceAt && Date.now() - plan.lastRebalanceAt < plan.cooldownMs) {
    const remaining = plan.cooldownMs - (Date.now() - plan.lastRebalanceAt);
    return blocked("Cooldown active.", { planId, cooldownRemaining: fmtDuration(remaining) });
  }

  // Runtime --hodlmm-only flag overrides the plan setting (local only, does not mutate stored plan)
  const effectiveHodlmmOnly = hodlmmOnly !== undefined ? hodlmmOnly : plan.hodlmmOnly;

  const password = walletPassword || process.env.AIBTC_WALLET_PASSWORD || "";
  const keys = await getWalletKeys(password);
  const sdk = await getBitflow();
  const alloc = await computeAllocation(sdk, plan, keys.stxAddress);

  if (alloc.maxDrift < plan.thresholdPct) {
    return blocked("Drift below threshold.", { planId, drift: alloc.maxDrift.toFixed(1), threshold: plan.thresholdPct });
  }

  // Calculate trade
  const targetValueA = alloc.totalValue * (plan.targetA / 100);
  const diffA = alloc.valueA - targetValueA;
  let tradeAmountHuman: number;
  let tokenIn: TokenInfo;
  let tokenOut: TokenInfo;
  let direction: string;

  if (diffA > 0) {
    direction = `${plan.tokenA.symbol} → ${plan.tokenB.symbol}`;
    tradeAmountHuman = diffA;
    tokenIn = plan.tokenA;
    tokenOut = plan.tokenB;
  } else {
    direction = `${plan.tokenB.symbol} → ${plan.tokenA.symbol}`;
    tradeAmountHuman = Math.abs(diffA) / alloc.priceOfBinA;
    tokenIn = plan.tokenB;
    tokenOut = plan.tokenA;
  }

  const tradePctOfPortfolio = (Math.abs(diffA) / alloc.totalValue) * 100;
  if (tradePctOfPortfolio > MAX_TRADE_PCT) {
    return blocked("Trade exceeds max 20% of portfolio.", { planId, tradePct: tradePctOfPortfolio.toFixed(1) });
  }

  // Check gas reserve (STX required for gas regardless of which token is sold)
  // TX_FEE_USTX is subtracted from the post-swap balance to ensure the reserve stays intact after fees
  const stxBal = await getStxBalance(keys.stxAddress);
  if (tokenIn.symbol.toUpperCase() === "STX") {
    const tradeAtomic = humanToAtomic(tradeAmountHuman, 6);
    if (stxBal - Number(tradeAtomic) - TX_FEE_USTX < MIN_GAS_USTX) {
      return fail("INSUFFICIENT_GAS", `Post-swap STX would be below ${MIN_GAS_USTX} uSTX gas reserve`, "Reduce trade size or top up STX");
    }
  } else {
    if (stxBal - TX_FEE_USTX < MIN_GAS_USTX) {
      return fail("INSUFFICIENT_GAS", `STX balance (${stxBal} uSTX) below ${MIN_GAS_USTX + TX_FEE_USTX} uSTX needed for gas + fee`, "Top up STX to cover transaction fees");
    }
  }

  if (!confirm) {
    const quote = await fetchQuote(sdk, tokenIn.id, tokenOut.id, tradeAmountHuman);
    return blocked("Add --confirm to execute.", { planId, trade: { direction, amountIn: tradeAmountHuman, expectedOut: quote?.expectedAmountOut, slippage: plan.slippagePct }, drift: alloc.maxDrift.toFixed(1) });
  }

  const dryRun = process.env.AIBTC_DRY_RUN === "1";
  try {
    const result = await executeSwap({
      sdk, tokenInId: tokenIn.id, tokenOutId: tokenOut.id,
      tokenInDecimals: tokenIn.decimals, tokenOutDecimals: tokenOut.decimals,
      amountHuman: tradeAmountHuman, senderAddress: keys.stxAddress,
      stxPrivateKey: keys.stxPrivateKey, slippagePct: plan.slippagePct, dryRun,
      hodlmmOnly: effectiveHodlmmOnly,
    });

    const entry: RebalanceEntry = {
      timestamp: Date.now(), direction, amountIn: tradeAmountHuman, amountOut: result.expectedAmountOut,
      txId: result.txId, explorerUrl: result.explorerUrl,
      driftBefore: alloc.maxDrift, driftAfter: null,
    };
    plan.rebalanceLog.push(entry);
    plan.lastRebalanceAt = Date.now();
    plan.walletAddress = keys.stxAddress;
    savePlan(plan);

    const telegram = [
      `✅ *Rebalance Executed${dryRun ? " (DRY RUN)" : ""}*`,
      `🔄 ${fmtNum(tradeAmountHuman)} ${tokenIn.symbol} → ${tokenOut.symbol}`,
      `📊 Drift: ${alloc.maxDrift.toFixed(1)}% → pending confirmation`,
      `🔗 ${result.explorerUrl}`,
    ].join("\n");

    success("Rebalance executed.", { telegram, planId, txId: result.txId, explorerUrl: result.explorerUrl, dryRun });
  } catch (e: any) {
    fail("SWAP_FAILED", e.message, "Check mempool and retry later");
  }
}

async function cmdList(): Promise<void> {
  const plans = listPlans();
  if (plans.length === 0) return success("No plans found.", { plans: [] });
  const summary = plans.map(p => ({
    planId: p.planId, status: p.status,
    pair: `${p.tokenA.symbol}/${p.tokenB.symbol}`,
    target: `${p.targetA}/${p.targetB}`,
    threshold: `${p.thresholdPct}%`,
    rebalances: p.rebalanceLog.length,
    lastRebalance: p.lastRebalanceAt ? new Date(p.lastRebalanceAt).toISOString() : "never",
  }));
  success(`${plans.length} plan(s) found.`, { plans: summary });
}

async function cmdCancel(planId: string): Promise<void> {
  const plan = loadPlan(planId);
  if (!plan) return fail("PLAN_NOT_FOUND", `No plan with id ${planId}`, "Run `list`");
  plan.status = "cancelled";
  savePlan(plan);
  success("Plan cancelled.", { planId });
}


// ─── CLI ─────────────────────────────────────────────────────────────────────

const program = new Command();
program.name("bitflow-rebalancer").description("Portfolio rebalancer for Stacks DeFi via Bitflow").version("1.0.0");

program.command("doctor").description("System health check").action(async () => {
  try { await cmdDoctor(); } catch (e: any) { fail("UNEXPECTED", e.message, "Report this error"); }
});

program.command("install-packs").description("Install required packages").action(async () => {
  try { await cmdInstallPacks(); } catch (e: any) { fail("UNEXPECTED", e.message, "Check bun installation"); }
});

program.command("configure")
  .description("Create a rebalancing plan")
  .requiredOption("--token-a <symbol>", "First token symbol")
  .requiredOption("--target-a <pct>", "Target % for token A")
  .requiredOption("--token-b <symbol>", "Second token symbol")
  .requiredOption("--target-b <pct>", "Target % for token B")
  .option("--threshold <pct>", "Drift % to trigger rebalance", "5")
  .option("--slippage <pct>", "Max slippage %", "3")
  .option("--cooldown <hours>", "Min time between rebalances", "24h")
  .option("--hodlmm-only", "Restrict to HODLMM routes", false)
  .action(async (opts) => {
    try { await cmdConfigure(opts); } catch (e: any) { fail("UNEXPECTED", e.message, "Check inputs"); }
  });

program.command("status")
  .description("Show allocation status")
  .requiredOption("--plan <id>", "Plan ID")
  .action(async (opts) => {
    try { await cmdStatus(opts.plan); } catch (e: any) { fail("UNEXPECTED", e.message, "Check plan ID"); }
  });

program.command("preview")
  .description("Preview required trades")
  .requiredOption("--plan <id>", "Plan ID")
  .action(async (opts) => {
    try { await cmdPreview(opts.plan); } catch (e: any) { fail("UNEXPECTED", e.message, "Check plan ID"); }
  });

program.command("run")
  .description("Execute rebalancing swap")
  .requiredOption("--plan <id>", "Plan ID")
  .option("--confirm", "Execute the swap on-chain", false)
  .option("--wallet-password <pw>", "Wallet password (prefer AIBTC_WALLET_PASSWORD env)")
  .option("--hodlmm-only", "Override plan setting: restrict routing to HODLMM pools only", false)
  .action(async (opts) => {
    try { await cmdRun(opts.plan, opts.confirm, opts.walletPassword, opts.hodlmmOnly || undefined); }
    catch (e: any) { fail("UNEXPECTED", e.message, "Check wallet and Bitflow API"); }
  });

program.command("list").description("List all plans").action(async () => {
  try { await cmdList(); } catch (e: any) { fail("UNEXPECTED", e.message, "Check disk access"); }
});

program.command("cancel")
  .description("Cancel a plan")
  .requiredOption("--plan <id>", "Plan ID")
  .action(async (opts) => {
    try { await cmdCancel(opts.plan); } catch (e: any) { fail("UNEXPECTED", e.message, "Check plan ID"); }
  });

program.parse();
