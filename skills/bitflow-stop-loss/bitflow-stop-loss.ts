#!/usr/bin/env bun
/**
 * bitflow-stop-loss — Price-triggered stop-loss orders on Bitflow
 *
 * Creates stop-loss orders for token positions on Stacks mainnet.
 * When market price drops below the configured threshold, the agent sells.
 * The agent IS the order engine — no keeper contracts required.
 *
 * Usage: bun run bitflow-stop-loss/bitflow-stop-loss.ts <command> [options]
 *
 * All commands emit strict JSON to stdout. Debug goes to stderr.
 */

import { Command } from "commander";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as crypto from "crypto";

// ─── Constants ────────────────────────────────────────────────────────────────

const SL_DIR = path.join(os.homedir(), ".aibtc", "stop-loss");
const WALLETS_FILE = path.join(os.homedir(), ".aibtc", "wallets.json");
const WALLETS_DIR = path.join(os.homedir(), ".aibtc", "wallets");
const STACKS_API = "https://api.hiro.so";
const EXPLORER_BASE = "https://explorer.hiro.so/txid";

const MAX_SLIPPAGE_PCT = 15;
const MAX_AMOUNT = 1_000_000;
const MAX_ORDERS = 20;
const MAX_CONSECUTIVE_FAILURES = 2;
const PRICE_SAMPLE_UNITS = 1; // use 1-unit quote for price sampling

const EXPIRY_UNITS: Record<string, number> = {
  h: 3600,
  d: 86400,
  w: 604800,
};

// ─── Types ────────────────────────────────────────────────────────────────────

interface PriceSample {
  sampledAt: number;
  price: number; // tokenOut per 1 tokenIn
}

interface ExecutionLog {
  executedAt: number;
  triggerPrice: number;
  executionPrice: number;
  amountInHuman: number;
  amountOutHuman: number | null;
  txId: string | null;
  explorerUrl: string | null;
  errorMessage: string | null;
  dryRun: boolean;
}

interface StopLossOrder {
  orderId: string;
  createdAt: number;
  expiresAt: number;
  status: "active" | "triggered" | "cancelled" | "expired" | "failed";
  tokenInId: string;
  tokenInSymbol: string;
  tokenInDecimals: number;
  tokenOutId: string;
  tokenOutSymbol: string;
  tokenOutDecimals: number;
  amountHuman: number;
  stopPrice: number; // tokenOut per 1 tokenIn
  slippagePct: number;
  walletAddress: string;
  consecutiveFailures: number;
  priceSamples: PriceSample[];
  executionLog: ExecutionLog | null;
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

function fmtDate(epochMs: number): string {
  return new Date(epochMs).toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

function fmtTimeLeft(targetMs: number): string {
  const diff = targetMs - Date.now();
  if (diff <= 0) return "expired";
  const s = diff / 1000;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${(s / 3600).toFixed(1)}h`;
  return `${(s / 86400).toFixed(1)}d`;
}

function parseExpiry(str: string): number {
  const match = str.match(/^(\d+)([hdw])$/);
  if (!match) throw new Error(`Invalid expiry format: '${str}'. Use e.g. '7d', '24h', '2w'.`);
  return parseInt(match[1]) * EXPIRY_UNITS[match[2]];
}

// ─── Order file helpers ───────────────────────────────────────────────────────

function ensureSlDir(): void {
  if (!fs.existsSync(SL_DIR)) fs.mkdirSync(SL_DIR, { recursive: true });
}

function listOrders(): StopLossOrder[] {
  ensureSlDir();
  return fs.readdirSync(SL_DIR)
    .filter(f => f.endsWith(".json"))
    .map(f => {
      try { return JSON.parse(fs.readFileSync(path.join(SL_DIR, f), "utf-8")) as StopLossOrder; }
      catch { return null; }
    })
    .filter(Boolean) as StopLossOrder[];
}

function loadOrder(orderId: string): StopLossOrder | null {
  const p = path.join(SL_DIR, `${orderId}.json`);
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, "utf-8")) as StopLossOrder; }
  catch { return null; }
}

function saveOrder(order: StopLossOrder): void {
  ensureSlDir();
  fs.writeFileSync(path.join(SL_DIR, `${order.orderId}.json`), JSON.stringify(order, null, 2));
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
    } catch (e: any) {
      process.stderr.write(`Wallet decrypt error: ${e.message}\n`);
    }
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

  throw new Error(
    "No wallet found or decryption failed.\n" +
    "Options:\n" +
    "  1. Run: npx @aibtc/mcp-server@latest --install\n" +
    "  2. Set STACKS_PRIVATE_KEY env var for direct key access"
  );
}

async function getStxBalance(address: string): Promise<number> {
  const res = await fetch(`${STACKS_API}/v2/accounts/${address}?proof=0`, {
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`Balance fetch failed: ${res.status}`);
  const data = await res.json() as { balance: string };
  return Number(BigInt(data.balance));
}

// ─── Bitflow helpers ──────────────────────────────────────────────────────────

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

async function findToken(sdk: any, symbol: string): Promise<{ tokenId: string; tokenDecimals: number; symbol: string } | null> {
  const tokens = await sdk.getAvailableTokens();
  const sym = symbol.toLowerCase();
  const match = tokens.find((t: any) =>
    (t.symbol ?? "").toLowerCase() === sym ||
    (t.tokenId ?? "").toLowerCase() === sym ||
    (t["token-id"] ?? "").toLowerCase() === sym
  );
  if (!match) return null;
  return {
    tokenId: match.tokenId ?? match["token-id"],
    tokenDecimals: match.tokenDecimals ?? 6,
    symbol: match.symbol ?? symbol.toUpperCase(),
  };
}

async function samplePrice(sdk: any, tokenInId: string, tokenOutId: string): Promise<number | null> {
  try {
    const result = await sdk.getQuoteForRoute(tokenInId, tokenOutId, PRICE_SAMPLE_UNITS);
    if (!result?.bestRoute?.quote) return null;
    return result.bestRoute.quote; // tokenOut per PRICE_SAMPLE_UNITS tokenIn
  } catch { return null; }
}

async function executeSwap(opts: {
  sdk: any;
  tokenInId: string;
  tokenOutId: string;
  tokenInDecimals: number;
  tokenOutDecimals: number;
  amountHuman: number;
  senderAddress: string;
  stxPrivateKey: string;
  slippagePct: number;
  dryRun: boolean;
}): Promise<{ txId: string; explorerUrl: string; amountOutHuman: number | null }> {
  const {
    makeContractCall, broadcastTransaction,
    AnchorMode, PostConditionMode,
  } = await import("@stacks/transactions" as any);
  const { STACKS_MAINNET } = await import("@stacks/network" as any);

  const network = STACKS_MAINNET;
  const slippageDecimal = opts.slippagePct / 100;

  const quoteResult = await opts.sdk.getQuoteForRoute(opts.tokenInId, opts.tokenOutId, opts.amountHuman);
  if (!quoteResult?.bestRoute?.route) {
    throw new Error(`No swap route for ${opts.tokenInId} → ${opts.tokenOutId}`);
  }

  const expectedOut: number = quoteResult.bestRoute.quote ?? null;

  const swapExecutionData = {
    route: quoteResult.bestRoute.route,
    amount: opts.amountHuman,
    tokenXDecimals: opts.tokenInDecimals,
    tokenYDecimals: opts.tokenOutDecimals,
  };

  const swapParams = await opts.sdk.prepareSwap(swapExecutionData, opts.senderAddress, slippageDecimal);

  if (opts.dryRun) {
    const fakeTxId = "dry-run-" + crypto.randomBytes(8).toString("hex");
    return {
      txId: fakeTxId,
      explorerUrl: `${EXPLORER_BASE}/${fakeTxId}?chain=mainnet`,
      amountOutHuman: expectedOut,
    };
  }

  const tx = await makeContractCall({
    contractAddress: swapParams.contractAddress,
    contractName: swapParams.contractName,
    functionName: swapParams.functionName,
    functionArgs: swapParams.functionArgs,
    postConditions: swapParams.postConditions,
    postConditionMode: PostConditionMode.Deny,
    network,
    senderKey: opts.stxPrivateKey,
    anchorMode: AnchorMode.Any,
    fee: 5000n,
  });

  const broadcastRes = await broadcastTransaction({ transaction: tx, network });
  if (broadcastRes.error) {
    throw new Error(`Broadcast failed: ${broadcastRes.error} — ${broadcastRes.reason ?? ""}`);
  }

  const txId: string = broadcastRes.txid;
  return { txId, explorerUrl: `${EXPLORER_BASE}/${txId}?chain=mainnet`, amountOutHuman: expectedOut };
}

// ─── Commands ─────────────────────────────────────────────────────────────────

async function cmdDoctor(): Promise<void> {
  const checks: Record<string, string> = {};

  try {
    const sdk = await getBitflow();
    const tokens = await sdk.getAvailableTokens();
    checks.bitflow = tokens.length > 0 ? `ok (${tokens.length} tokens)` : "empty response";
  } catch (e: any) {
    checks.bitflow = `error: ${e.message}`;
  }

  try {
    const res = await fetch(`${STACKS_API}/v2/info`, { signal: AbortSignal.timeout(8000) });
    const info = await res.json() as any;
    checks.stacks = res.ok ? `ok (block ${info.stacks_tip_height ?? "?"})` : `http ${res.status}`;
  } catch (e: any) {
    checks.stacks = `error: ${e.message}`;
  }

  checks.wallet = walletExists() ? "found" : "not found — run: npx @aibtc/mcp-server@latest --install";

  try {
    ensureSlDir();
    const orders = listOrders();
    checks.storage = `ok (${orders.length} orders at ${SL_DIR})`;
  } catch (e: any) {
    checks.storage = `error: ${e.message}`;
  }

  const allOk = !Object.values(checks).some(v => v.startsWith("error") || v.startsWith("not found"));
  if (allOk) {
    success("System healthy — ready to set stop-loss orders", { checks });
  } else {
    fail("HEALTH_CHECK_FAILED", "One or more health checks failed", "Fix the failing checks and re-run doctor", { checks });
  }
}

async function cmdInstallPacks(): Promise<void> {
  const packages = [
    "@bitflowlabs/core-sdk",
    "@stacks/transactions",
    "@stacks/network",
    "@stacks/wallet-sdk",
    "@stacks/encryption",
    "commander",
  ];
  const proc = Bun.spawnSync(["bun", "add", ...packages], { stdio: ["inherit", "inherit", "inherit"] });
  if (proc.exitCode !== 0) {
    return fail("INSTALL_FAILED", `bun add exited with code ${proc.exitCode}`, "Retry or install packages manually");
  }
  success("Dependencies installed", { packages });
}

async function cmdSet(opts: {
  tokenIn: string;
  tokenOut: string;
  amount: number;
  stopPrice: number;
  slippage: number;
  expires: string;
}): Promise<void> {
  if (opts.slippage > MAX_SLIPPAGE_PCT) {
    return fail("SLIPPAGE_LIMIT", `Slippage ${opts.slippage}% exceeds hard max ${MAX_SLIPPAGE_PCT}%`, "Use --slippage ≤ 15");
  }
  if (opts.amount <= 0) {
    return fail("AMOUNT_INVALID", "Amount must be > 0", "Pass a positive --amount");
  }
  if (opts.amount > MAX_AMOUNT) {
    return fail("AMOUNT_LIMIT", `Amount ${opts.amount} exceeds hard max ${MAX_AMOUNT}`, "Reduce --amount or split into multiple orders");
  }
  if (opts.stopPrice <= 0) {
    return fail("STOP_PRICE_INVALID", "Stop price must be > 0", "Pass a positive --stop-price");
  }

  const active = listOrders().filter(o => o.status === "active");
  if (active.length >= MAX_ORDERS) {
    return fail("ORDER_LIMIT", `Already have ${active.length} active orders (max ${MAX_ORDERS})`, "Cancel some orders first");
  }

  let expirySeconds: number;
  try {
    expirySeconds = parseExpiry(opts.expires);
  } catch (e: any) {
    return fail("EXPIRY_INVALID", e.message, "Use format like '7d', '24h', '2w'");
  }

  let sdk: any;
  try {
    sdk = await getBitflow();
  } catch (e: any) {
    return fail("BITFLOW_UNREACHABLE", `Cannot connect to Bitflow: ${e.message}`, "Check connectivity and retry");
  }

  const tokenIn = await findToken(sdk, opts.tokenIn);
  if (!tokenIn) {
    return fail("TOKEN_NOT_FOUND", `Token '${opts.tokenIn}' not found on Bitflow`, "Check available tokens via doctor");
  }

  const tokenOut = await findToken(sdk, opts.tokenOut);
  if (!tokenOut) {
    return fail("TOKEN_NOT_FOUND", `Token '${opts.tokenOut}' not found on Bitflow`, "Check available tokens via doctor");
  }

  // Verify route exists with live price sample
  const priceCheck = await samplePrice(sdk, tokenIn.tokenId, tokenOut.tokenId);
  if (priceCheck === null) {
    return fail("NO_ROUTE", `No swap route from ${tokenIn.symbol} → ${tokenOut.symbol} on Bitflow`, "Choose a supported token pair");
  }

  const orderId = crypto.randomBytes(8).toString("hex");
  const now = Date.now();

  const order: StopLossOrder = {
    orderId,
    createdAt: now,
    expiresAt: now + expirySeconds * 1000,
    status: "active",
    tokenInId: tokenIn.tokenId,
    tokenInSymbol: tokenIn.symbol,
    tokenInDecimals: tokenIn.tokenDecimals,
    tokenOutId: tokenOut.tokenId,
    tokenOutSymbol: tokenOut.symbol,
    tokenOutDecimals: tokenOut.tokenDecimals,
    amountHuman: opts.amount,
    stopPrice: opts.stopPrice,
    slippagePct: opts.slippage,
    walletAddress: "",
    consecutiveFailures: 0,
    priceSamples: [{ sampledAt: now, price: priceCheck }],
    executionLog: null,
  };

  saveOrder(order);

  const triggered = priceCheck < opts.stopPrice;
  success("Stop-loss order created", {
    orderId,
    tokenIn: tokenIn.symbol,
    tokenOut: tokenOut.symbol,
    amount: opts.amount,
    stopPrice: opts.stopPrice,
    currentPrice: priceCheck,
    triggered,
    slippagePct: opts.slippage,
    expiresAt: fmtDate(order.expiresAt),
    expiresIn: fmtTimeLeft(order.expiresAt),
    warning: triggered ? `⚠️ Current price (${fmtNum(priceCheck)}) is already below stop price (${fmtNum(opts.stopPrice)}) — order will trigger on next run` : null,
    telegram: `🛡 Stop-loss set: sell ${fmtNum(opts.amount)} ${tokenIn.symbol} → ${tokenOut.symbol} if price < ${fmtNum(opts.stopPrice)}. Current: ${fmtNum(priceCheck)}. Expires: ${fmtTimeLeft(order.expiresAt)}.`,
  });
}

async function cmdRun(opts: {
  confirm: boolean;
  walletPassword: string;
}): Promise<void> {
  const orders = listOrders().filter(o => o.status === "active");
  const now = Date.now();

  // Expire stale orders
  const expired = orders.filter(o => o.expiresAt < now);
  for (const o of expired) {
    o.status = "expired";
    saveOrder(o);
    process.stderr.write(`Order ${o.orderId} expired\n`);
  }

  const active = orders.filter(o => o.expiresAt >= now);
  if (active.length === 0) {
    return blocked("No active stop-loss orders", { ordersChecked: 0 });
  }

  let sdk: any;
  try {
    sdk = await getBitflow();
  } catch (e: any) {
    return fail("BITFLOW_UNREACHABLE", `Cannot connect to Bitflow: ${e.message}`, "Retry on next heartbeat");
  }

  const results: Record<string, unknown>[] = [];
  let triggeredCount = 0;
  let executedCount = 0;

  for (const order of active) {
    const currentPrice = await samplePrice(sdk, order.tokenInId, order.tokenOutId);
    if (currentPrice === null) {
      results.push({ orderId: order.orderId, status: "price-unavailable" });
      continue;
    }

    // Record sample (keep last 5)
    order.priceSamples.push({ sampledAt: now, price: currentPrice });
    if (order.priceSamples.length > 5) order.priceSamples.shift();

    const isTriggered = currentPrice < order.stopPrice;

    if (!isTriggered) {
      saveOrder(order);
      results.push({
        orderId: order.orderId,
        pair: `${order.tokenInSymbol}→${order.tokenOutSymbol}`,
        currentPrice,
        stopPrice: order.stopPrice,
        distancePct: (((currentPrice - order.stopPrice) / order.stopPrice) * 100).toFixed(2) + "%",
        status: "watching",
        expiresIn: fmtTimeLeft(order.expiresAt),
      });
      continue;
    }

    triggeredCount++;
    const expectedOut = currentPrice * order.amountHuman;

    if (!opts.confirm) {
      saveOrder(order);
      results.push({
        orderId: order.orderId,
        pair: `${order.tokenInSymbol}→${order.tokenOutSymbol}`,
        currentPrice,
        stopPrice: order.stopPrice,
        status: "TRIGGERED — awaiting --confirm",
        amountIn: order.amountHuman,
        expectedOut: fmtNum(expectedOut),
        slippagePct: order.slippagePct,
        action: "bun run bitflow-stop-loss/bitflow-stop-loss.ts run --confirm",
      });
      continue;
    }

    // Execute with --confirm
    if (order.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      results.push({
        orderId: order.orderId,
        status: "skipped — max consecutive failures reached, operator review required",
        consecutiveFailures: order.consecutiveFailures,
      });
      continue;
    }

    const password = opts.walletPassword || process.env.AIBTC_WALLET_PASSWORD || "";
    if (!password) {
      return fail("WALLET_PASSWORD_MISSING", "AIBTC_WALLET_PASSWORD env var or --wallet-password required for execution", "Set AIBTC_WALLET_PASSWORD and retry");
    }

    const dryRun = !!process.env.AIBTC_DRY_RUN;

    try {
      const { stxPrivateKey, stxAddress } = await getWalletKeys(password);
      order.walletAddress = stxAddress;

      // Balance check: STX amount (if selling STX) + gas reserve always required
      const isStxIn = order.tokenInSymbol === "STX" || order.tokenInId.toLowerCase().includes("stx");
      const balanceUSTX = await getStxBalance(stxAddress);
      const gasReserve = 10_000;
      const requiredUSTX = isStxIn ? order.amountHuman * 1_000_000 + gasReserve : gasReserve;
      if (balanceUSTX < requiredUSTX) {
        const balanceHuman = balanceUSTX / 1_000_000;
        const needed = isStxIn ? `${order.amountHuman} STX + gas` : "gas (STX)";
        order.consecutiveFailures++;
        saveOrder(order);
        results.push({
          orderId: order.orderId,
          status: "error",
          error: `INSUFFICIENT_BALANCE: need ${needed}, have ${balanceHuman.toFixed(6)} STX`,
        });
        continue;
      }

      const { txId, explorerUrl, amountOutHuman } = await executeSwap({
        sdk,
        tokenInId: order.tokenInId,
        tokenOutId: order.tokenOutId,
        tokenInDecimals: order.tokenInDecimals,
        tokenOutDecimals: order.tokenOutDecimals,
        amountHuman: order.amountHuman,
        senderAddress: stxAddress,
        stxPrivateKey,
        slippagePct: order.slippagePct,
        dryRun,
      });

      order.status = "triggered";
      order.consecutiveFailures = 0;
      order.executionLog = {
        executedAt: now,
        triggerPrice: currentPrice,
        executionPrice: currentPrice,
        amountInHuman: order.amountHuman,
        amountOutHuman,
        txId,
        explorerUrl,
        errorMessage: null,
        dryRun,
      };
      saveOrder(order);
      executedCount++;

      results.push({
        orderId: order.orderId,
        status: dryRun ? "dry-run" : "executed",
        pair: `${order.tokenInSymbol}→${order.tokenOutSymbol}`,
        triggerPrice: currentPrice,
        stopPrice: order.stopPrice,
        amountIn: order.amountHuman,
        amountOut: amountOutHuman,
        txId,
        explorerUrl,
        telegram: `🛡 Stop-loss triggered: sold ${fmtNum(order.amountHuman)} ${order.tokenInSymbol} → ${fmtNum(amountOutHuman ?? 0)} ${order.tokenOutSymbol} at ${fmtNum(currentPrice)}${dryRun ? " (dry-run)" : ""}. Tx: ${txId}`,
      });
    } catch (e: any) {
      order.consecutiveFailures++;
      if (order.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        order.status = "failed";
      }
      saveOrder(order);
      results.push({
        orderId: order.orderId,
        status: "error",
        error: e.message,
        consecutiveFailures: order.consecutiveFailures,
      });
    }
  }

  if (triggeredCount === 0 && !opts.confirm) {
    return blocked(`Checked ${active.length} orders — none triggered`, {
      orders: results,
      expiredCount: expired.length,
    });
  }

  if (triggeredCount > 0 && !opts.confirm) {
    return blocked(`${triggeredCount} order(s) triggered — re-run with --confirm to execute`, {
      triggeredCount,
      orders: results,
    });
  }

  success(`Run complete: ${executedCount} executed, ${triggeredCount - executedCount} errors`, {
    checkedCount: active.length,
    triggeredCount,
    executedCount,
    expiredCount: expired.length,
    orders: results,
  });
}

function cmdList(orderId?: string): void {
  const orders = orderId
    ? [loadOrder(orderId)].filter(Boolean) as StopLossOrder[]
    : listOrders();

  if (orders.length === 0) {
    return success("No orders found", { orders: [] });
  }

  const formatted = orders.map(o => {
    const lastPrice = o.priceSamples.length > 0 ? o.priceSamples[o.priceSamples.length - 1].price : null;
    const triggered = lastPrice !== null && lastPrice < o.stopPrice;
    return {
      orderId: o.orderId,
      status: o.status,
      pair: `${o.tokenInSymbol}→${o.tokenOutSymbol}`,
      amount: o.amountHuman,
      stopPrice: o.stopPrice,
      currentPrice: lastPrice,
      triggered: o.status === "active" ? triggered : undefined,
      distancePct: lastPrice !== null
        ? (((lastPrice - o.stopPrice) / o.stopPrice) * 100).toFixed(2) + "%"
        : null,
      slippagePct: o.slippagePct,
      createdAt: fmtDate(o.createdAt),
      expiresAt: fmtDate(o.expiresAt),
      expiresIn: o.status === "active" ? fmtTimeLeft(o.expiresAt) : undefined,
      txId: o.executionLog?.txId ?? null,
    };
  });

  success(`${orders.length} order(s)`, { orders: formatted });
}

function cmdCancel(orderId: string): void {
  const order = loadOrder(orderId);
  if (!order) {
    return fail("ORDER_NOT_FOUND", `Order '${orderId}' not found`, "Check available order IDs with list");
  }
  if (order.status !== "active") {
    return fail("ORDER_NOT_ACTIVE", `Order '${orderId}' is ${order.status} — cannot cancel`, "Only active orders can be cancelled");
  }

  order.status = "cancelled";
  saveOrder(order);
  success("Order cancelled", {
    orderId,
    pair: `${order.tokenInSymbol}→${order.tokenOutSymbol}`,
    amount: order.amountHuman,
    stopPrice: order.stopPrice,
  });
}

function cmdStatus(orderId: string): void {
  const order = loadOrder(orderId);
  if (!order) {
    return fail("ORDER_NOT_FOUND", `Order '${orderId}' not found`, "Check available order IDs with list");
  }

  const lastPrice = order.priceSamples.length > 0 ? order.priceSamples[order.priceSamples.length - 1].price : null;

  success("Order status", {
    orderId: order.orderId,
    status: order.status,
    pair: `${order.tokenInSymbol}→${order.tokenOutSymbol}`,
    amount: order.amountHuman,
    stopPrice: order.stopPrice,
    currentPrice: lastPrice,
    triggered: lastPrice !== null ? lastPrice < order.stopPrice : null,
    slippagePct: order.slippagePct,
    consecutiveFailures: order.consecutiveFailures,
    createdAt: fmtDate(order.createdAt),
    expiresAt: fmtDate(order.expiresAt),
    expiresIn: order.status === "active" ? fmtTimeLeft(order.expiresAt) : undefined,
    priceSamples: order.priceSamples.map(s => ({
      sampledAt: fmtDate(s.sampledAt),
      price: s.price,
    })),
    executionLog: order.executionLog,
  });
}

// ─── CLI setup ────────────────────────────────────────────────────────────────

const program = new Command();
program.name("bitflow-stop-loss").description("Price-triggered stop-loss orders on Bitflow").allowUnknownOption(false);

program
  .command("doctor")
  .description("Health check: Bitflow API, wallet, Stacks connectivity")
  .action(async () => { try { await cmdDoctor(); } catch (e: any) { fail("UNEXPECTED", e.message, "Re-run doctor"); } });

program
  .command("install-packs")
  .description("Install required bun/npm packages (one-time setup)")
  .action(async () => { try { await cmdInstallPacks(); } catch (e: any) { fail("UNEXPECTED", e.message, "Retry install"); } });

program
  .command("set")
  .description("Create a new stop-loss order")
  .requiredOption("--token-in <symbol>", "Token to sell (e.g. STX)")
  .requiredOption("--token-out <symbol>", "Token to receive (e.g. sBTC)")
  .requiredOption("--amount <n>", "Amount of token-in to sell (human units)", parseFloat)
  .requiredOption("--stop-price <n>", "Sell if price falls below this (token-out per token-in)", parseFloat)
  .option("--slippage <pct>", "Slippage % (default 3, max 15)", parseFloat, 3)
  .option("--expires <duration>", "Order expiry e.g. 7d, 24h, 2w (default 7d)", "7d")
  .action(async (opts) => {
    try {
      await cmdSet({
        tokenIn: opts.tokenIn,
        tokenOut: opts.tokenOut,
        amount: opts.amount,
        stopPrice: opts.stopPrice,
        slippage: opts.slippage,
        expires: opts.expires,
      });
    } catch (e: any) { fail("UNEXPECTED", e.message, "Re-run set with valid inputs"); }
  });

program
  .command("run")
  .description("Check all active stop-loss orders and execute triggered ones")
  .option("--confirm", "Execute triggered swaps on-chain (without this flag: preview only)")
  .option("--wallet-password <pw>", "Wallet password (prefer AIBTC_WALLET_PASSWORD env var)")
  .action(async (opts) => {
    try {
      await cmdRun({
        confirm: !!opts.confirm,
        walletPassword: opts.walletPassword ?? "",
      });
    } catch (e: any) { fail("UNEXPECTED", e.message, "Check logs and retry"); }
  });

program
  .command("list")
  .description("List all stop-loss orders")
  .option("--order-id <id>", "Filter to a specific order ID")
  .action((opts) => { try { cmdList(opts.orderId); } catch (e: any) { fail("UNEXPECTED", e.message, "Re-run list"); } });

program
  .command("cancel <orderId>")
  .description("Cancel an active stop-loss order")
  .action((orderId) => { try { cmdCancel(orderId); } catch (e: any) { fail("UNEXPECTED", e.message, "Re-run cancel"); } });

program
  .command("status")
  .description("Detailed status of a specific order")
  .requiredOption("--order <id>", "Order ID")
  .action((opts) => { try { cmdStatus(opts.order); } catch (e: any) { fail("UNEXPECTED", e.message, "Re-run status"); } });

program.parse(process.argv);
