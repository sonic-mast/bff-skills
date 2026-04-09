#!/usr/bin/env bun
/**
 * Bitflow Spot Swap — single on-demand token swap on Bitflow DEX
 *
 * Commands: doctor | install-packs | quote | swap
 *
 * All commands emit strict JSON to stdout. Debug to stderr.
 * Mandatory --confirm gate on swap — preview quote, then confirm.
 *
 * Usage: bun run bitflow-spot-swap/bitflow-spot-swap.ts <command> [options]
 */

import { Command } from "commander";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as crypto from "crypto";

// ─── Constants ────────────────────────────────────────────────────────────────

const WALLETS_FILE = path.join(os.homedir(), ".aibtc", "wallets.json");
const WALLETS_DIR = path.join(os.homedir(), ".aibtc", "wallets");
const STACKS_API = "https://api.hiro.so";
const EXPLORER_BASE = "https://explorer.hiro.so/txid";

// Hard limits — thrown as errors, not suggestions
const MAX_SLIPPAGE_PCT = 5;
const MIN_GAS_USTX = 500_000n; // 0.5 STX reserved for gas — enforced before every write

// ─── Types ────────────────────────────────────────────────────────────────────

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

function blockedOut(action: string, data: Record<string, unknown>): void {
  out({ status: "blocked", action, data, error: null });
}

function fail(code: string, message: string, next: string = "Check error and retry", data: Record<string, unknown> = {}): void {
  out({ status: "error", action: next, data, error: { code, message, next } });
}

// ─── Wallet helpers ───────────────────────────────────────────────────────────

function walletExists(): boolean {
  return fs.existsSync(WALLETS_FILE) || fs.existsSync(path.join(os.homedir(), ".aibtc", "wallet.json"));
}

async function decryptAibtcKeystore(enc: Record<string, unknown>, password: string): Promise<string> {
  const { scryptSync, createDecipheriv } = await import("crypto");
  const { N, r, p, keyLen } = enc.scryptParams as { N: number; r: number; p: number; keyLen: number };
  const salt = Buffer.from(enc.salt as string, "base64");
  const iv = Buffer.from(enc.iv as string, "base64");
  const authTag = Buffer.from(enc.authTag as string, "base64");
  const ciphertext = Buffer.from(enc.ciphertext as string, "base64");
  const key = scryptSync(password, salt, keyLen ?? 32, { N, r, p });
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return decrypted.toString("utf-8").trim();
}

async function getWalletKeys(password: string): Promise<{ stxPrivateKey: string; stxAddress: string }> {
  // 1. Direct private key env var (for automation / smoke tests)
  if (process.env.STACKS_PRIVATE_KEY) {
    const { getAddressFromPrivateKey } = await import("@stacks/transactions" as any);
    const key = process.env.STACKS_PRIVATE_KEY as string;
    const address = getAddressFromPrivateKey(key, "mainnet");
    return { stxPrivateKey: key, stxAddress: address };
  }

  const { generateWallet, deriveAccount, getStxAddress } = await import("@stacks/wallet-sdk" as any);

  // 2. AIBTC wallets.json + keystore.json (MCP server v1 format)
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
            // AIBTC custom AES-256-GCM + scrypt — password used only for keystore decryption
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

  // 3. Legacy wallet.json fallback
  const legacyPath = path.join(os.homedir(), ".aibtc", "wallet.json");
  if (fs.existsSync(legacyPath)) {
    try {
      const w = JSON.parse(fs.readFileSync(legacyPath, "utf-8"));
      // Plain mnemonic: use directly without a password
      if (w.mnemonic) {
        const wallet = await generateWallet({ secretKey: w.mnemonic, password: "" });
        const account = deriveAccount(wallet, 0);
        return { stxPrivateKey: account.stxPrivateKey, stxAddress: getStxAddress(account) };
      }
      // Encrypted mnemonic: must decrypt before passing to generateWallet
      const encMnemonic = w.encrypted_mnemonic ?? w.encryptedMnemonic;
      if (encMnemonic) {
        const { decryptMnemonic } = await import("@stacks/encryption" as any);
        const mnemonic = await decryptMnemonic(encMnemonic, password);
        const wallet = await generateWallet({ secretKey: mnemonic, password: "" });
        const account = deriveAccount(wallet, 0);
        return { stxPrivateKey: account.stxPrivateKey, stxAddress: getStxAddress(account) };
      }
    } catch { /* fall through */ }
  }

  throw new Error(
    "No wallet found or decryption failed.\n" +
    "Run: npx @aibtc/mcp-server@latest --install"
  );
}

// ─── Balance helpers ──────────────────────────────────────────────────────────

async function getStxBalance(address: string): Promise<bigint> {
  const res = await fetch(`${STACKS_API}/v2/accounts/${address}?proof=0`, {
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Balance fetch failed: ${res.status}`);
  const data = await res.json() as { balance: string; locked: string };
  // BigInt() handles "0x"-prefixed hex natively — no precision loss
  return BigInt(data.balance) - BigInt(data.locked || "0");
}

// ─── SDK timeout helper ───────────────────────────────────────────────────────

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    ),
  ]);
}

// ─── Bitflow SDK helpers ──────────────────────────────────────────────────────

async function getBitflowSdk(): Promise<any> {
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

async function findToken(
  sdk: any,
  symbol: string
): Promise<{ tokenId: string; tokenDecimals: number; symbol: string } | null> {
  const tokens = await withTimeout(sdk.getAvailableTokens(), 10_000, "getAvailableTokens");
  const sym = symbol.toLowerCase();
  const match = tokens.find((t: any) =>
    (t.symbol ?? "").toLowerCase() === sym ||
    (t.tokenId ?? "").toLowerCase() === sym ||
    (t["token-id"] ?? "").toLowerCase() === sym
  );
  if (!match) return null;
  const tokenDecimals = match.tokenDecimals ?? match.decimals;
  if (tokenDecimals === undefined || tokenDecimals === null) {
    // Cannot safely determine decimals — refusing to default to avoid incorrect scaling
    process.stderr.write(`Token ${symbol}: no decimals metadata from SDK\n`);
    return null;
  }
  return {
    tokenId: match.tokenId ?? match["token-id"],
    tokenDecimals,
    symbol: match.symbol ?? symbol.toUpperCase(),
  };
}

async function fetchQuote(
  sdk: any,
  tokenInId: string,
  tokenOutId: string,
  amountHuman: number
): Promise<{ expectedAmountOut: number; route: any; priceImpact: number | null } | null> {
  try {
    const result = await withTimeout(sdk.getQuoteForRoute(tokenInId, tokenOutId, amountHuman), 10_000, "getQuoteForRoute");
    if (!result?.bestRoute?.quote) return null;
    return {
      expectedAmountOut: result.bestRoute.quote,
      route: result.bestRoute.route,
      priceImpact: result.bestRoute.priceImpact ?? null,
    };
  } catch {
    return null;
  }
}

async function executeSwap(opts: {
  sdk: any;
  tokenIn: { tokenId: string; tokenDecimals: number; symbol: string };
  tokenOut: { tokenId: string; tokenDecimals: number; symbol: string };
  amountHuman: number;
  senderAddress: string;
  stxPrivateKey: string;
  slippagePct: number;
  dryRun: boolean;
}): Promise<{ txId: string; explorerUrl: string; actualAmountOut: number }> {
  const {
    makeContractCall, broadcastTransaction,
    AnchorMode, PostConditionMode,
  } = await import("@stacks/transactions" as any);
  const { STACKS_MAINNET } = await import("@stacks/network" as any);
  const network = STACKS_MAINNET;
  const slippageDecimal = opts.slippagePct / 100;

  // Get best route from SDK
  const quoteResult = await withTimeout(
    opts.sdk.getQuoteForRoute(opts.tokenIn.tokenId, opts.tokenOut.tokenId, opts.amountHuman),
    10_000,
    "getQuoteForRoute"
  );
  if (!quoteResult?.bestRoute?.route) {
    throw new Error(`No swap route for ${opts.tokenIn.symbol} → ${opts.tokenOut.symbol}`);
  }

  const swapExecutionData = {
    route: quoteResult.bestRoute.route,
    amount: opts.amountHuman,
    tokenXDecimals: opts.tokenIn.tokenDecimals,
    tokenYDecimals: opts.tokenOut.tokenDecimals,
  };

  const swapParams = await withTimeout(
    opts.sdk.prepareSwap(swapExecutionData, opts.senderAddress, slippageDecimal),
    10_000,
    "prepareSwap"
  );

  if (opts.dryRun) {
    const fakeTxId = "dry-run-" + crypto.randomBytes(8).toString("hex");
    return {
      txId: fakeTxId,
      explorerUrl: `${EXPLORER_BASE}/${fakeTxId}?chain=mainnet`,
      actualAmountOut: quoteResult.bestRoute.quote,
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
    fee: 50000n,
  });

  const broadcastRes = await broadcastTransaction({ transaction: tx, network });
  if (broadcastRes.error) {
    throw new Error(`Broadcast failed: ${broadcastRes.error} — ${broadcastRes.reason ?? ""}`);
  }

  const txId: string = broadcastRes.txid;
  return {
    txId,
    explorerUrl: `${EXPLORER_BASE}/${txId}?chain=mainnet`,
    actualAmountOut: quoteResult.bestRoute.quote,
  };
}

// ─── Commands ─────────────────────────────────────────────────────────────────

async function cmdDoctor(): Promise<void> {
  const checks: Record<string, { ok: boolean; message: string }> = {};

  // Bitflow SDK + API
  try {
    const sdk = await getBitflowSdk();
    const tokens = await withTimeout(sdk.getAvailableTokens(), 10_000, "getAvailableTokens");
    checks.bitflow = { ok: true, message: `Bitflow API reachable — ${tokens.length} tokens available` };
  } catch (e: any) {
    checks.bitflow = { ok: false, message: `Bitflow SDK error: ${e.message}. Run install-packs first.` };
  }

  // Stacks API
  try {
    const res = await fetch(`${STACKS_API}/v2/info`, { signal: AbortSignal.timeout(8_000) });
    checks.stacks_api = res.ok
      ? { ok: true, message: "Stacks mainnet reachable" }
      : { ok: false, message: `Stacks API returned ${res.status}` };
  } catch (e: any) {
    checks.stacks_api = { ok: false, message: `Stacks API unreachable: ${e.message}` };
  }

  // Wallet
  checks.wallet = walletExists()
    ? { ok: true, message: "Wallet file found" }
    : { ok: false, message: "No wallet — run: npx @aibtc/mcp-server@latest --install" };

  const allOk = Object.values(checks).every((c) => c.ok);
  if (allOk) {
    success("Doctor passed — ready to swap", { checks });
  } else {
    fail(
      "DOCTOR_FAILED",
      Object.entries(checks).filter(([, v]) => !v.ok).map(([k, v]) => `${k}: ${v.message}`).join("; "),
      "Fix reported issues and re-run doctor",
      { checks }
    );
    process.exit(1);
  }
}

async function cmdInstallPacks(): Promise<void> {
  const { execSync } = await import("child_process");
  const packages = [
    "@bitflowlabs/core-sdk",
    "@stacks/transactions",
    "@stacks/network",
    "@stacks/wallet-sdk",
    "@stacks/encryption",
    "commander",
  ];
  process.stderr.write(`Installing: ${packages.join(", ")}\n`);
  execSync(`bun add ${packages.join(" ")}`, { stdio: "inherit" });
  success("Dependencies installed", { packages });
}

async function cmdQuote(opts: { tokenIn: string; tokenOut: string; amount: string }): Promise<void> {
  const amountHuman = parseFloat(opts.amount);
  if (isNaN(amountHuman) || amountHuman <= 0) {
    fail("INVALID_AMOUNT", "Amount must be a positive number");
    return;
  }

  let sdk: any;
  try {
    sdk = await getBitflowSdk();
  } catch (e: any) {
    fail("SDK_ERROR", `Bitflow SDK load failed: ${e.message}`, "Run install-packs first");
    return;
  }

  const tokenIn = await findToken(sdk, opts.tokenIn);
  const tokenOut = await findToken(sdk, opts.tokenOut);

  if (!tokenIn) {
    const tokens = await sdk.getAvailableTokens();
    const symbols = tokens.map((t: any) => t.symbol).filter(Boolean).join(", ");
    fail("TOKEN_NOT_FOUND", `Token not found: ${opts.tokenIn}. Available: ${symbols}`, "Use an available token symbol");
    return;
  }
  if (!tokenOut) {
    const tokens = await sdk.getAvailableTokens();
    const symbols = tokens.map((t: any) => t.symbol).filter(Boolean).join(", ");
    fail("TOKEN_NOT_FOUND", `Token not found: ${opts.tokenOut}. Available: ${symbols}`, "Use an available token symbol");
    return;
  }

  const quote = await fetchQuote(sdk, tokenIn.tokenId, tokenOut.tokenId, amountHuman);
  if (!quote) {
    fail("NO_ROUTE", `No swap route for ${tokenIn.symbol} → ${tokenOut.symbol}`, "Try a different token pair");
    return;
  }

  const priceImpactPct = quote.priceImpact !== null ? quote.priceImpact * 100 : null;
  const minimumReceived = quote.expectedAmountOut * 0.99; // 1% default slippage preview
  const routeStr = Array.isArray(quote.route)
    ? quote.route.map((r: any) => r?.contract ?? r?.poolId ?? r).join(" → ")
    : (typeof quote.route === "object" && quote.route !== null)
      ? (quote.route as any).poolId ?? (quote.route as any).contract ?? "direct"
      : String(quote.route ?? "direct");

  success("Quote fetched — run swap --confirm to execute", {
    tokenIn: tokenIn.symbol,
    tokenOut: tokenOut.symbol,
    amountIn: amountHuman,
    amountOut: quote.expectedAmountOut,
    priceImpactPct,
    minimumReceived,
    routeDescription: routeStr,
    txId: null,
    explorerUrl: null,
  });
}

async function cmdSwap(opts: {
  tokenIn: string;
  tokenOut: string;
  amount: string;
  slippage: string;
  confirm: boolean;
  walletPassword?: string;
}): Promise<void> {
  const amountHuman = parseFloat(opts.amount);
  if (isNaN(amountHuman) || amountHuman <= 0) {
    fail("INVALID_AMOUNT", "Amount must be a positive number");
    return;
  }

  const slippagePct = parseFloat(opts.slippage);
  if (isNaN(slippagePct) || slippagePct <= 0) {
    fail("INVALID_SLIPPAGE", "Slippage must be a positive number");
    return;
  }
  // Hard limit — enforced in code, never overridden
  if (slippagePct > MAX_SLIPPAGE_PCT) {
    fail(
      "SLIPPAGE_LIMIT",
      `Slippage ${slippagePct}% exceeds hard limit of ${MAX_SLIPPAGE_PCT}%`,
      `Reduce --slippage to ≤ ${MAX_SLIPPAGE_PCT}`
    );
    return;
  }

  let sdk: any;
  try {
    sdk = await getBitflowSdk();
  } catch (e: any) {
    fail("SDK_ERROR", `Bitflow SDK load failed: ${e.message}`, "Run install-packs first");
    return;
  }

  const tokenIn = await findToken(sdk, opts.tokenIn);
  const tokenOut = await findToken(sdk, opts.tokenOut);

  if (!tokenIn) {
    fail("TOKEN_NOT_FOUND", `Token not found: ${opts.tokenIn}`, "Run quote to see available tokens");
    return;
  }
  if (!tokenOut) {
    fail("TOKEN_NOT_FOUND", `Token not found: ${opts.tokenOut}`, "Run quote to see available tokens");
    return;
  }

  const quote = await fetchQuote(sdk, tokenIn.tokenId, tokenOut.tokenId, amountHuman);
  if (!quote) {
    fail("NO_ROUTE", `No swap route for ${tokenIn.symbol} → ${tokenOut.symbol}`, "Try a different token pair");
    return;
  }

  const priceImpactPct = quote.priceImpact !== null ? quote.priceImpact * 100 : null;
  const minimumReceived = quote.expectedAmountOut * (1 - slippagePct / 100);
  const routeDescription = Array.isArray(quote.route)
    ? quote.route.map((r: any) => r?.contract ?? r?.poolId ?? r).join(" → ")
    : (typeof quote.route === "object" && quote.route !== null)
      ? (quote.route as any).poolId ?? (quote.route as any).contract ?? "direct"
      : String(quote.route ?? "direct");

  const quoteData = {
    tokenIn: tokenIn.symbol,
    tokenOut: tokenOut.symbol,
    amountIn: amountHuman,
    amountOut: quote.expectedAmountOut,
    priceImpactPct,
    minimumReceived,
    slippagePct,
    routeDescription,
    txId: null,
    explorerUrl: null,
  };

  // Without --confirm: return live quote as blocked — safe to inspect
  if (!opts.confirm) {
    blockedOut(
      `Swap ${amountHuman} ${tokenIn.symbol} → ~${quote.expectedAmountOut.toFixed(8)} ${tokenOut.symbol}. Add --confirm to execute.`,
      quoteData
    );
    return;
  }

  // Load wallet
  const password = opts.walletPassword ?? process.env.AIBTC_WALLET_PASSWORD ?? "";
  if (!password && !process.env.STACKS_PRIVATE_KEY) {
    fail("NO_PASSWORD", "Wallet password required — set AIBTC_WALLET_PASSWORD or use --wallet-password", "Set AIBTC_WALLET_PASSWORD or STACKS_PRIVATE_KEY env var");
    return;
  }

  let stxPrivateKey: string;
  let stxAddress: string;
  try {
    ({ stxPrivateKey, stxAddress } = await getWalletKeys(password));
  } catch (e: any) {
    fail("WALLET_ERROR", `Wallet load failed: ${e.message}`, "Run: npx @aibtc/mcp-server@latest --install");
    return;
  }

  // Balance check — enforce minimum 0.5 STX gas reserve
  let stxBalance: bigint;
  try {
    stxBalance = await getStxBalance(stxAddress);
  } catch (e: any) {
    fail("BALANCE_ERROR", `Could not fetch balance: ${e.message}`);
    return;
  }

  // For STX-in swaps: need amount + gas reserve. For other tokens: just gas reserve for fees.
  const isStxIn = tokenIn.symbol.toUpperCase() === "STX";
  const amountInUstx = isStxIn ? BigInt(Math.round(amountHuman * 1_000_000)) : 0n;
  const requiredUstx = amountInUstx + MIN_GAS_USTX;

  if (stxBalance < requiredUstx) {
    fail(
      "INSUFFICIENT_BALANCE",
      `Need ${Number(requiredUstx) / 1_000_000} STX (${isStxIn ? `${amountHuman} STX swap ` : ""}+ 0.5 STX gas reserve), have ${Number(stxBalance) / 1_000_000} STX`,
      "Add STX to wallet and retry"
    );
    return;
  }

  // Execute swap
  const dryRun = process.env.AIBTC_DRY_RUN === "1";
  let result: { txId: string; explorerUrl: string; actualAmountOut: number };
  try {
    result = await executeSwap({
      sdk,
      tokenIn,
      tokenOut,
      amountHuman,
      senderAddress: stxAddress,
      stxPrivateKey,
      slippagePct,
      dryRun,
    });
  } catch (e: any) {
    fail("SWAP_FAILED", `Swap execution failed: ${e.message}`, "Check error and retry");
    return;
  }

  success("Swap broadcast successfully", {
    ...quoteData,
    amountOut: result.actualAmountOut,
    minimumReceived: result.actualAmountOut * (1 - slippagePct / 100),
    txId: result.txId,
    explorerUrl: result.explorerUrl,
    dryRun,
  });
}

// ─── CLI setup ────────────────────────────────────────────────────────────────

const program = new Command();

program
  .name("bitflow-spot-swap")
  .description("Single on-demand token swap on Bitflow DEX")
  .version("1.0.0");

program
  .command("doctor")
  .description("Check API connectivity and wallet availability")
  .action(() => cmdDoctor().catch((e: any) => {
    fail("UNEXPECTED", e.message);
    process.exit(1);
  }));

program
  .command("install-packs")
  .description("Install required npm packages (one-time setup)")
  .action(() => cmdInstallPacks().catch((e: any) => {
    fail("INSTALL_ERROR", e.message);
    process.exit(1);
  }));

program
  .command("quote")
  .description("Fetch a live swap quote without executing")
  .requiredOption("--token-in <symbol>", "Input token symbol (e.g. STX)")
  .requiredOption("--token-out <symbol>", "Output token symbol (e.g. sBTC)")
  .requiredOption("--amount <number>", "Amount in human units (e.g. 10 for 10 STX)")
  .action((opts) => cmdQuote(opts).catch((e: any) => {
    fail("UNEXPECTED", e.message);
    process.exit(1);
  }));

program
  .command("swap")
  .description("Execute a token swap (requires --confirm to proceed)")
  .requiredOption("--token-in <symbol>", "Input token symbol")
  .requiredOption("--token-out <symbol>", "Output token symbol")
  .requiredOption("--amount <number>", "Amount in human units")
  .option("--slippage <pct>", "Max slippage percentage (default: 1, hard max: 5)", "1")
  .option("--confirm", "Required to execute — omit to preview quote only")
  .option("--wallet-password <password>", "Wallet password (prefer AIBTC_WALLET_PASSWORD env var)")
  .action((opts) => cmdSwap(opts).catch((e: any) => {
    fail("UNEXPECTED", e.message);
    process.exit(1);
  }));

program.parse(process.argv);
