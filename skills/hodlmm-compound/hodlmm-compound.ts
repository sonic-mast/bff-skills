#!/usr/bin/env bun
/**
 * hodlmm-compound — Autocompound a Bitflow HODLMM DLMM position.
 *
 * Compound cycle:
 *   1. Withdraw all liquidity from current bins (withdraw-liquidity-same-multi)
 *   2. Swap excess token to restore ~50/50 ratio (Bitflow SDK)
 *   3. Re-add balanced liquidity to active bins (add-relative-liquidity-same-multi)
 *
 * Unlike hodlmm-move-liquidity which moves bins in-place, this skill does a
 * full round-trip to realize accumulated fees and reset token ratio optimally.
 *
 * Commands:
 *   doctor        — check APIs, wallet, pool access
 *   scan          — show positions, drift, and token imbalance
 *   run           — execute one compound cycle (dry-run unless --confirm)
 *   auto          — autonomous compound loop: monitor + execute on threshold
 */

import { Command } from "commander";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// ─── Constants ────────────────────────────────────────────────────────────────

const BITFLOW_QUOTES = "https://bff.bitflowapis.finance/api/quotes/v1";
const BITFLOW_APP = "https://bff.bitflowapis.finance/api/app/v1";
const HIRO_API = "https://api.mainnet.hiro.so";
const EXPLORER = "https://explorer.hiro.so/txid";

// Verified mainnet DLMM liquidity router (v-1-1 at SM deployer).
// Contract confirmed at tx 0b4a9c7c on Stacks mainnet.
const ROUTER_ADDR = "SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD";
const ROUTER_NAME = "dlmm-liquidity-router-v-1-1";

const COOLDOWN_MS = 4 * 60 * 60 * 1000;
const BIN_SPREAD = 5;                        // ±5 bins around active bin on re-add
const CENTER_BIN_ID = 500;                   // unsigned→signed bin offset (NUM_BINS/2)
const FETCH_TIMEOUT = 30_000;
const MAX_SLIPPAGE_PCT = 5;
const MIN_POSITION_VALUE_STX = 100;          // minimum 100 STX equivalent before compounding
const IMBALANCE_THRESHOLD_PCT = 10;          // trigger compound if >10% off 50/50
const DRIFT_THRESHOLD_BINS = 10;             // trigger compound if >10 bins from active

const STATE_FILE = path.join(os.homedir(), ".hodlmm-compound-state.json");
const WALLETS_FILE = path.join(os.homedir(), ".aibtc", "wallets.json");
const WALLETS_DIR = path.join(os.homedir(), ".aibtc", "wallets");

// ─── Types ────────────────────────────────────────────────────────────────────

interface PoolMeta {
  pool_id: string;
  pool_contract: string;
  token_x: string;
  token_y: string;
  token_x_symbol: string;
  token_y_symbol: string;
  token_x_decimals: number;
  token_y_decimals: number;
  bin_step: number;
}

interface UserBin {
  bin_id: number;
  liquidity: string;
  reserve_x: string;
  reserve_y: string;
}

interface BinData {
  bin_id: number;
  reserve_x: string;
  reserve_y: string;
  price: string;
  liquidity: string;
}

interface CompoundState {
  [poolId: string]: { last_compound_at: string; cycles: number };
}

// ─── Output helpers ───────────────────────────────────────────────────────────

function out(
  status: "success" | "error" | "blocked",
  action: string,
  data: unknown,
  error: string | null = null
): void {
  process.stdout.write(JSON.stringify({ status, action, data, error }) + "\n");
}

function log(...args: unknown[]): void {
  process.stderr.write(`[hodlmm-compound] ${args.join(" ")}\n`);
}

// ─── Fetch helper ─────────────────────────────────────────────────────────────

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

// ─── State ────────────────────────────────────────────────────────────────────

function loadState(): CompoundState {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf-8")) as CompoundState;
  } catch {
    return {};
  }
}

function saveState(state: CompoundState): void {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function isCoolingDown(poolId: string): { cooling: boolean; remainingMs: number } {
  const state = loadState();
  const entry = state[poolId];
  if (!entry) return { cooling: false, remainingMs: 0 };
  const elapsed = Date.now() - new Date(entry.last_compound_at).getTime();
  const remaining = Math.max(0, COOLDOWN_MS - elapsed);
  return { cooling: remaining > 0, remainingMs: remaining };
}

// ─── Wallet ───────────────────────────────────────────────────────────────────

async function getWalletKeys(password: string): Promise<{ stxPrivateKey: string; stxAddress: string }> {
  if (process.env.STACKS_PRIVATE_KEY) {
    const { getAddressFromPrivateKey, TransactionVersion } =
      await import("@stacks/transactions" as string);
    const key = process.env.STACKS_PRIVATE_KEY;
    const addr = getAddressFromPrivateKey(key, TransactionVersion.Mainnet);
    return { stxPrivateKey: key, stxAddress: addr };
  }

  const { generateWallet, deriveAccount, getStxAddress } =
    await import("@stacks/wallet-sdk" as string);

  if (fs.existsSync(WALLETS_FILE)) {
    const walletsJson = JSON.parse(fs.readFileSync(WALLETS_FILE, "utf-8"));
    const activeWallet = (walletsJson.wallets ?? [])[0];
    if (activeWallet?.id) {
      const keystorePath = path.join(WALLETS_DIR, activeWallet.id, "keystore.json");
      if (fs.existsSync(keystorePath)) {
        const keystore = JSON.parse(fs.readFileSync(keystorePath, "utf-8"));
        const enc = keystore.encrypted;
        if (enc?.ciphertext) {
          const { scryptSync, createDecipheriv } = await import("crypto");
          const salt = Buffer.from(enc.salt, "base64");
          const iv = Buffer.from(enc.iv, "base64");
          const authTag = Buffer.from(enc.authTag, "base64");
          const ciphertext = Buffer.from(enc.ciphertext, "base64");
          const key = scryptSync(password, salt, enc.scryptParams?.keyLen ?? 32, {
            N: enc.scryptParams?.N ?? 16384,
            r: enc.scryptParams?.r ?? 8,
            p: enc.scryptParams?.p ?? 1,
          });
          const decipher = createDecipheriv("aes-256-gcm", key, iv);
          decipher.setAuthTag(authTag);
          const mnemonic = Buffer.concat([decipher.update(ciphertext), decipher.final()])
            .toString("utf-8")
            .trim();
          const wallet = await generateWallet({ secretKey: mnemonic, password: "" });
          const account = wallet.accounts[0] ?? deriveAccount(wallet, 0);
          return { stxPrivateKey: account.stxPrivateKey, stxAddress: getStxAddress(account) };
        }
        const legacyEnc = keystore.encryptedMnemonic ?? keystore.encrypted_mnemonic;
        if (legacyEnc) {
          const { decryptMnemonic } = await import("@stacks/encryption" as string);
          const mnemonic = await decryptMnemonic(legacyEnc, password);
          const wallet = await generateWallet({ secretKey: mnemonic, password: "" });
          const account = wallet.accounts[0] ?? deriveAccount(wallet, 0);
          return { stxPrivateKey: account.stxPrivateKey, stxAddress: getStxAddress(account) };
        }
      }
    }
  }
  throw new Error("No wallet found. Run: npx @aibtc/mcp-server@latest --install");
}

async function fetchStxBalance(wallet: string): Promise<number> {
  const data = await fetchJson<Record<string, string>>(
    `${HIRO_API}/extended/v1/address/${wallet}/stx`
  );
  return Number(BigInt(data?.balance ?? "0")) / 1e6;
}

async function fetchNonce(wallet: string): Promise<bigint> {
  const data = await fetchJson<Record<string, unknown>>(
    `${HIRO_API}/extended/v1/address/${wallet}/nonces`
  );
  const nextNonce = data.possible_next_nonce;
  if (nextNonce != null) return BigInt(Number(nextNonce));
  const lastExec = data.last_executed_tx_nonce;
  if (lastExec != null) return BigInt(Number(lastExec) + 1);
  return 0n;
}

// ─── Bitflow API ──────────────────────────────────────────────────────────────

async function fetchPools(): Promise<PoolMeta[]> {
  const raw = await fetchJson<{ data?: unknown[]; results?: unknown[]; [k: string]: unknown }>(
    `${BITFLOW_APP}/pools?amm_type=dlmm`
  );
  const list = (raw.data ?? raw.results ?? (Array.isArray(raw) ? raw : [])) as Record<string, unknown>[];
  return list
    .filter((p) => p.poolId ?? p.pool_id)
    .map((p) => {
      // Bitflow App API uses camelCase. Support both for forward compat.
      const tokens = p.tokens as Record<string, Record<string, unknown>> | undefined;
      return {
        pool_id: String(p.poolId ?? p.pool_id ?? ""),
        pool_contract: String(p.poolContract ?? p.pool_contract ?? p.pool_token ?? ""),
        token_x: String(tokens?.tokenX?.contract ?? p.token_x ?? ""),
        token_y: String(tokens?.tokenY?.contract ?? p.token_y ?? ""),
        token_x_symbol: String(tokens?.tokenX?.symbol ?? p.token_x_symbol ?? "X"),
        token_y_symbol: String(tokens?.tokenY?.symbol ?? p.token_y_symbol ?? "Y"),
        token_x_decimals: Number(tokens?.tokenX?.decimals ?? p.token_x_decimals ?? 8),
        token_y_decimals: Number(tokens?.tokenY?.decimals ?? p.token_y_decimals ?? 6),
        bin_step: Number(p.binStep ?? p.bin_step ?? 0),
      };
    });
}

async function fetchUserPositions(poolId: string, wallet: string): Promise<UserBin[]> {
  try {
    const raw = await fetchJson<Record<string, unknown>>(
      `${BITFLOW_APP}/users/${wallet}/positions/${poolId}/bins`
    );
    const bins = ((raw.bins ?? raw.data ?? raw.positions ?? []) as Record<string, unknown>[]);
    return bins
      .filter((b) => BigInt(String(b.user_liquidity ?? b.liquidity ?? "0")) > 0n)
      .map((b) => ({
        bin_id: Number(b.bin_id),
        liquidity: String(b.user_liquidity ?? b.liquidity ?? "0"),
        reserve_x: String(b.reserve_x ?? "0"),
        reserve_y: String(b.reserve_y ?? "0"),
      }));
  } catch {
    return []; // 404 = no position in this pool
  }
}

async function fetchPoolBins(poolId: string): Promise<{ active_bin_id: number; bins: BinData[] }> {
  const raw = await fetchJson<Record<string, unknown>>(`${BITFLOW_QUOTES}/bins/${poolId}`);
  const activeBin = Number(raw.active_bin_id ?? 0);
  const bins = ((raw.bins ?? []) as Record<string, unknown>[]).map((b) => ({
    bin_id: Number(b.bin_id),
    reserve_x: String(b.reserve_x ?? "0"),
    reserve_y: String(b.reserve_y ?? "0"),
    price: String(b.price ?? "0"),
    liquidity: String(b.liquidity ?? "0"),
  }));
  return { active_bin_id: activeBin, bins };
}

// ─── Bitflow SDK (swap) ───────────────────────────────────────────────────────

async function getBitflow(): Promise<Record<string, (...a: unknown[]) => unknown>> {
  const { BitflowSDK } = await import("@bitflowlabs/core-sdk" as string);
  return new (BitflowSDK as new (c: Record<string, unknown>) => Record<string, (...a: unknown[]) => unknown>)({
    BITFLOW_API_HOST: process.env.BITFLOW_API_HOST ?? "https://api.bitflowapis.finance",
    BITFLOW_API_KEY: process.env.BITFLOW_API_KEY ?? "",
    STACKS_API_URL: HIRO_API,
    KEEPER_API_HOST: process.env.KEEPER_API_HOST ?? "https://api.bitflowapis.finance",
    KEEPER_API_URL: process.env.KEEPER_API_URL ?? "https://api.bitflowapis.finance",
  });
}

// ─── Position analysis ────────────────────────────────────────────────────────

interface PositionSummary {
  pool_id: string;
  pair: string;
  active_bin: number;
  user_bins: number[];
  min_bin: number;
  max_bin: number;
  center_bin: number;
  drift: number;
  in_range: boolean;
  total_x: bigint;
  total_y: bigint;
  imbalance_pct: number;
  value_stx_approx: number;
}

function analyzePosition(pool: PoolMeta, userBins: UserBin[], activeBin: number, poolBins: BinData[]): PositionSummary {
  const poolBinMap = new Map(poolBins.map((b) => [b.bin_id, b]));
  const binIds = userBins.map((b) => b.bin_id);
  const minBin = binIds.length > 0 ? Math.min(...binIds) : 0;
  const maxBin = binIds.length > 0 ? Math.max(...binIds) : 0;
  const centerBin = binIds.length > 0 ? Math.round((minBin + maxBin) / 2) : activeBin;
  const drift = Math.abs(activeBin - centerBin);
  const inRange = binIds.length > 0 && activeBin >= minBin && activeBin <= maxBin;

  let totalX = 0n;
  let totalY = 0n;
  for (const b of userBins) {
    const dlp = BigInt(b.liquidity);
    const rx = BigInt(b.reserve_x || "0");
    const ry = BigInt(b.reserve_y || "0");
    if (rx > 0n || ry > 0n) {
      totalX += rx;
      totalY += ry;
    } else {
      const pb = poolBinMap.get(b.bin_id);
      if (pb && dlp > 0n) {
        const poolDlp = BigInt(pb.liquidity || "1");
        if (poolDlp > 0n) {
          totalX += (dlp * BigInt(pb.reserve_x)) / poolDlp;
          totalY += (dlp * BigInt(pb.reserve_y)) / poolDlp;
        }
      }
    }
  }

  const xNorm = Number(totalX) / 10 ** pool.token_x_decimals;
  const yNorm = Number(totalY) / 10 ** pool.token_y_decimals;
  const total = xNorm + yNorm;
  const imbalancePct = total > 0 ? Math.abs(xNorm / total - 0.5) * 100 : 0;

  return {
    pool_id: pool.pool_id,
    pair: `${pool.token_x_symbol}/${pool.token_y_symbol}`,
    active_bin: activeBin,
    user_bins: binIds,
    min_bin: minBin,
    max_bin: maxBin,
    center_bin: centerBin,
    drift,
    in_range: inRange,
    total_x: totalX,
    total_y: totalY,
    imbalance_pct: Math.round(imbalancePct * 100) / 100,
    value_stx_approx: xNorm, // rough: assumes token_x is STX or sBTC
  };
}

// ─── Transaction execution ────────────────────────────────────────────────────

async function withdrawBins(opts: {
  pool: PoolMeta;
  userBins: UserBin[];
  stxPrivateKey: string;
  stxAddress: string;
  nonce: bigint;
}): Promise<{ txId: string; totalX: bigint; totalY: bigint }> {
  const {
    makeContractCall, broadcastTransaction,
    listCV, tupleCV, intCV, uintCV, contractPrincipalCV,
    PostConditionMode, AnchorMode,
  } = await import("@stacks/transactions" as string);
  const { STACKS_MAINNET } = await import("@stacks/network" as string);

  const { pool, userBins, stxPrivateKey, nonce } = opts;
  const [xAddr, xName] = pool.token_x.split(".");
  const [yAddr, yName] = pool.token_y.split(".");
  const [poolAddr, poolName] = pool.pool_contract.split(".");

  // Build per-bin positions with per-bin min amounts (95% floor)
  let totalExpectedX = 0n;
  let totalExpectedY = 0n;

  const positions = userBins.map((b) => {
    const dlp = BigInt(b.liquidity);
    const rxEst = BigInt(b.reserve_x || "0");
    const ryEst = BigInt(b.reserve_y || "0");
    totalExpectedX += rxEst;
    totalExpectedY += ryEst;
    const signedBinId = b.bin_id - CENTER_BIN_ID;
    return tupleCV({
      amount: uintCV(dlp),
      "bin-id": intCV(signedBinId),
      "min-x-amount": uintCV((rxEst * 90n) / 100n),
      "min-y-amount": uintCV((ryEst * 90n) / 100n),
      "pool-trait": contractPrincipalCV(poolAddr, poolName),
    });
  });

  const tx = await makeContractCall({
    contractAddress: ROUTER_ADDR,
    contractName: ROUTER_NAME,
    functionName: "withdraw-liquidity-same-multi",
    functionArgs: [
      listCV(positions),
      contractPrincipalCV(xAddr, xName),
      contractPrincipalCV(yAddr, yName),
      uintCV((totalExpectedX * 90n) / 100n),
      uintCV((totalExpectedY * 90n) / 100n),
    ],
    senderKey: stxPrivateKey,
    network: STACKS_MAINNET,
    postConditionMode: PostConditionMode.Allow,
    anchorMode: AnchorMode.Any,
    nonce,
    fee: 15000n,
  });

  const result = await broadcastTransaction({ transaction: tx, network: STACKS_MAINNET });
  if ("error" in result && result.error) {
    throw new Error(`Withdraw broadcast failed: ${result.error} — ${(result as Record<string, string>).reason ?? ""}`);
  }
  return { txId: result.txid as string, totalX: totalExpectedX, totalY: totalExpectedY };
}

async function addBalancedLiquidity(opts: {
  pool: PoolMeta;
  amountX: bigint;
  amountY: bigint;
  activeBin: number;
  stxPrivateKey: string;
  nonce: bigint;
}): Promise<{ txId: string }> {
  const {
    makeContractCall, broadcastTransaction,
    listCV, tupleCV, intCV, uintCV, contractPrincipalCV, noneCV, someCV,
    PostConditionMode, AnchorMode,
  } = await import("@stacks/transactions" as string);
  const { STACKS_MAINNET } = await import("@stacks/network" as string);

  const { pool, amountX, amountY, activeBin, stxPrivateKey, nonce } = opts;
  const [xAddr, xName] = pool.token_x.split(".");
  const [yAddr, yName] = pool.token_y.split(".");
  const [poolAddr, poolName] = pool.pool_contract.split(".");

  const binCount = BIN_SPREAD * 2 + 1;
  const perBinX = amountX / BigInt(binCount);
  const perBinY = amountY / BigInt(binCount);
  const maxFeeX = (perBinX * 5n) / 100n;
  const maxFeeY = (perBinY * 5n) / 100n;

  const positions = Array.from({ length: binCount }, (_, i) => {
    const offset = i - BIN_SPREAD; // -5 to +5
    return tupleCV({
      "active-bin-id-offset": intCV(offset),
      "max-x-liquidity-fee": uintCV(maxFeeX),
      "max-y-liquidity-fee": uintCV(maxFeeY),
      "min-dlp": uintCV(0n),
      "x-amount": uintCV(perBinX),
      "y-amount": uintCV(perBinY),
    });
  });

  const tx = await makeContractCall({
    contractAddress: ROUTER_ADDR,
    contractName: ROUTER_NAME,
    functionName: "add-relative-liquidity-same-multi",
    functionArgs: [
      listCV(positions),
      contractPrincipalCV(poolAddr, poolName),
      contractPrincipalCV(xAddr, xName),
      contractPrincipalCV(yAddr, yName),
      someCV(tupleCV({ "expected-bin-id": intCV(activeBin - CENTER_BIN_ID), "max-deviation": uintCV(5n) })),
    ],
    senderKey: stxPrivateKey,
    network: STACKS_MAINNET,
    postConditionMode: PostConditionMode.Allow,
    anchorMode: AnchorMode.Any,
    nonce,
    fee: 15000n,
  });

  const result = await broadcastTransaction({ transaction: tx, network: STACKS_MAINNET });
  if ("error" in result && result.error) {
    throw new Error(`Add-liquidity broadcast failed: ${result.error} — ${(result as Record<string, string>).reason ?? ""}`);
  }
  return { txId: result.txid as string };
}

// ─── Swap step ────────────────────────────────────────────────────────────────

interface SwapResult {
  txId: string | null;
  direction: "x-to-y" | "y-to-x" | "none";
  amountIn: number;
  expectedOut: number;
  priceImpact: number;
  newX: bigint;
  newY: bigint;
}

async function swapToRebalance(opts: {
  pool: PoolMeta;
  totalX: bigint;
  totalY: bigint;
  stxPrivateKey: string;
  stxAddress: string;
  dryRun: boolean;
}): Promise<SwapResult> {
  const { pool, totalX, totalY, stxPrivateKey, stxAddress, dryRun } = opts;

  const xNorm = Number(totalX) / 10 ** pool.token_x_decimals;
  const yNorm = Number(totalY) / 10 ** pool.token_y_decimals;
  const total = xNorm + yNorm;
  if (total === 0) return { txId: null, direction: "none", amountIn: 0, expectedOut: 0, priceImpact: 0, newX: 0n, newY: 0n };

  const xRatio = xNorm / total;
  if (Math.abs(xRatio - 0.5) < 0.02) {
    // < 2% off — skip swap
    return { txId: null, direction: "none", amountIn: 0, expectedOut: 0, priceImpact: 0, newX: totalX, newY: totalY };
  }

  const sdk = await getBitflow();
  let tokenInId: string;
  let tokenOutId: string;
  let excessHuman: number;
  let direction: "x-to-y" | "y-to-x";

  if (xRatio > 0.5) {
    excessHuman = (xNorm - total / 2) / 2; // swap half the excess to avoid recursion
    tokenInId = pool.token_x;
    tokenOutId = pool.token_y;
    direction = "x-to-y";
  } else {
    excessHuman = (yNorm - total / 2) / 2;
    tokenInId = pool.token_y;
    tokenOutId = pool.token_x;
    direction = "y-to-x";
  }

  if (excessHuman <= 0) {
    return { txId: null, direction: "none", amountIn: 0, expectedOut: 0, priceImpact: 0, newX: totalX, newY: totalY };
  }

  const quoteResult = await sdk.getQuoteForRoute(tokenInId, tokenOutId, excessHuman) as Record<string, unknown>;
  const bestRoute = quoteResult?.bestRoute as Record<string, unknown> | undefined;
  if (!bestRoute) throw new Error(`No swap route ${pool.token_x_symbol}→${pool.token_y_symbol}`);

  const priceImpact = Number(bestRoute.priceImpact ?? 0);
  if (priceImpact > MAX_SLIPPAGE_PCT) {
    throw new Error(`Swap price impact ${priceImpact.toFixed(2)}% exceeds max ${MAX_SLIPPAGE_PCT}%`);
  }

  const expectedOut = Number(bestRoute.quote ?? 0);

  // Estimate new balances
  const inMicro = BigInt(Math.floor(excessHuman * 10 ** (direction === "x-to-y" ? pool.token_x_decimals : pool.token_y_decimals)));
  const outMicro = BigInt(Math.floor(expectedOut * 10 ** (direction === "x-to-y" ? pool.token_y_decimals : pool.token_x_decimals)));
  const newX = direction === "x-to-y" ? totalX - inMicro : totalX + outMicro;
  const newY = direction === "y-to-x" ? totalY - inMicro : totalY + outMicro;

  if (dryRun) {
    return { txId: null, direction, amountIn: excessHuman, expectedOut, priceImpact, newX, newY };
  }

  const swapExecutionData = {
    route: bestRoute.route,
    tokenXAmount: excessHuman,
    slippage: MAX_SLIPPAGE_PCT / 100,
    senderAddress: stxAddress,
  };
  const swapParams = await sdk.prepareSwap(swapExecutionData, stxAddress) as Record<string, unknown>;

  const {
    makeContractCall, broadcastTransaction, AnchorMode, PostConditionMode,
  } = await import("@stacks/transactions" as string);
  const { STACKS_MAINNET } = await import("@stacks/network" as string);

  const tx = await makeContractCall({
    contractAddress: swapParams.contractAddress as string,
    contractName: swapParams.contractName as string,
    functionName: swapParams.functionName as string,
    functionArgs: swapParams.functionArgs as unknown[],
    postConditions: swapParams.postConditions as unknown[],
    postConditionMode: PostConditionMode.Deny,
    senderKey: stxPrivateKey,
    network: STACKS_MAINNET,
    anchorMode: AnchorMode.Any,
    fee: 8000n,
  });

  const result = await broadcastTransaction({ transaction: tx, network: STACKS_MAINNET });
  if ("error" in result && result.error) {
    throw new Error(`Swap broadcast failed: ${result.error}`);
  }
  return { txId: result.txid as string, direction, amountIn: excessHuman, expectedOut, priceImpact, newX, newY };
}

// ─── doctor ───────────────────────────────────────────────────────────────────

async function cmdDoctor(): Promise<void> {
  const checks: Record<string, { ok: boolean; message: string }> = {};

  try {
    const pools = await fetchPools();
    checks.bitflow_api = { ok: pools.length > 0, message: `${pools.length} DLMM pools available` };
  } catch (e: unknown) {
    checks.bitflow_api = { ok: false, message: `Bitflow API error: ${(e as Error).message}` };
  }

  try {
    const binsData = await fetchPoolBins("dlmm_1");
    checks.bitflow_bins = { ok: binsData.active_bin_id > 0, message: `dlmm_1 active_bin=${binsData.active_bin_id}` };
  } catch (e: unknown) {
    checks.bitflow_bins = { ok: false, message: `Bins API error: ${(e as Error).message}` };
  }

  try {
    const data = await fetchJson<Record<string, unknown>>(
      `${HIRO_API}/extended/v1/info/network_block_times`
    );
    checks.hiro_api = { ok: !!data.mainnet, message: "Hiro API reachable" };
  } catch (e: unknown) {
    checks.hiro_api = { ok: false, message: `Hiro API error: ${(e as Error).message}` };
  }

  try {
    const resp = await fetchJson<Record<string, unknown>>(
      `${HIRO_API}/extended/v1/contract/${ROUTER_ADDR}.${ROUTER_NAME}`
    );
    checks.dlmm_router = {
      ok: !!resp.tx_id,
      message: resp.tx_id ? `Router verified at ${ROUTER_ADDR}.${ROUTER_NAME}` : "Router not found",
    };
  } catch (e: unknown) {
    checks.dlmm_router = { ok: false, message: `Router check failed: ${(e as Error).message}` };
  }

  try {
    const sdk = await getBitflow();
    const tokens = await sdk.getAvailableTokens() as unknown[];
    checks.bitflow_sdk = { ok: tokens.length > 0, message: `Bitflow SDK OK — ${tokens.length} tokens` };
  } catch (e: unknown) {
    checks.bitflow_sdk = { ok: false, message: `Bitflow SDK error: ${(e as Error).message}` };
  }

  try {
    const password = process.env.AIBTC_WALLET_PASSWORD ?? "";
    if (!password) throw new Error("AIBTC_WALLET_PASSWORD not set");
    const { stxAddress } = await getWalletKeys(password);
    const balance = await fetchStxBalance(stxAddress).catch(() => 0);
    checks.wallet = { ok: true, message: `${stxAddress} — ${balance.toFixed(2)} STX` };
  } catch (e: unknown) {
    checks.wallet = { ok: false, message: `Wallet error: ${(e as Error).message}` };
  }

  const allOk = Object.values(checks).every((c) => c.ok);
  out(allOk ? "success" : "degraded" as "success", "doctor", { checks, ready: allOk });
}

// ─── scan ─────────────────────────────────────────────────────────────────────

async function cmdScan(poolSlug?: string): Promise<void> {
  const password = process.env.AIBTC_WALLET_PASSWORD ?? "";
  if (!password) {
    out("error", "scan", null, "AIBTC_WALLET_PASSWORD not set");
    return;
  }
  const { stxAddress } = await getWalletKeys(password);
  const pools = await fetchPools();
  const targets = poolSlug ? pools.filter((p) => p.pool_id === poolSlug) : pools;

  const results = [];
  for (const pool of targets) {
    try {
      const [userBins, binsData] = await Promise.all([
        fetchUserPositions(pool.pool_id, stxAddress),
        fetchPoolBins(pool.pool_id),
      ]);
      if (userBins.length === 0) continue;

      const summary = analyzePosition(pool, userBins, binsData.active_bin_id, binsData.bins);
      const { cooling, remainingMs } = isCoolingDown(pool.pool_id);
      const state = loadState();

      const shouldCompound =
        summary.drift >= DRIFT_THRESHOLD_BINS || summary.imbalance_pct >= IMBALANCE_THRESHOLD_PCT;

      results.push({
        pool_id: summary.pool_id,
        pair: summary.pair,
        active_bin: summary.active_bin,
        user_bins_count: summary.user_bins.length,
        drift_bins: summary.drift,
        imbalance_pct: summary.imbalance_pct,
        in_range: summary.in_range,
        total_x: summary.total_x.toString(),
        total_y: summary.total_y.toString(),
        cooling_down: cooling,
        cooling_remaining_min: cooling ? Math.ceil(remainingMs / 60_000) : 0,
        last_compound_at: state[pool.pool_id]?.last_compound_at ?? null,
        compound_cycles: state[pool.pool_id]?.cycles ?? 0,
        should_compound: shouldCompound && !cooling,
        trigger: shouldCompound
          ? `drift=${summary.drift} OR imbalance=${summary.imbalance_pct}%`
          : "below threshold",
      });
    } catch (e: unknown) {
      results.push({ pool_id: pool.pool_id, error: (e as Error).message });
    }
  }

  if (results.length === 0) {
    out("success", "scan", { message: "No HODLMM positions found", address: stxAddress });
    return;
  }
  out("success", "scan", { address: stxAddress, positions: results });
}

// ─── run ──────────────────────────────────────────────────────────────────────

async function cmdRun(poolSlug: string, confirm: boolean): Promise<void> {
  const password = process.env.AIBTC_WALLET_PASSWORD ?? "";
  if (!password) { out("error", "run", null, "AIBTC_WALLET_PASSWORD not set"); return; }

  const { stxPrivateKey, stxAddress } = await getWalletKeys(password);
  const pools = await fetchPools();
  const pool = pools.find((p) => p.pool_id === poolSlug);
  if (!pool) { out("error", "run", { pool: poolSlug }, "Pool not found — run scan to list pools"); return; }

  const { cooling, remainingMs } = isCoolingDown(pool.pool_id);
  if (cooling) {
    out("blocked", "run", { pool: poolSlug, cooling_remaining_min: Math.ceil(remainingMs / 60_000) },
      "Cooldown active — wait before next compound");
    return;
  }

  const [userBins, binsData] = await Promise.all([
    fetchUserPositions(pool.pool_id, stxAddress),
    fetchPoolBins(pool.pool_id),
  ]);

  if (userBins.length === 0) {
    out("success", "run", { pool: poolSlug, message: "No position in this pool" });
    return;
  }

  const activeBin = binsData.active_bin_id;
  const summary = analyzePosition(pool, userBins, activeBin, binsData.bins);

  // Dust guard
  if (summary.value_stx_approx < MIN_POSITION_VALUE_STX) {
    out("blocked", "run",
      { pool: poolSlug, value_approx: summary.value_stx_approx, minimum: MIN_POSITION_VALUE_STX },
      `Position below minimum ${MIN_POSITION_VALUE_STX} STX — not worth compounding`);
    return;
  }

  // Preview swap
  const swapPreview = await swapToRebalance({
    pool, totalX: summary.total_x, totalY: summary.total_y,
    stxPrivateKey, stxAddress, dryRun: true,
  });

  if (!confirm) {
    out("blocked", "run", {
      pool: poolSlug,
      position: {
        drift_bins: summary.drift,
        imbalance_pct: summary.imbalance_pct,
        in_range: summary.in_range,
        user_bins: summary.user_bins.length,
        total_x: summary.total_x.toString(),
        total_y: summary.total_y.toString(),
      },
      withdraw_step: "remove all liquidity from current bins",
      swap_step: swapPreview.direction === "none"
        ? "no swap needed (<2% imbalance)"
        : {
          direction: swapPreview.direction,
          amount_in: swapPreview.amountIn,
          expected_out: swapPreview.expectedOut,
          price_impact_pct: swapPreview.priceImpact,
        },
      add_step: `re-add balanced liquidity to bins [${activeBin - BIN_SPREAD}..${activeBin + BIN_SPREAD}]`,
      hint: "Add --confirm to execute on-chain",
    }, null);
    return;
  }

  // Execute
  const nonce = await fetchNonce(stxAddress);

  log("Step 1: Withdrawing all liquidity...");
  const { txId: withdrawTxId, totalX, totalY } = await withdrawBins({
    pool, userBins, stxPrivateKey, stxAddress, nonce,
  });
  log(`Withdraw tx: ${withdrawTxId}`);

  let swapTxId: string | null = null;
  let reAddX = totalX;
  let reAddY = totalY;

  if (swapPreview.direction !== "none") {
    log("Step 2: Swapping to rebalance ratio...");
    const swapResult = await swapToRebalance({
      pool, totalX, totalY, stxPrivateKey, stxAddress, dryRun: false,
    });
    swapTxId = swapResult.txId;
    reAddX = swapResult.newX;
    reAddY = swapResult.newY;
    log(`Swap tx: ${swapTxId}`);
  }

  log("Step 3: Adding balanced liquidity...");
  const addNonce = nonce + (swapTxId ? 2n : 1n);
  const { txId: addTxId } = await addBalancedLiquidity({
    pool, amountX: reAddX, amountY: reAddY, activeBin, stxPrivateKey, nonce: addNonce,
  });
  log(`Add tx: ${addTxId}`);

  // Save state
  const state = loadState();
  state[pool.pool_id] = {
    last_compound_at: new Date().toISOString(),
    cycles: (state[pool.pool_id]?.cycles ?? 0) + 1,
  };
  saveState(state);

  out("success", "compound", {
    pool: poolSlug,
    withdraw_tx: { txId: withdrawTxId, explorer: `${EXPLORER}/${withdrawTxId}?chain=mainnet` },
    swap_tx: swapTxId
      ? { txId: swapTxId, explorer: `${EXPLORER}/${swapTxId}?chain=mainnet` }
      : "skipped — ratio already balanced",
    add_tx: { txId: addTxId, explorer: `${EXPLORER}/${addTxId}?chain=mainnet` },
    token_x_withdrawn: totalX.toString(),
    token_y_withdrawn: totalY.toString(),
    active_bin: activeBin,
    bins_target: [activeBin - BIN_SPREAD, activeBin + BIN_SPREAD],
    cycle_count: state[pool.pool_id].cycles,
  });
}

// ─── auto ─────────────────────────────────────────────────────────────────────

async function cmdAuto(poolSlug?: string): Promise<void> {
  const password = process.env.AIBTC_WALLET_PASSWORD ?? "";
  if (!password) { out("error", "auto", null, "AIBTC_WALLET_PASSWORD not set"); return; }

  const { stxAddress } = await getWalletKeys(password);
  const pools = await fetchPools();
  const targets = poolSlug ? pools.filter((p) => p.pool_id === poolSlug) : pools;

  const compounded: string[] = [];
  const skipped: Array<Record<string, unknown>> = [];

  for (const pool of targets) {
    try {
      const { cooling } = isCoolingDown(pool.pool_id);
      if (cooling) { skipped.push({ pool: pool.pool_id, reason: "cooldown" }); continue; }

      const [userBins, binsData] = await Promise.all([
        fetchUserPositions(pool.pool_id, stxAddress),
        fetchPoolBins(pool.pool_id),
      ]);
      if (userBins.length === 0) { skipped.push({ pool: pool.pool_id, reason: "no-position" }); continue; }

      const summary = analyzePosition(pool, userBins, binsData.active_bin_id, binsData.bins);
      const shouldCompound =
        summary.drift >= DRIFT_THRESHOLD_BINS || summary.imbalance_pct >= IMBALANCE_THRESHOLD_PCT;

      if (!shouldCompound) {
        skipped.push({ pool: pool.pool_id, reason: "below-threshold", drift: summary.drift, imbalance: summary.imbalance_pct });
        continue;
      }

      if (summary.value_stx_approx < MIN_POSITION_VALUE_STX) {
        skipped.push({ pool: pool.pool_id, reason: "below-minimum-value" });
        continue;
      }

      log(`Compounding ${pool.pool_id}: drift=${summary.drift}, imbalance=${summary.imbalance_pct}%`);
      await cmdRun(pool.pool_id, true);
      compounded.push(pool.pool_id);
    } catch (e: unknown) {
      skipped.push({ pool: pool.pool_id, reason: "error", error: (e as Error).message });
    }
  }

  out("success", "auto", { compounded, skipped, total_checked: targets.length });
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

const program = new Command();
program.name("hodlmm-compound").description("Autocompound Bitflow HODLMM DLMM positions");

program
  .command("doctor")
  .description("Check environment readiness")
  .action(async () => { await cmdDoctor().catch((e: unknown) => out("error", "doctor", null, String(e))); });

program
  .command("scan")
  .description("Show positions, drift, and token imbalance")
  .option("--pool <slug>", "Filter to a specific pool ID (e.g. dlmm_1)")
  .action(async (opts: { pool?: string }) => {
    await cmdScan(opts.pool).catch((e: unknown) => out("error", "scan", null, String(e)));
  });

program
  .command("run")
  .description("Execute one compound cycle (dry-run unless --confirm)")
  .requiredOption("--pool <slug>", "Target pool ID (e.g. dlmm_1)")
  .option("--confirm", "Execute on-chain")
  .action(async (opts: { pool: string; confirm?: boolean }) => {
    await cmdRun(opts.pool, !!opts.confirm).catch((e: unknown) => out("error", "run", null, String(e)));
  });

program
  .command("auto")
  .description("Autonomous compound loop (all pools or one)")
  .option("--pool <slug>", "Limit to a specific pool ID")
  .action(async (opts: { pool?: string }) => {
    await cmdAuto(opts.pool).catch((e: unknown) => out("error", "auto", null, String(e)));
  });

program.parse(process.argv);
