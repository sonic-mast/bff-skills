#!/usr/bin/env bun
/**
 * alex-swap — Execute token swaps on ALEX DEX (Stacks L2) via alex-sdk
 *
 * Routes through ALEX's multi-hop AMM. All write operations require --confirm.
 * Max autonomous swap: 10,000 STX equivalent. Slippage hard cap: 5%.
 *
 * Usage:
 *   bun run alex-swap/alex-swap.ts doctor
 *   bun run alex-swap/alex-swap.ts install-packs
 *   bun run alex-swap/alex-swap.ts quote --token-in STX --token-out USDA --amount 100
 *   bun run alex-swap/alex-swap.ts run --token-in STX --token-out USDA --amount 100 [--slippage 3] [--confirm]
 *   bun run alex-swap/alex-swap.ts tokens
 *
 * All commands emit strict JSON to stdout. Debug goes to stderr.
 */

import { Command } from "commander";
import { homedir } from "os";
import { join } from "path";
import { readFileSync, existsSync } from "fs";
import { execSync } from "child_process";

// ── Constants ──────────────────────────────────────────────────────────────────
const MAX_SLIPPAGE_PCT        = 5;             // hard ceiling: 5%
const DEFAULT_SLIPPAGE_PCT    = 2;             // sensible default
const MAX_AUTO_STX            = 10_000;        // autonomous limit in STX
const MIN_STX_GAS_USTX        = 50_000n;      // 0.05 STX reserve for gas
const STX_DECIMALS            = 6;
const ALEX_DECIMALS           = 8;            // alex-sdk uses 1e8 precision
const FETCH_TIMEOUT_MS        = 10_000;

const WALLETS_FILE = join(homedir(), ".aibtc", "wallets.json");
const WALLETS_DIR  = join(homedir(), ".aibtc", "wallets");
const HIRO_API     = "https://api.mainnet.hiro.so";
const EXPLORER     = "https://explorer.hiro.so/txid";

// ── Output helpers ─────────────────────────────────────────────────────────────
function ok(data: Record<string, unknown>, action = ""): never {
  console.log(JSON.stringify({ status: "success", action, data, error: null }));
  process.exit(0);
}
function blocked(reason: string, data: Record<string, unknown> = {}): never {
  console.log(JSON.stringify({ status: "blocked", action: reason, data, error: null }));
  process.exit(0);
}
function fail(code: string, message: string, next = ""): never {
  console.log(JSON.stringify({ status: "error", action: next, data: {}, error: { code, message, next } }));
  process.exit(1);
}

// ── Wallet loading (matches AIBTC MCP wallet format) ──────────────────────────
async function decryptKeystore(enc: {
  ciphertext: string; iv: string; authTag: string; salt: string;
  scryptParams: { N: number; r: number; p: number; keyLen?: number };
}, password: string): Promise<string> {
  const { scryptSync, createDecipheriv } = await import("crypto" as any);
  const { N, r, p, keyLen } = enc.scryptParams;
  const salt       = Buffer.from(enc.salt, "base64");
  const iv         = Buffer.from(enc.iv, "base64");
  const authTag    = Buffer.from(enc.authTag, "base64");
  const ciphertext = Buffer.from(enc.ciphertext, "base64");
  const key        = scryptSync(password, salt, keyLen ?? 32, { N, r, p });
  const decipher   = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);
  const dec = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return dec.toString("utf-8").trim();
}

async function getWalletKeys(password: string): Promise<{ stxPrivateKey: string; stxAddress: string }> {
  // 1. Direct private key env var (testing only)
  if (process.env.STACKS_PRIVATE_KEY) {
    const { getAddressFromPrivateKey, TransactionVersion } = await import("@stacks/transactions" as any);
    const key = process.env.STACKS_PRIVATE_KEY;
    const address = getAddressFromPrivateKey(key, TransactionVersion.Mainnet);
    return { stxPrivateKey: key, stxAddress: address };
  }

  const { generateWallet, deriveAccount, getStxAddress } = await import("@stacks/wallet-sdk" as any);

  // 2. AIBTC wallets.json + keystore (MCP server v1)
  if (existsSync(WALLETS_FILE)) {
    try {
      const walletsJson = JSON.parse(readFileSync(WALLETS_FILE, "utf-8"));
      const activeWallet = (walletsJson.wallets ?? [])[0];
      if (activeWallet?.id) {
        const keystorePath = join(WALLETS_DIR, activeWallet.id, "keystore.json");
        if (existsSync(keystorePath)) {
          const keystore = JSON.parse(readFileSync(keystorePath, "utf-8"));
          const enc = keystore.encrypted;
          if (enc?.ciphertext) {
            const mnemonic = await decryptKeystore(enc, password);
            const wallet = await generateWallet({ secretKey: mnemonic, password: "" });
            const account = deriveAccount({ wallet, index: 0, network: "mainnet" });
            const stxAddress = getStxAddress({ account, version: "mainnet" } as any) as string;
            const stxPrivateKey = account.stxPrivateKey as string;
            return { stxPrivateKey, stxAddress };
          }
        }
      }
    } catch {
      // fall through
    }
  }

  // 3. Legacy wallet.json
  const legacyPath = join(homedir(), ".aibtc", "wallet.json");
  if (existsSync(legacyPath)) {
    try {
      const wallet = JSON.parse(readFileSync(legacyPath, "utf-8"));
      if (wallet.mnemonic) {
        const w = await generateWallet({ secretKey: wallet.mnemonic, password: "" });
        const account = deriveAccount({ wallet: w, index: 0, network: "mainnet" });
        const stxAddress = getStxAddress({ account, version: "mainnet" } as any) as string;
        return { stxPrivateKey: account.stxPrivateKey as string, stxAddress };
      }
    } catch {
      // fall through
    }
  }

  fail("WALLET_NOT_FOUND",
    "No AIBTC wallet found. Run: npx @aibtc/mcp-server@latest --install",
    "Install AIBTC wallet first");
}

// ── Stacks API helpers ─────────────────────────────────────────────────────────
async function getStxBalance(address: string): Promise<bigint> {
  const res = await fetch(`${HIRO_API}/v2/accounts/${address}?proof=0`,
    { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) fail("API_ERROR", `Balance check failed: ${res.status}`, "Check network connectivity");
  const data: any = await res.json();
  // Subtract locked STX (e.g. from Stacking) to get spendable balance
  return BigInt(data.balance ?? "0") - BigInt(data.locked ?? "0");
}

// ── Alex SDK integration ────────────────────────────────────────────────────────
async function getAlex(): Promise<any> {
  const { AlexSDK } = await import("alex-sdk" as any);
  return new AlexSDK();
}

// Resolve user-friendly token name to alex-sdk token ID
// alex-sdk uses contract-name-based IDs matching the on-chain token names
function resolveTokenId(name: string): string {
  const n = name.trim().toUpperCase();
  const MAP: Record<string, string> = {
    "STX":    "token-wstx",
    "WSTX":   "token-wstx",
    "USDA":   "token-usda",
    "USDT":   "token-susdt",
    "SUSDT":  "token-susdt",
    "WBTC":   "token-wbtc",
    "BTC":    "token-wbtc",
    "ALEX":   "age000-governance-token",
    "ATALEX": "auto-alex-v2",
    "DIKO":   "arkadiko-token",
    "XBTC":   "token-xbtc",
    "SBTC":   "token-sbtc",
  };
  const resolved = MAP[n];
  // Fall back to the raw input (lowercased) so tokens returned by the `tokens`
  // command can be used directly without needing a MAP entry.
  if (!resolved) return name.trim().toLowerCase();
  return resolved;
}

// Convert human amount to alex-sdk bigint (1e8 precision for alex-sdk)
function toAlexUnits(amount: number, symbol: string): bigint {
  // alex-sdk normalizes all amounts to 1e8
  return BigInt(Math.round(amount * 10 ** ALEX_DECIMALS));
}

function fromAlexUnits(raw: bigint): number {
  return Number(raw) / 10 ** ALEX_DECIMALS;
}

// ── Commands ───────────────────────────────────────────────────────────────────
const program = new Command();
program.name("alex-swap").description("ALEX DEX swaps on Stacks L2").version("1.0.0");

// doctor ───────────────────────────────────────────────────────────────────────
program.command("doctor")
  .description("System health check")
  .action(async () => {
    const checks: Record<string, { ok: boolean; message: string }> = {};

    // 1. Wallet presence
    const hasWallet = existsSync(WALLETS_FILE) ||
                      existsSync(join(homedir(), ".aibtc", "wallet.json")) ||
                      !!process.env.STACKS_PRIVATE_KEY;
    checks.wallet = {
      ok: hasWallet,
      message: hasWallet ? "Wallet file found" : "No wallet — run: npx @aibtc/mcp-server@latest --install",
    };

    // 2. Stacks API
    try {
      const res = await fetch(`${HIRO_API}/v2/info`, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      const data: any = await res.json();
      checks.stacks_api = { ok: res.ok, message: `Stacks API OK — block ${data.burn_block_height ?? "?"}` };
    } catch (e: any) {
      checks.stacks_api = { ok: false, message: `Stacks API unreachable: ${e.message}` };
    }

    // 3. ALEX SDK
    try {
      const sdk = await getAlex();
      const tokens = await sdk.fetchSwappableCurrencyList?.() ?? [];
      checks.alex_sdk = {
        ok: true,
        message: `alex-sdk OK — ${tokens.length ?? "?"} swappable tokens`,
      };
    } catch (e: any) {
      checks.alex_sdk = {
        ok: false,
        message: `alex-sdk error: ${e.message}. Run: install-packs`,
      };
    }

    // 4. ALEX contract
    try {
      const res = await fetch(
        `${HIRO_API}/extended/v1/contract/SP3K8BC0PPEVCV7NZ6QSRWPQ2JE9E5B6N3PA0KBR9.swap-helper-v1-03`,
        { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      const data: any = await res.json();
      checks.alex_contract = {
        ok: "tx_id" in data,
        message: "tx_id" in data ? "swap-helper-v1-03 confirmed on mainnet" : `Contract check failed: ${data.error ?? "unknown"}`,
      };
    } catch (e: any) {
      checks.alex_contract = { ok: false, message: `Contract check error: ${e.message}` };
    }

    const allOk = Object.values(checks).every(c => c.ok);
    if (!allOk) {
      const failures = Object.entries(checks).filter(([, c]) => !c.ok).map(([k, c]) => `${k}: ${c.message}`);
      fail("DOCTOR_FAILED", failures.join("; "), "Fix issues above before running swaps");
    }
    ok({ checks }, "All checks passed. Ready to swap on ALEX.");
  });

// install-packs ────────────────────────────────────────────────────────────────
program.command("install-packs")
  .description("Install required npm packages (one-time setup)")
  .action(() => {
    try {
      console.error("Installing dependencies...");
      execSync("bun add alex-sdk @stacks/transactions @stacks/network @stacks/wallet-sdk @stacks/encryption commander", {
        stdio: "inherit",
      });
      ok({ installed: ["alex-sdk", "@stacks/transactions", "@stacks/network", "@stacks/wallet-sdk", "@stacks/encryption", "commander"] },
        "Dependencies installed. Run doctor to verify.");
    } catch (e: any) {
      fail("INSTALL_FAILED", e.message, "Check bun install logs");
    }
  });

// tokens ───────────────────────────────────────────────────────────────────────
program.command("tokens")
  .description("List tokens supported by ALEX DEX")
  .action(async () => {
    try {
      const sdk = await getAlex();
      const list = await sdk.fetchSwappableCurrencyList?.() ?? [];
      ok({ tokens: list, count: list.length }, "Use token IDs in --token-in / --token-out");
    } catch (e: any) {
      fail("SDK_ERROR", `Could not fetch token list: ${e.message}`, "Run install-packs first");
    }
  });

// quote ────────────────────────────────────────────────────────────────────────
program.command("quote")
  .description("Get a live swap quote from ALEX DEX")
  .requiredOption("--token-in <symbol>", "Input token (e.g. STX)")
  .requiredOption("--token-out <symbol>", "Output token (e.g. USDA)")
  .requiredOption("--amount <number>", "Amount in human units (e.g. 100)")
  .action(async (opts) => {
    const amountNum = parseFloat(opts.amount);
    if (isNaN(amountNum) || amountNum <= 0)
      fail("INVALID_AMOUNT", "Amount must be a positive number", "Provide --amount > 0");

    const tokenIn  = resolveTokenId(opts.tokenIn);
    const tokenOut = resolveTokenId(opts.tokenOut);
    const amountIn = toAlexUnits(amountNum, opts.tokenIn);

    try {
      const sdk = await getAlex();
      const amountOut = await sdk.getAmountTo(tokenIn, amountIn, tokenOut);
      const amountOutHuman = fromAlexUnits(amountOut);

      ok({
        token_in:    opts.tokenIn.toUpperCase(),
        token_out:   opts.tokenOut.toUpperCase(),
        amount_in:   amountNum,
        amount_out:  amountOutHuman,
        rate:        amountOutHuman / amountNum,
        slippage_warning: `Add --slippage (default ${DEFAULT_SLIPPAGE_PCT}%) to protect against price impact.`,
      }, `Swap ${amountNum} ${opts.tokenIn.toUpperCase()} → ~${amountOutHuman.toFixed(6)} ${opts.tokenOut.toUpperCase()}`);
    } catch (e: any) {
      fail("QUOTE_ERROR", `Quote failed: ${e.message}`, "Check token names or run tokens command");
    }
  });

// run ──────────────────────────────────────────────────────────────────────────
program.command("run")
  .description("Execute a token swap on ALEX DEX (requires --confirm)")
  .requiredOption("--token-in <symbol>", "Input token (e.g. STX)")
  .requiredOption("--token-out <symbol>", "Output token (e.g. USDA)")
  .requiredOption("--amount <number>", "Amount in human units (e.g. 100)")
  .option("--slippage <pct>", `Max slippage % (default ${DEFAULT_SLIPPAGE_PCT}, max ${MAX_SLIPPAGE_PCT})`)
  .option("--wallet-password <pw>", "Wallet password (prefer AIBTC_WALLET_PASSWORD env var)")
  .option("--confirm", "Authorize the swap execution")
  .action(async (opts) => {
    const amountNum = parseFloat(opts.amount);
    if (isNaN(amountNum) || amountNum <= 0)
      fail("INVALID_AMOUNT", "Amount must be a positive number", "Provide --amount > 0");

    const slippagePct = opts.slippage ? parseFloat(opts.slippage) : DEFAULT_SLIPPAGE_PCT;
    if (isNaN(slippagePct))
      fail("INVALID_SLIPPAGE", `Slippage "${opts.slippage}" is not a valid number`, "Use --slippage between 0.1 and 5");
    if (slippagePct > MAX_SLIPPAGE_PCT)
      fail("SLIPPAGE_LIMIT", `Slippage ${slippagePct}% exceeds hard max ${MAX_SLIPPAGE_PCT}%`, "Use --slippage ≤ 5");
    if (slippagePct <= 0)
      fail("INVALID_SLIPPAGE", "Slippage must be > 0", "Use --slippage between 0.1 and 5");

    // Autonomous spend limit: block if amount > MAX_AUTO_STX (per-swap)
    // For non-STX inputs, this is a safety approximation (value in STX equiv is checked via balance)
    if (amountNum > MAX_AUTO_STX)
      fail("SPEND_LIMIT", `Amount ${amountNum} exceeds autonomous limit of ${MAX_AUTO_STX}. Operator review required.`, "Reduce --amount");

    const tokenIn  = resolveTokenId(opts.tokenIn);
    const tokenOut = resolveTokenId(opts.tokenOut);
    const amountIn = toAlexUnits(amountNum, opts.tokenIn);

    // Get live quote
    let amountOut: bigint;
    try {
      const sdk = await getAlex();
      amountOut = await sdk.getAmountTo(tokenIn, amountIn, tokenOut);
    } catch (e: any) {
      fail("QUOTE_ERROR", `Quote failed: ${e.message}`, "Run quote command to diagnose");
    }

    const amountOutHuman  = fromAlexUnits(amountOut!);
    // Use BigInt arithmetic throughout to avoid precision loss on large values
    const minAmountOut    = (amountOut! * BigInt(Math.floor((100 - slippagePct) * 100))) / 10000n;
    const minAmountHuman  = fromAlexUnits(minAmountOut);

    // Show preview if no --confirm
    if (!opts.confirm) {
      blocked(
        `Add --confirm to execute: swap ${amountNum} ${opts.tokenIn.toUpperCase()} → min ${minAmountHuman.toFixed(6)} ${opts.tokenOut.toUpperCase()} (slippage ${slippagePct}%)`,
        {
          token_in:      opts.tokenIn.toUpperCase(),
          token_out:     opts.tokenOut.toUpperCase(),
          amount_in:     amountNum,
          expected_out:  amountOutHuman,
          min_out:       minAmountHuman,
          slippage_pct:  slippagePct,
        }
      );
    }

    // Load wallet — password is only required when not using STACKS_PRIVATE_KEY
    const password = opts.walletPassword ?? process.env.AIBTC_WALLET_PASSWORD ?? "";
    if (!password && !process.env.STACKS_PRIVATE_KEY)
      fail("NO_PASSWORD",
        "Wallet password required. Use AIBTC_WALLET_PASSWORD env var or --wallet-password flag.",
        "Set AIBTC_WALLET_PASSWORD env var");

    let stxAddress: string, stxPrivateKey: string;
    try {
      ({ stxAddress, stxPrivateKey } = await getWalletKeys(password));
    } catch (e: any) {
      fail("WALLET_ERROR", e.message, "Run doctor to check wallet");
    }

    // Check STX gas reserve (always required for Stacks fees)
    const stxBalance = await getStxBalance(stxAddress!);
    if (stxBalance < MIN_STX_GAS_USTX)
      fail("INSUFFICIENT_GAS",
        `STX balance ${stxBalance} < gas reserve ${MIN_STX_GAS_USTX} μSTX. Fund wallet first.`,
        `Fund ${stxAddress}`);

    // For STX/WSTX inputs: additionally check we have enough STX for the swap
    // Compare resolved token ID so WSTX alias is also covered (both resolve to "token-wstx")
    if (tokenIn === "token-wstx") {
      const amountInUstx = BigInt(Math.round(amountNum * 10 ** STX_DECIMALS));
      if (stxBalance < amountInUstx + MIN_STX_GAS_USTX)
        fail("INSUFFICIENT_BALANCE",
          `Need ${amountNum} STX + 0.05 STX gas, have ${Number(stxBalance) / 10 ** STX_DECIMALS} STX`,
          "Fund wallet or reduce --amount");
    }

    // Execute swap via alex-sdk
    const { STACKS_MAINNET } = await import("@stacks/network" as any);
    const { makeContractCall, broadcastTransaction, PostConditionMode } = await import("@stacks/transactions" as any);

    let txId: string;
    try {
      const sdk = await getAlex();
      txId = await sdk.runSwap(
        stxAddress!,
        tokenIn,
        tokenOut,
        amountIn,
        minAmountOut,
        async (txOptions: any) => {
          const network = STACKS_MAINNET;
          const tx = await makeContractCall({
            ...txOptions,
            senderKey: stxPrivateKey!,
            network,
            postConditionMode: PostConditionMode.Deny,
            fee: txOptions.fee || 10000n,
            anchorMode: 3, // any
          });
          // v7: broadcastTransaction returns txid string directly; throws on failure
          const result = await broadcastTransaction({ transaction: tx, network });
          return result as string;
        }
      );
    } catch (e: any) {
      fail("SWAP_FAILED", `Swap execution failed: ${e.message}`, "Check tx on explorer or retry");
    }

    ok({
      txid:       txId!,
      explorer:   `${EXPLORER}/${txId}?chain=mainnet`,
      token_in:   opts.tokenIn.toUpperCase(),
      token_out:  opts.tokenOut.toUpperCase(),
      amount_in:  amountNum,
      min_out:    minAmountHuman,
      slippage:   slippagePct,
      telegram:   `✅ ALEX Swap executed\n💱 ${amountNum} ${opts.tokenIn.toUpperCase()} → ≥${minAmountHuman.toFixed(6)} ${opts.tokenOut.toUpperCase()}\n⏱ Slippage: ${slippagePct}%\n🔗 ${EXPLORER}/${txId}?chain=mainnet`,
    }, "Swap broadcast. Check explorer for confirmation.");
  });

program.parse();
