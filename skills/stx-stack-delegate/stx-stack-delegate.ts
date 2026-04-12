#!/usr/bin/env bun
/**
 * stx-stack-delegate — Delegate STX to Fast Pool for PoX4 stacking
 *
 * Contracts:
 *   SP21YTSM60CAY6D011EZVEVNKXVW8FVZE198XEFFP.pox4-fast-pool-v3  (delegate)
 *   SP000000000000000000002Q6VF78.pox-4                            (revoke, read-only)
 *
 * All commands emit strict JSON to stdout. Debug goes to stderr.
 */

import { Command } from "commander";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// ─── Constants ────────────────────────────────────────────────────────────────

const STACKS_API = "https://api.hiro.so";
const EXPLORER_BASE = "https://explorer.hiro.so/txid";
const WALLETS_FILE = path.join(os.homedir(), ".aibtc", "wallets.json");
const WALLETS_DIR = path.join(os.homedir(), ".aibtc", "wallets");

const FAST_POOL_ADDRESS = "SP21YTSM60CAY6D011EZVEVNKXVW8FVZE198XEFFP";
const FAST_POOL_NAME = "pox4-fast-pool-v3";
const POX4_ADDRESS = "SP000000000000000000002Q6VF78";
const POX4_NAME = "pox-4";

// Hard limits — enforced in code
const MAX_DELEGATION_STX = 10_000_000;      // 10M STX
const MIN_DELEGATION_STX = 100;             // 100 STX
const STX_DECIMALS = 6;
const USTX_PER_STX = 1_000_000;
const GAS_BUFFER_USTX = 1_000_000;         // 1 STX for fees
const DEFAULT_FEE_USTX = 10_000;           // 0.01 STX

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

function blocked(action: string, data: Record<string, unknown>): void {
  out({ status: "blocked", action, data, error: null });
}

function fail(code: string, message: string, next: string, data: Record<string, unknown> = {}): void {
  out({ status: "error", action: next, data, error: { code, message, next } });
}

// ─── Wallet helpers ───────────────────────────────────────────────────────────

async function decryptAibtcKeystore(enc: any, password: string): Promise<string> {
  const { scryptSync, createDecipheriv } = await import("crypto" as any);
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
  // Note: import is shared across both wallet path branches below

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
      throw e; // Modern keystore found but decryption failed — don't fall through to legacy wallet
    }
  }

  const legacyPath = path.join(os.homedir(), ".aibtc", "wallet.json");
  if (fs.existsSync(legacyPath)) {
    try {
      const w = JSON.parse(fs.readFileSync(legacyPath, "utf-8"));
      const mnemonic = w.mnemonic;
      if (mnemonic) {
          const wallet = await generateWallet({ secretKey: mnemonic, password });
        const account = deriveAccount(wallet, 0);
        return { stxPrivateKey: account.stxPrivateKey, stxAddress: getStxAddress(account) };
      }
    } catch { /* fall through */ }
  }

  throw new Error(
    "No wallet found. Run: npx @aibtc/mcp-server@latest --install\n" +
    "Or set STACKS_PRIVATE_KEY env var for direct key access."
  );
}

// ─── Stacks API helpers ───────────────────────────────────────────────────────

async function getAccountInfo(address: string): Promise<{ balance: bigint; locked: bigint; nonce: number }> {
  const res = await fetch(`${STACKS_API}/v2/accounts/${address}?proof=0`, {
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Account fetch failed: ${res.status}`);
  const d = await res.json() as { balance: string; locked: string; nonce: number };
  return {
    balance: BigInt(d.balance),
    locked: BigInt(d.locked),
    nonce: d.nonce,
  };
}

async function callReadOnly(
  contractAddress: string,
  contractName: string,
  functionName: string,
  functionArgs: any[],
  sender: string
): Promise<any> {
  const body = {
    sender,
    arguments: functionArgs,
  };
  const res = await fetch(
    `${STACKS_API}/v2/contracts/call-read/${contractAddress}/${contractName}/${functionName}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    }
  );
  if (!res.ok) throw new Error(`Read-only call failed: ${res.status}`);
  const d = await res.json() as { okay: boolean; result?: string };
  if (!d.okay) throw new Error(`Read-only call not okay: ${JSON.stringify(d)}`);
  return d.result;
}

async function getPoxInfo(): Promise<{ reward_cycle_length: number; current_cycle: { id: number }; next_cycle: { prepare_phase_start_block_height: number } }> {
  const res = await fetch(`${STACKS_API}/v2/pox`, {
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`PoX info fetch failed: ${res.status}`);
  return res.json() as Promise<any>;
}

// ─── Commands ─────────────────────────────────────────────────────────────────

async function cmdDoctor(): Promise<void> {
  const checks: Record<string, boolean | string> = {};

  // Wallet check
  const hasWallet = fs.existsSync(WALLETS_FILE) ||
    fs.existsSync(path.join(os.homedir(), ".aibtc", "wallet.json")) ||
    !!process.env.STACKS_PRIVATE_KEY;
  checks.wallet = hasWallet;

  // Stacks API check
  try {
    const res = await fetch(`${STACKS_API}/v2/info`, { signal: AbortSignal.timeout(10_000) });
    checks.stacks_api = res.ok;
  } catch {
    checks.stacks_api = false;
  }

  // Fast Pool contract check
  try {
    const res = await fetch(
      `${STACKS_API}/extended/v1/contract/${FAST_POOL_ADDRESS}.${FAST_POOL_NAME}`,
      { signal: AbortSignal.timeout(10_000) }
    );
    if (!res.ok) throw new Error(`Contract check failed: ${res.status}`);
    const d = await res.json() as any;
    checks.fast_pool_contract = "tx_id" in d ? d.tx_id : false;
  } catch {
    checks.fast_pool_contract = false;
  }

  // PoX4 info check
  let poxInfo: any = null;
  try {
    poxInfo = await getPoxInfo();
    checks.pox4_current_cycle = poxInfo?.current_cycle?.id ?? false;
  } catch {
    checks.pox4_current_cycle = false;
  }

  const allPassed = Object.values(checks).every(v => !!v);
  if (!allPassed) {
    fail("DOCTOR_FAILED", "One or more health checks failed", "Fix the failing checks before running delegate or revoke", { checks });
    return;
  }

  success("All checks passed", {
    checks,
    fast_pool: `${FAST_POOL_ADDRESS}.${FAST_POOL_NAME}`,
    pox4: `${POX4_ADDRESS}.${POX4_NAME}`,
    current_cycle: poxInfo?.current_cycle?.id,
  });
}

async function cmdStatus(opts: { walletPassword?: string }): Promise<void> {
  let caller: string;

  if (process.env.STACKS_PRIVATE_KEY) {
    const { getAddressFromPrivateKey, TransactionVersion } = await import("@stacks/transactions" as any);
    caller = getAddressFromPrivateKey(process.env.STACKS_PRIVATE_KEY!, TransactionVersion.Mainnet);
  } else {
    const pwd = opts.walletPassword ?? process.env.AIBTC_WALLET_PASSWORD ?? "";
    if (!pwd) {
      fail("NO_WALLET", "Cannot determine wallet address", "Set STACKS_PRIVATE_KEY env var or pass --wallet-password");
      return;
    }
    try {
      const keys = await getWalletKeys(pwd);
      caller = keys.stxAddress;
    } catch (e: any) {
      fail("WALLET_ERROR", e.message, "Fix wallet setup: npx @aibtc/mcp-server@latest --install");
      return;
    }
  }

  let delegatedAmount: bigint | null = null;
  let currentCycle: number | null = null;
  let balance: bigint | null = null;
  let locked: bigint | null = null;

  try {
    const poxInfo = await getPoxInfo();
    currentCycle = poxInfo?.current_cycle?.id ?? null;
  } catch { /* non-fatal */ }

  try {
    // get-delegated-amount(user principal) returns (optional uint)
    const { fetchCallReadOnlyFunction, principalCV, ClarityType } = await import("@stacks/transactions" as any);

    const result = await fetchCallReadOnlyFunction({
      contractAddress: FAST_POOL_ADDRESS,
      contractName: FAST_POOL_NAME,
      functionName: "get-delegated-amount",
      functionArgs: [principalCV(caller)],
      senderAddress: caller,
      network: "mainnet",
    });

    if (result?.type === ClarityType.OptionalSome) {
      delegatedAmount = result.value?.value ?? BigInt(0);
    } else {
      // OptionalNone — no delegation
      delegatedAmount = BigInt(0);
    }
  } catch (e: any) {
    process.stderr.write(`get-delegated-amount error: ${e.message}\n`);
  }

  try {
    const info = await getAccountInfo(caller);
    balance = info.balance;
    locked = info.locked;
  } catch { /* non-fatal */ }

  const delegatedStx = delegatedAmount !== null ? Number(delegatedAmount) / USTX_PER_STX : null;
  const balanceStx = balance !== null ? Number(balance) / USTX_PER_STX : null;
  const lockedStx = locked !== null ? Number(locked) / USTX_PER_STX : null;
  const unlockedStx = (balanceStx !== null && lockedStx !== null) ? balanceStx - lockedStx : null;

  success("Status fetched", {
    address: caller,
    delegated_ustx: delegatedAmount !== null ? delegatedAmount.toString() : null,
    delegated_stx: delegatedStx,
    is_stacking: (delegatedAmount !== null && delegatedAmount > 0n),
    balance_stx: balanceStx,
    locked_stx: lockedStx,
    unlocked_stx: unlockedStx,
    current_cycle: currentCycle,
    fast_pool: `${FAST_POOL_ADDRESS}.${FAST_POOL_NAME}`,
  });
}

async function cmdDelegate(opts: { amount: string; confirm: boolean; walletPassword?: string }): Promise<void> {
  const amountStx = parseFloat(opts.amount);
  if (isNaN(amountStx) || amountStx <= 0) {
    fail("INVALID_AMOUNT", "Amount must be a positive number", "Provide --amount as STX in human units (e.g. --amount 1000)");
    return;
  }
  if (amountStx < MIN_DELEGATION_STX) {
    fail("AMOUNT_TOO_SMALL", `Minimum delegation is ${MIN_DELEGATION_STX} STX`, "Increase --amount");
    return;
  }
  if (amountStx > MAX_DELEGATION_STX) {
    fail("AMOUNT_EXCEEDS_LIMIT", `Maximum delegation is ${MAX_DELEGATION_STX.toLocaleString()} STX`, "Reduce --amount");
    return;
  }

  const amountUstx = BigInt(Math.round(amountStx * USTX_PER_STX));
  const preview = {
    action: "delegate-stx",
    pool: `${FAST_POOL_ADDRESS}.${FAST_POOL_NAME}`,
    amount_stx: amountStx,
    amount_ustx: amountUstx.toString(),
    fee_ustx: DEFAULT_FEE_USTX,
    post_condition_mode: "deny",
    network: "mainnet",
  };

  if (!opts.confirm) {
    blocked("Run with --confirm to broadcast the delegation transaction", preview);
    return;
  }

  const password = opts.walletPassword ?? process.env.AIBTC_WALLET_PASSWORD ?? "";
  if (!password && !process.env.STACKS_PRIVATE_KEY) {
    fail("NO_PASSWORD", "Wallet password required", "Set AIBTC_WALLET_PASSWORD env var or pass --wallet-password");
    return;
  }

  let keys: { stxPrivateKey: string; stxAddress: string };
  try {
    keys = await getWalletKeys(password);
  } catch (e: any) {
    fail("WALLET_ERROR", e.message, "Fix wallet setup: npx @aibtc/mcp-server@latest --install");
    return;
  }

  // Balance check
  let accountInfo: { balance: bigint; locked: bigint; nonce: number };
  try {
    accountInfo = await getAccountInfo(keys.stxAddress);
  } catch (e: any) {
    fail("BALANCE_CHECK_FAILED", `Could not fetch account info: ${e.message}`, "Check network and retry");
    return;
  }

  const unlockedBalance = accountInfo.balance - accountInfo.locked;
  const required = amountUstx + BigInt(GAS_BUFFER_USTX);
  if (unlockedBalance < required) {
    fail(
      "INSUFFICIENT_BALANCE",
      `Unlocked balance ${Number(unlockedBalance) / USTX_PER_STX} STX is less than required ${Number(required) / USTX_PER_STX} STX (amount + 1 STX gas buffer)`,
      "Add more STX or reduce --amount",
      { unlocked_stx: Number(unlockedBalance) / USTX_PER_STX, required_stx: Number(required) / USTX_PER_STX }
    );
    return;
  }

  // Build and broadcast the transaction
  try {
    const {
      makeContractCall,
      uintCV,
      PostConditionMode,
      broadcastTransaction,
      AnchorMode,
    } = await import("@stacks/transactions" as any);
    const { STACKS_MAINNET } = await import("@stacks/network" as any);
    const network = STACKS_MAINNET;

    const txOptions = {
      contractAddress: FAST_POOL_ADDRESS,
      contractName: FAST_POOL_NAME,
      functionName: "delegate-stx",
      functionArgs: [uintCV(amountUstx)],
      senderKey: keys.stxPrivateKey,
      network,
      postConditionMode: PostConditionMode.Deny,
      postConditions: [],
      fee: DEFAULT_FEE_USTX,
      nonce: accountInfo.nonce,
      anchorMode: AnchorMode.Any,
    };

    const tx = await makeContractCall(txOptions);
    const result = await broadcastTransaction({ transaction: tx, network });

    if (result.error) {
      fail(
        "BROADCAST_FAILED",
        `Transaction rejected: ${result.error} — ${result.reason ?? ""}`,
        "Check the error and retry",
        { error: result.error, reason: result.reason }
      );
      return;
    }

    const txId = result.txid ?? result;
    success("Delegation transaction broadcast", {
      txId,
      explorerUrl: `${EXPLORER_BASE}/${txId}?chain=mainnet`,
      amount_stx: amountStx,
      amount_ustx: amountUstx.toString(),
      address: keys.stxAddress,
      pool: `${FAST_POOL_ADDRESS}.${FAST_POOL_NAME}`,
      note: "STX will be locked until end of current PoX4 cycle. Check status command to confirm.",
    });
  } catch (e: any) {
    fail("TX_ERROR", `Transaction failed: ${e.message}`, "Review the error and retry", { stack: e.stack?.slice(0, 300) });
  }
}

async function cmdRevoke(opts: { confirm: boolean; walletPassword?: string }): Promise<void> {
  const preview = {
    action: "revoke-delegate-stx",
    contract: `${POX4_ADDRESS}.${POX4_NAME}`,
    fee_ustx: DEFAULT_FEE_USTX,
    post_condition_mode: "deny",
    network: "mainnet",
    note: "STX will remain locked until end of current PoX4 cycle, then become transferable.",
  };

  if (!opts.confirm) {
    blocked("Run with --confirm to broadcast the revoke transaction", preview);
    return;
  }

  const password = opts.walletPassword ?? process.env.AIBTC_WALLET_PASSWORD ?? "";
  if (!password && !process.env.STACKS_PRIVATE_KEY) {
    fail("NO_PASSWORD", "Wallet password required", "Set AIBTC_WALLET_PASSWORD env var or pass --wallet-password");
    return;
  }

  let keys: { stxPrivateKey: string; stxAddress: string };
  try {
    keys = await getWalletKeys(password);
  } catch (e: any) {
    fail("WALLET_ERROR", e.message, "Fix wallet setup: npx @aibtc/mcp-server@latest --install");
    return;
  }

  let nonce: number;
  try {
    const info = await getAccountInfo(keys.stxAddress);
    nonce = info.nonce;
  } catch (e: any) {
    fail("NONCE_FETCH_FAILED", `Could not fetch account nonce: ${e.message}`, "Check network and retry");
    return;
  }

  try {
    const {
      makeContractCall,
      PostConditionMode,
      broadcastTransaction,
      AnchorMode,
    } = await import("@stacks/transactions" as any);
    const { STACKS_MAINNET } = await import("@stacks/network" as any);
    const network = STACKS_MAINNET;

    const txOptions = {
      contractAddress: POX4_ADDRESS,
      contractName: POX4_NAME,
      functionName: "revoke-delegate-stx",
      functionArgs: [],
      senderKey: keys.stxPrivateKey,
      network,
      postConditionMode: PostConditionMode.Deny,
      postConditions: [],
      fee: DEFAULT_FEE_USTX,
      nonce,
      anchorMode: AnchorMode.Any,
    };

    const tx = await makeContractCall(txOptions);
    const result = await broadcastTransaction({ transaction: tx, network });

    if (result.error) {
      fail(
        "BROADCAST_FAILED",
        `Revoke transaction rejected: ${result.error} — ${result.reason ?? ""}`,
        "Check the error and retry",
        { error: result.error, reason: result.reason }
      );
      return;
    }

    const txId = result.txid ?? result;
    success("Revoke transaction broadcast", {
      txId,
      explorerUrl: `${EXPLORER_BASE}/${txId}?chain=mainnet`,
      address: keys.stxAddress,
      note: "Delegation revoked. STX unlocks at end of current PoX4 cycle.",
    });
  } catch (e: any) {
    fail("TX_ERROR", `Revoke transaction failed: ${e.message}`, "Review the error and retry");
  }
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

const program = new Command();
program.name("stx-stack-delegate").description("Delegate STX to Fast Pool for PoX4 stacking").version("1.0.0");

program.command("doctor").description("Health check: wallet, API, and contract availability").action(async () => {
  try { await cmdDoctor(); } catch (e: any) { fail("UNEXPECTED", e.message, "Check logs"); }
});

program
  .command("status")
  .description("Show current delegation status and balances")
  .option("--wallet-password <pw>", "Wallet password (prefer AIBTC_WALLET_PASSWORD env var)")
  .action(async (opts) => {
    try { await cmdStatus(opts); } catch (e: any) { fail("UNEXPECTED", e.message, "Check logs"); }
  });

program
  .command("delegate")
  .description("Delegate STX to Fast Pool (requires --confirm to broadcast)")
  .requiredOption("--amount <stx>", "Amount of STX to delegate (human units, e.g. 1000)")
  .option("--confirm", "Broadcast the transaction (required for execution)")
  .option("--wallet-password <pw>", "Wallet password (prefer AIBTC_WALLET_PASSWORD env var)")
  .action(async (opts) => {
    try { await cmdDelegate(opts); } catch (e: any) { fail("UNEXPECTED", e.message, "Check logs"); }
  });

program
  .command("revoke")
  .description("Revoke Fast Pool delegation via pox-4.revoke-delegate-stx (requires --confirm)")
  .option("--confirm", "Broadcast the revoke transaction")
  .option("--wallet-password <pw>", "Wallet password (prefer AIBTC_WALLET_PASSWORD env var)")
  .action(async (opts) => {
    try { await cmdRevoke(opts); } catch (e: any) { fail("UNEXPECTED", e.message, "Check logs"); }
  });

program.parse(process.argv);
