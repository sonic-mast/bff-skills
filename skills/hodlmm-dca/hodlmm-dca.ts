#!/usr/bin/env bun
/**
 * hodlmm-dca — Recurring DCA into Bitflow HODLMM DLMM pools
 *
 * Each `run` call checks the frequency gate and, if due, swaps a fixed STX
 * amount via BitflowSDK at the current HODLMM active-bin price, then outputs
 * a ready-to-execute `bitflow_hodlmm_add_liquidity` MCP command for LP deployment.
 *
 * The agent IS the scheduler — no external keeper required.
 *
 * Usage: bun run hodlmm-dca/hodlmm-dca.ts <command> [options]
 *
 * All commands emit strict JSON to stdout. Debug to stderr.
 */

import { Command } from "commander";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as crypto from "crypto";

// ─── Constants ────────────────────────────────────────────────────────────────

const HODLMM_API = "https://bff.bitflowapis.finance/api/app/v1";
const BITFLOW_QUOTES = "https://bff.bitflowapis.finance/api/quotes/v1";
const BITFLOW_API_HOST = "https://api.bitflowapis.finance";
const STACKS_API = "https://api.mainnet.hiro.so";
const EXPLORER_BASE = "https://explorer.hiro.so/txid";

const DCA_DIR = path.join(os.homedir(), ".aibtc", "hodlmm-dca");
const WALLETS_FILE = path.join(os.homedir(), ".aibtc", "wallets.json");
const WALLETS_DIR = path.join(os.homedir(), ".aibtc", "wallets");
const PLAN_FILE = path.join(DCA_DIR, "plan.json");
const HISTORY_FILE = path.join(DCA_DIR, "history.json");

// Safety limits — hardcoded, not configurable
const MAX_STX_PER_RUN = 500;
const MAX_TOTAL_STX = 10_000;
const MIN_INTERVAL_HOURS = 1;
const MAX_SLIPPAGE_PCT = 5;
const MAX_BIN_SPREAD = 5; // ±5 bins = 11 bins total
const GAS_BUFFER_STX = 0.1;
const MAX_CONSECUTIVE_FAILURES = 3;
const FETCH_TIMEOUT = 30_000;
const TX_FEE_ESTIMATE = 50_000; // microSTX

// ─── Types ────────────────────────────────────────────────────────────────────

interface DcaPlan {
  pool_id: string;
  stx_per_run: number;       // STX to swap per DCA run
  interval_hours: number;    // minimum hours between runs
  bin_spread: number;        // bins on each side of active bin (max 5)
  slippage_pct: number;      // max accepted slippage (max 5%)
  created_at: string;
  next_run_at: string;       // ISO timestamp of next eligible run
  total_deployed: number;    // cumulative STX deployed
  run_count: number;         // completed runs
  max_runs: number | null;   // optional cap on total runs
  status: "active" | "paused_errors" | "completed" | "cancelled";
  consecutive_failures: number;
}

interface DcaEntry {
  id: string;
  timestamp: string;
  pool_id: string;
  active_bin: number;
  bin_price: string;         // token_y per token_x at active bin
  stx_amount: number;
  token_in: string;
  token_out: string;
  amount_out_estimated: number;
  tx_id: string | null;      // null = dry-run
  explorer_url: string | null;
  status: "success" | "dry-run" | "failed";
  error: string | null;
  mcp_deposit_cmd: string | null; // add-liquidity MCP command to deploy acquired tokens
}

interface PoolMeta {
  pool_id: string;
  pool_contract: string;
  token_x: string;
  token_y: string;
  token_x_symbol: string;
  token_y_symbol: string;
  token_x_decimals: number;
  token_y_decimals: number;
  active_bin: number;
  bin_step: number;
  fee_bps: number;
}

// ─── Output helper ─────────────────────────────────────────────────────────────

function out(
  status: "success" | "error" | "blocked",
  action: string,
  data: unknown,
  error: string | null = null
): void {
  console.log(JSON.stringify({ status, action, data, error }));
}

function log(...args: unknown[]): void {
  process.stderr.write(`[hodlmm-dca] ${args.join(" ")}\n`);
}

// ─── Fetch helper ──────────────────────────────────────────────────────────────

async function fetchJson<T>(url: string): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

// ─── Wallet ────────────────────────────────────────────────────────────────────

async function getWalletKeys(
  password: string
): Promise<{ stxPrivateKey: string; stxAddress: string }> {
  if (process.env.STACKS_PRIVATE_KEY) {
    const { getAddressFromPrivateKey, TransactionVersion } =
      await import("@stacks/transactions" as string);
    const key = process.env.STACKS_PRIVATE_KEY;
    const address = getAddressFromPrivateKey(key, TransactionVersion.Mainnet);
    return { stxPrivateKey: key, stxAddress: address };
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
          const mnemonic = Buffer.concat([
            decipher.update(ciphertext),
            decipher.final(),
          ])
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
  throw new Error(
    "No wallet found. Run: npx @aibtc/mcp-server@latest --install"
  );
}

// ─── HODLMM API ────────────────────────────────────────────────────────────────

// Symbol lookup from contract ID — covers known tokens without external call
const KNOWN_SYMBOLS: Record<string, { symbol: string; decimals: number }> = {
  "SM1793C4R5PZ4NS4VQ4WMP7SKKYVH8JZEWSZ9HCCR.token-stx-v-1-2": { symbol: "STX", decimals: 6 },
  "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token":       { symbol: "sBTC", decimals: 8 },
  "SP120SBRBQJ00MCWS7TM5R8WJNTTKD5K0HFRC2CNE.usdcx":            { symbol: "USDCx", decimals: 6 },
  "SPN5AKG35QZSK2M8GAMR4AFX45659RJHDW353HSG.usdh-token-v1":     { symbol: "USDh", decimals: 6 },
  "SP2XD7417HGPRTREMKF748VNEQPDRR0RMANB7X1NK.token-aeusdc":     { symbol: "aeUSDC", decimals: 6 },
};

function tokenInfo(contract: string): { symbol: string; decimals: number } {
  return KNOWN_SYMBOLS[contract] ?? { symbol: contract.split(".")[1] ?? contract, decimals: 6 };
}

async function fetchPools(): Promise<PoolMeta[]> {
  // Quotes API has active_bin and snake_case fields
  const raw = await fetchJson<unknown>(
    `${BITFLOW_QUOTES}/pools?amm_type=dlmm`
  );
  const r = raw as Record<string, unknown>;
  const list = (Array.isArray(raw) ? raw : r.pools ?? r.data ?? r.results ?? []) as Record<string, unknown>[];
  return list.map((p) => {
    const txContract = String(p.token_x ?? "");
    const tyContract = String(p.token_y ?? "");
    const tx = tokenInfo(txContract);
    const ty = tokenInfo(tyContract);
    return {
      pool_id: String(p.pool_id ?? ""),
      pool_contract: String(p.pool_token ?? p.pool_contract ?? ""),
      token_x: txContract,
      token_y: tyContract,
      token_x_symbol: tx.symbol,
      token_y_symbol: ty.symbol,
      token_x_decimals: tx.decimals,
      token_y_decimals: ty.decimals,
      active_bin: Number(p.active_bin ?? 0),
      bin_step: Number(p.bin_step ?? 1),
      fee_bps: Number(p.x_total_fee_bps ?? 30),
    };
  });
}

async function fetchStxBalance(address: string): Promise<number> {
  const data = await fetchJson<{ balance?: string; stx?: { balance?: string } }>(
    `${STACKS_API}/extended/v1/address/${address}/stx`
  );
  // API returns { balance: "microSTX" } at root level
  const raw = data?.balance ?? data?.stx?.balance ?? "0";
  return Number(raw) / 1_000_000;
}

// Determine which token in the pool is NOT STX so we know the swap target.
// DLMM pools can have STX as either token_x or token_y.
function resolveSwapTarget(pool: PoolMeta): {
  targetSymbol: string;
  targetDecimals: number;
  isTargetTokenX: boolean; // true = acquired token goes into amount_x bins
} {
  const isStxY = pool.token_y_symbol.toUpperCase() === "STX";
  if (isStxY) {
    return {
      targetSymbol: pool.token_x_symbol,
      targetDecimals: pool.token_x_decimals,
      isTargetTokenX: true,
    };
  }
  return {
    targetSymbol: pool.token_y_symbol,
    targetDecimals: pool.token_y_decimals,
    isTargetTokenX: false,
  };
}

// ─── BitflowSDK swap ───────────────────────────────────────────────────────────

async function executeSwap(opts: {
  tokenInSymbol: string;
  tokenOutSymbol: string;
  amountHuman: number;
  senderAddress: string;
  stxPrivateKey: string;
  slippagePct: number;
  dryRun: boolean;
}): Promise<{ txId: string; explorerUrl: string; amountOut: number }> {
  const { BitflowSDK } = await import("@bitflowlabs/core-sdk" as string);
  const sdk = new BitflowSDK({
    BITFLOW_API_HOST: BITFLOW_API_HOST,
    API_HOST: BITFLOW_API_HOST,
    STACKS_API_HOST: STACKS_API,
    KEEPER_API_HOST: BITFLOW_API_HOST,
    KEEPER_API_URL: BITFLOW_API_HOST,
  });

  // Resolve token IDs
  const tokens = await sdk.getAvailableTokens();
  const findToken = (symbol: string) => {
    const sym = symbol.toLowerCase();
    return tokens.find(
      (t: Record<string, string>) =>
        (t.symbol ?? "").toLowerCase() === sym ||
        (t.tokenId ?? "").toLowerCase() === sym ||
        (t["token-id"] ?? "").toLowerCase() === sym
    );
  };

  const tokenIn = findToken(opts.tokenInSymbol);
  if (!tokenIn) throw new Error(`Token not in Bitflow SDK: ${opts.tokenInSymbol}`);
  const tokenOut = findToken(opts.tokenOutSymbol);
  if (!tokenOut) throw new Error(`Token not in Bitflow SDK: ${opts.tokenOutSymbol}`);

  log(`Tokens resolved: ${tokenIn.symbol} → ${tokenOut.symbol}`);

  const quoteResult = await sdk.getQuoteForRoute(
    tokenIn.tokenId ?? tokenIn["token-id"],
    tokenOut.tokenId ?? tokenOut["token-id"],
    opts.amountHuman
  );
  if (!quoteResult?.bestRoute?.route) {
    throw new Error(
      `No swap route for ${opts.tokenInSymbol} → ${opts.tokenOutSymbol}`
    );
  }

  const amountOut: number =
    quoteResult.bestRoute.outputAmount ??
    quoteResult.bestRoute.amountOut ??
    0;

  // Dry-run: skip prepareSwap (requires valid sender address) and return simulation
  if (opts.dryRun) {
    const fakeTxId = "dry-run-" + crypto.randomBytes(8).toString("hex");
    return {
      txId: fakeTxId,
      explorerUrl: `${EXPLORER_BASE}/${fakeTxId}?chain=mainnet`,
      amountOut,
    };
  }

  const swapExecutionData = {
    route: quoteResult.bestRoute.route,
    amount: opts.amountHuman,
    tokenXDecimals: tokenIn.tokenDecimals ?? 6,
    tokenYDecimals: tokenOut.tokenDecimals ?? 6,
  };

  const swapParams = await sdk.prepareSwap(
    swapExecutionData,
    opts.senderAddress,
    opts.slippagePct / 100
  );

  const {
    makeContractCall,
    broadcastTransaction,
    AnchorMode,
    PostConditionMode,
  } = await import("@stacks/transactions" as string);
  const { STACKS_MAINNET } = await import("@stacks/network" as string);

  const tx = await makeContractCall({
    contractAddress: swapParams.contractAddress,
    contractName: swapParams.contractName,
    functionName: swapParams.functionName,
    functionArgs: swapParams.functionArgs,
    postConditions: swapParams.postConditions,
    postConditionMode: PostConditionMode.Deny,
    network: STACKS_MAINNET,
    senderKey: opts.stxPrivateKey,
    anchorMode: AnchorMode.Any,
    fee: BigInt(TX_FEE_ESTIMATE),
  });

  const broadcastRes = await broadcastTransaction({
    transaction: tx,
    network: STACKS_MAINNET,
  });

  if (broadcastRes.error) {
    throw new Error(
      `Broadcast failed: ${broadcastRes.error} — ${(broadcastRes as Record<string, string>).reason ?? ""}`
    );
  }

  const txId = broadcastRes.txid as string;
  return { txId, explorerUrl: `${EXPLORER_BASE}/${txId}?chain=mainnet`, amountOut };
}

// ─── Plan & History ────────────────────────────────────────────────────────────

function ensureDir(): void {
  if (!fs.existsSync(DCA_DIR)) fs.mkdirSync(DCA_DIR, { recursive: true });
}

function loadPlan(): DcaPlan | null {
  try {
    if (fs.existsSync(PLAN_FILE)) {
      return JSON.parse(fs.readFileSync(PLAN_FILE, "utf-8")) as DcaPlan;
    }
  } catch {}
  return null;
}

function savePlan(plan: DcaPlan): void {
  ensureDir();
  fs.writeFileSync(PLAN_FILE, JSON.stringify(plan, null, 2));
}

function loadHistory(): DcaEntry[] {
  try {
    if (fs.existsSync(HISTORY_FILE)) {
      return JSON.parse(fs.readFileSync(HISTORY_FILE, "utf-8")) as DcaEntry[];
    }
  } catch {}
  return [];
}

function appendHistory(entry: DcaEntry): void {
  ensureDir();
  const history = loadHistory();
  history.push(entry);
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2));
}

// ─── Deposit command builder ───────────────────────────────────────────────────

function buildDepositCmd(
  poolId: string,
  activeBin: number,
  binSpread: number,
  tokenOutAmount: number,
  slippagePct: number,
  isTargetTokenX: boolean
): string {
  // Distribute equally across ±binSpread bins centered on activeBin.
  // Place acquired tokens on the correct side of the DLMM bin.
  const numBins = binSpread * 2 + 1;
  const amountPerBin = Math.floor(tokenOutAmount / numBins);
  const bins = Array.from({ length: numBins }, (_, i) => {
    const binOffset = i - binSpread;
    const binId = activeBin + binOffset;
    const amountX = isTargetTokenX ? amountPerBin : 0;
    const amountY = isTargetTokenX ? 0 : amountPerBin;
    return `{bin_id: ${binId}, amount_x: ${amountX}, amount_y: ${amountY}}`;
  });

  return [
    `bitflow_hodlmm_add_liquidity`,
    `pool_id: "${poolId}"`,
    `bins: [${bins.join(", ")}]`,
    `slippage: ${slippagePct}`,
  ].join("\n");
}

// ─── CLI ───────────────────────────────────────────────────────────────────────

const program = new Command();

program
  .name("hodlmm-dca")
  .description(
    "Recurring DCA into Bitflow HODLMM DLMM pools — swap STX at current active-bin price, output LP deploy command"
  );

program.configureOutput({
  writeOut: (str) => process.stderr.write(str),
  writeErr: (str) => process.stderr.write(str),
});

process.on("unhandledRejection", (err) => {
  out("error", "crash", null, String(err));
  process.exit(1);
});

// ── install-packs ─────────────────────────────────────────────────────────────
program
  .command("install-packs")
  .description("No-op — dependencies must be installed by the runtime")
  .action(() => {
    out("success", "install-packs", {
      note: "Install: bun add commander @bitflowlabs/core-sdk @stacks/transactions @stacks/network @stacks/wallet-sdk @stacks/encryption",
    });
  });

// ── doctor ────────────────────────────────────────────────────────────────────
program
  .command("doctor")
  .description("Check wallet, HODLMM API, and available pools")
  .action(async () => {
    const checks: Record<string, unknown> = {
      hodlmmApi: false,
      pools: [],
      walletConfigFound: false,
      planExists: fs.existsSync(PLAN_FILE),
      safetyLimits: {
        maxStxPerRun: MAX_STX_PER_RUN,
        maxTotalStx: MAX_TOTAL_STX,
        minIntervalHours: MIN_INTERVAL_HOURS,
        maxSlippagePct: MAX_SLIPPAGE_PCT,
        maxBinSpread: MAX_BIN_SPREAD,
      },
    };

    try {
      const pools = await fetchPools();
      checks.hodlmmApi = pools.length > 0;
      checks.pools = pools.map((p) => ({
        pool_id: p.pool_id,
        pair: `${p.token_x_symbol}/${p.token_y_symbol}`,
        activeBin: p.active_bin,
        binStep: p.bin_step,
      }));
    } catch (e) {
      checks.hodlmmApiError = String(e);
    }

    checks.walletConfigFound =
      fs.existsSync(WALLETS_FILE) ||
      !!process.env.STACKS_PRIVATE_KEY ||
      !!process.env.AIBTC_WALLET_PASSWORD;

    out("success", "doctor", checks);
  });

// ── setup ─────────────────────────────────────────────────────────────────────
program
  .command("setup")
  .description("Configure a DCA plan")
  .requiredOption("--pool <id>", "HODLMM pool ID (e.g. dlmm_1)")
  .requiredOption("--stx-per-run <n>", "STX to swap per DCA run", parseFloat)
  .requiredOption(
    "--interval-hours <n>",
    "Minimum hours between runs",
    parseFloat
  )
  .option(
    "--bin-spread <n>",
    "Bins on each side of active bin for LP deploy (max 5)",
    (v: string) => parseInt(v, 10),
    3
  )
  .option(
    "--slippage <pct>",
    "Max swap slippage percentage (max 5)",
    parseFloat,
    1
  )
  .option("--max-runs <n>", "Optional: max total DCA runs", (v: string) => parseInt(v, 10))
  .action(async (opts) => {
    // Validate limits
    if (opts.stxPerRun > MAX_STX_PER_RUN) {
      out(
        "error",
        "setup",
        null,
        `stx-per-run ${opts.stxPerRun} exceeds max ${MAX_STX_PER_RUN} STX`
      );
      return;
    }
    if (opts.intervalHours < MIN_INTERVAL_HOURS) {
      out(
        "error",
        "setup",
        null,
        `interval-hours ${opts.intervalHours} below minimum ${MIN_INTERVAL_HOURS}h`
      );
      return;
    }
    if (opts.binSpread > MAX_BIN_SPREAD) {
      out(
        "error",
        "setup",
        null,
        `bin-spread ${opts.binSpread} exceeds max ${MAX_BIN_SPREAD}`
      );
      return;
    }
    if (opts.slippage > MAX_SLIPPAGE_PCT) {
      out(
        "error",
        "setup",
        null,
        `slippage ${opts.slippage}% exceeds max ${MAX_SLIPPAGE_PCT}%`
      );
      return;
    }

    // Verify pool exists
    let pools: PoolMeta[];
    try {
      pools = await fetchPools();
    } catch (e) {
      out("error", "setup", null, `HODLMM API error: ${e}`);
      return;
    }
    const pool = pools.find((p) => p.pool_id === opts.pool);
    if (!pool) {
      out(
        "error",
        "setup",
        {
          availablePools: pools.map((p) => p.pool_id),
        },
        `Pool ${opts.pool} not found`
      );
      return;
    }

    const now = new Date();
    const plan: DcaPlan = {
      pool_id: opts.pool,
      stx_per_run: opts.stxPerRun,
      interval_hours: opts.intervalHours,
      bin_spread: opts.binSpread,
      slippage_pct: opts.slippage,
      created_at: now.toISOString(),
      next_run_at: now.toISOString(), // immediately eligible
      total_deployed: 0,
      run_count: 0,
      max_runs: opts.maxRuns ?? null,
      status: "active",
      consecutive_failures: 0,
    };

    savePlan(plan);

    out("success", "setup", {
      plan,
      pool: {
        pair: `${pool.token_x_symbol}/${pool.token_y_symbol}`,
        activeBin: pool.active_bin,
        binStep: pool.bin_step,
      },
      nextStep: "Run: bun run hodlmm-dca/hodlmm-dca.ts run",
    });
  });

// ── run ───────────────────────────────────────────────────────────────────────
program
  .command("run")
  .description(
    "Check frequency gate and DCA if due. Dry-run unless --confirm."
  )
  .option("--confirm", "Execute on-chain (required for real swaps)")
  .option(
    "--wallet-password <pw>",
    "Wallet decryption password (or use AIBTC_WALLET_PASSWORD env var)"
  )
  .action(async (opts) => {
    const plan = loadPlan();
    if (!plan) {
      out("blocked", "run", null, "No active plan. Run: setup first.");
      return;
    }

    if (plan.status === "cancelled") {
      out("blocked", "run", { plan }, "Plan is cancelled.");
      return;
    }
    if (plan.status === "completed") {
      out("blocked", "run", { plan }, "Plan completed all runs.");
      return;
    }
    if (plan.status === "paused_errors") {
      out(
        "blocked",
        "run",
        { plan },
        `Plan paused after ${MAX_CONSECUTIVE_FAILURES} consecutive failures. Inspect history and reset plan to resume.`
      );
      return;
    }

    // Frequency gate
    const nextRun = new Date(plan.next_run_at).getTime();
    const now = Date.now();
    if (now < nextRun) {
      const msLeft = nextRun - now;
      const minLeft = Math.ceil(msLeft / 60_000);
      out("blocked", "run", {
        nextRunAt: plan.next_run_at,
        minutesUntilDue: minLeft,
        plan,
      }, `Not due yet — ${minLeft}m remaining`);
      return;
    }

    // Total cap
    if (plan.total_deployed + plan.stx_per_run > MAX_TOTAL_STX) {
      out(
        "blocked",
        "run",
        { plan },
        `Total cap reached. total_deployed=${plan.total_deployed} + stx_per_run=${plan.stx_per_run} > max=${MAX_TOTAL_STX}`
      );
      return;
    }

    // Max runs cap
    if (plan.max_runs !== null && plan.run_count >= plan.max_runs) {
      plan.status = "completed";
      savePlan(plan);
      out("blocked", "run", { plan }, "Max runs reached — plan completed.");
      return;
    }

    // Fetch pool state
    let pool: PoolMeta | undefined;
    try {
      const pools = await fetchPools();
      pool = pools.find((p) => p.pool_id === plan.pool_id);
    } catch (e) {
      out("error", "run", null, `HODLMM API error: ${e}`);
      return;
    }
    if (!pool) {
      out("error", "run", null, `Pool ${plan.pool_id} not found`);
      return;
    }

    const isDryRun = !opts.confirm;
    const entryId = crypto.randomBytes(6).toString("hex");

    // Wallet — only needed for real execution
    let stxAddress = process.env.STX_ADDRESS ?? "";
    let stxPrivateKey = "";

    if (!isDryRun) {
      const password =
        opts.walletPassword ?? process.env.AIBTC_WALLET_PASSWORD;
      if (!password) {
        out(
          "blocked",
          "run",
          null,
          "Wallet password required. Use --wallet-password or AIBTC_WALLET_PASSWORD env var."
        );
        return;
      }
      try {
        const keys = await getWalletKeys(password);
        stxPrivateKey = keys.stxPrivateKey;
        stxAddress = keys.stxAddress;
      } catch (e) {
        out("error", "run", null, `Wallet error: ${e}`);
        return;
      }

      // Balance check
      const balance = await fetchStxBalance(stxAddress);
      const required = plan.stx_per_run + GAS_BUFFER_STX;
      if (balance < required) {
        out(
          "blocked",
          "run",
          { balance, required },
          `Insufficient STX. Have ${balance.toFixed(4)}, need ${required.toFixed(4)}`
        );
        return;
      }
    }

    // Determine swap direction (STX can be token_x or token_y in DLMM pools)
    const swapTarget = resolveSwapTarget(pool);

    // DLMM bin price: (1 + bin_step / 10000) ^ active_bin
    const binPrice = Math.pow(1 + pool.bin_step / 10000, pool.active_bin).toFixed(8);

    // Execute swap
    log(
      isDryRun
        ? `Dry-run: ${plan.stx_per_run} STX → ${swapTarget.targetSymbol} on ${pool.pool_id} (active bin ${pool.active_bin})`
        : `Executing: ${plan.stx_per_run} STX → ${swapTarget.targetSymbol} on ${pool.pool_id}`
    );

    const entry: DcaEntry = {
      id: entryId,
      timestamp: new Date().toISOString(),
      pool_id: plan.pool_id,
      active_bin: pool.active_bin,
      bin_price: binPrice,
      stx_amount: plan.stx_per_run,
      token_in: "STX",
      token_out: swapTarget.targetSymbol,
      amount_out_estimated: 0,
      tx_id: null,
      explorer_url: null,
      status: isDryRun ? "dry-run" : "success",
      error: null,
      mcp_deposit_cmd: null,
    };

    try {
      const swapResult = await executeSwap({
        tokenInSymbol: "STX",
        tokenOutSymbol: swapTarget.targetSymbol,
        amountHuman: plan.stx_per_run,
        senderAddress: stxAddress,
        stxPrivateKey,
        slippagePct: plan.slippage_pct,
        dryRun: isDryRun,
      });

      entry.amount_out_estimated = swapResult.amountOut;
      entry.tx_id = swapResult.txId;
      entry.explorer_url = swapResult.explorerUrl;

      // Build add-liquidity MCP command for the acquired tokens.
      // Use the correct token side and decimals based on which token was acquired.
      const amountOutMicro = Math.floor(
        swapResult.amountOut * Math.pow(10, swapTarget.targetDecimals)
      );
      entry.mcp_deposit_cmd = buildDepositCmd(
        plan.pool_id,
        pool.active_bin,
        plan.bin_spread,
        amountOutMicro,
        plan.slippage_pct,
        swapTarget.isTargetTokenX
      );

      // Update plan state
      plan.run_count += 1;
      if (!isDryRun) plan.total_deployed += plan.stx_per_run;
      plan.next_run_at = new Date(
        Date.now() + plan.interval_hours * 3_600_000
      ).toISOString();
      plan.consecutive_failures = 0;
      savePlan(plan);
      appendHistory(entry);

      out("success", "run", {
        dryRun: isDryRun,
        entry,
        plan: {
          run_count: plan.run_count,
          total_deployed: plan.total_deployed,
          next_run_at: plan.next_run_at,
        },
        nextStep: isDryRun
          ? "Add --confirm to execute on-chain"
          : `Optional LP deploy: call \`bitflow_hodlmm_add_liquidity\` with mcpDepositCmd`,
      });
    } catch (e) {
      entry.status = "failed";
      entry.error = String(e);
      plan.consecutive_failures += 1;
      if (plan.consecutive_failures >= MAX_CONSECUTIVE_FAILURES) {
        plan.status = "paused_errors";
      }
      savePlan(plan);
      appendHistory(entry);
      out(
        "error",
        "run",
        { entry, consecutiveFailures: plan.consecutive_failures },
        String(e)
      );
    }
  });

// ── status ────────────────────────────────────────────────────────────────────
program
  .command("status")
  .description("Show current plan and DCA progress")
  .action(() => {
    const plan = loadPlan();
    if (!plan) {
      out("blocked", "status", null, "No plan configured. Run: setup first.");
      return;
    }

    const history = loadHistory();
    const successfulRuns = history.filter((e) => e.status === "success");
    const now = Date.now();
    const nextRun = new Date(plan.next_run_at).getTime();
    const isDue = now >= nextRun;

    out("success", "status", {
      plan,
      stats: {
        total_runs: plan.run_count,
        successful_runs: successfulRuns.length,
        total_stx_deployed: plan.total_deployed,
        remaining_capacity: MAX_TOTAL_STX - plan.total_deployed,
        is_due: isDue,
        minutes_until_due: isDue ? 0 : Math.ceil((nextRun - now) / 60_000),
      },
      recentEntries: history.slice(-3),
    });
  });

// ── history ───────────────────────────────────────────────────────────────────
program
  .command("history")
  .description("List all DCA entries")
  .option("--limit <n>", "Max entries to show", (v: string) => parseInt(v, 10), 20)
  .action((opts) => {
    const history = loadHistory();
    const page = history.slice(-opts.limit);

    const summary = {
      total: history.length,
      successful: history.filter((e) => e.status === "success").length,
      failed: history.filter((e) => e.status === "failed").length,
      dryRuns: history.filter((e) => e.status === "dry-run").length,
      totalStxDeployed: history
        .filter((e) => e.status === "success")
        .reduce((s, e) => s + e.stx_amount, 0),
    };

    out("success", "history", { summary, entries: page });
  });

// ── cancel ────────────────────────────────────────────────────────────────────
program
  .command("cancel")
  .description("Cancel the active DCA plan")
  .action(() => {
    const plan = loadPlan();
    if (!plan) {
      out("blocked", "cancel", null, "No plan to cancel.");
      return;
    }
    plan.status = "cancelled";
    savePlan(plan);
    out("success", "cancel", { plan }, null);
  });

program.parse(process.argv);
