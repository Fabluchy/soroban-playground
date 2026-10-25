import {
  Address,
  Contract,
  nativeToScVal,
  rpc,
  scValToNative,
  TransactionBuilder,
} from "@stellar/stellar-sdk";

export interface AllowanceToken {
  contractId: string;
  symbol: string;
  name: string;
  decimals: number;
}

export interface AllowanceSpender {
  address: string;
  name: string;
}

export interface TokenAllowance {
  token: AllowanceToken;
  spender: AllowanceSpender;
  amount: bigint;
  expirationLedger: number;
}

export interface AllowanceScanResult {
  allowances: TokenAllowance[];
  failedChecks: number;
  currentLedger: number;
}

export const NETWORK_RPC_URLS: Record<string, string> = {
  "Public Global Stellar Network ; September 2015":
    "https://soroban-rpc.mainnet.stellar.org",
  "Test SDF Network ; September 2015":
    "https://soroban-testnet.stellar.org",
  "Test SDF Future Network ; October 2022":
    "https://rpc-futurenet.stellar.org",
  "Standalone Network ; February 2022": "http://localhost:8000/soroban/rpc",
};

const ACCOUNT_OR_CONTRACT_ID = /^(?:G|C)[A-Z2-7]{55}$/;
const MAX_I128 = (1n << 127n) - 1n;
const HIGH_RISK_RAW_THRESHOLD = 1_000_000n;

function getField(value: unknown, ...keys: string[]): unknown {
  if (value instanceof Map) {
    for (const key of keys) {
      if (value.has(key)) return value.get(key);
    }
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const key of keys) {
      if (key in record) return record[key];
    }
  }
  return undefined;
}

export function parseAllowanceValue(value: unknown): {
  amount: bigint;
  expirationLedger: number;
} {
  const amountValue = getField(value, "amount", "0");
  const expirationValue = getField(
    value,
    "expiration_ledger",
    "expirationLedger",
    "1",
  );
  const amount = BigInt(String(amountValue ?? "0"));
  const expirationLedger = Number(expirationValue ?? 0);
  if (amount < 0n || !Number.isSafeInteger(expirationLedger) || expirationLedger < 0) {
    throw new Error("The token returned an invalid SEP-41 allowance.");
  }
  return { amount, expirationLedger };
}

export function formatTokenAmount(amount: bigint, decimals: number): string {
  const negative = amount < 0n;
  const digits = (negative ? -amount : amount)
    .toString()
    .padStart(decimals + 1, "0");
  if (decimals === 0) return `${negative ? "-" : ""}${digits}`;
  const whole = digits.slice(0, -decimals);
  const fraction = digits.slice(-decimals).replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}

export function allowanceRisk(
  allowance: TokenAllowance,
): "unlimited" | "high" | "normal" {
  if (allowance.amount >= MAX_I128) return "unlimited";
  const threshold = HIGH_RISK_RAW_THRESHOLD * 10n ** BigInt(allowance.token.decimals);
  return allowance.amount >= threshold ? "high" : "normal";
}

export function allowanceStatus(
  allowance: TokenAllowance,
  currentLedger: number,
): "expired" | "expiring" | "active" {
  if (allowance.expirationLedger < currentLedger) return "expired";
  if (allowance.expirationLedger - currentLedger <= 17_280) return "expiring";
  return "active";
}

function makeServer(networkPassphrase: string): rpc.Server {
  const endpoint = NETWORK_RPC_URLS[networkPassphrase];
  if (!endpoint) throw new Error("No Soroban RPC endpoint is configured for this network.");
  return new rpc.Server(endpoint, { allowHttp: endpoint.startsWith("http://") });
}

export async function scanTokenAllowances(
  owner: string,
  networkPassphrase: string,
  tokens: AllowanceToken[],
  spenders: AllowanceSpender[],
  server = makeServer(networkPassphrase),
): Promise<AllowanceScanResult> {
  if (!/^G[A-Z2-7]{55}$/.test(owner)) {
    throw new Error("Connect a valid Stellar account before scanning allowances.");
  }
  const validTokens = tokens.filter((token) => /^C[A-Z2-7]{55}$/.test(token.contractId));
  const validSpenders = spenders.filter((spender) => ACCOUNT_OR_CONTRACT_ID.test(spender.address));
  const [{ sequence }, sourceAccount] = await Promise.all([
    server.getLatestLedger(),
    server.getAccount(owner),
  ]);
  let failedChecks = 0;
  const checks = validTokens.flatMap((token) =>
    validSpenders.map(async (spender): Promise<TokenAllowance | null> => {
      try {
        const transaction = new TransactionBuilder(sourceAccount, {
          fee: "100",
          networkPassphrase,
        })
          .addOperation(
            new Contract(token.contractId).call(
              "allowance",
              new Address(owner).toScVal(),
              new Address(spender.address).toScVal(),
            ),
          )
          .setTimeout(30)
          .build();
        const simulation = await server.simulateTransaction(transaction);
        if (rpc.Api.isSimulationError(simulation)) {
          throw new Error(simulation.error);
        }
        if (!simulation.result) {
          throw new Error("The Soroban simulation returned no allowance value.");
        }
        const parsed = parseAllowanceValue(scValToNative(simulation.result.retval));
        if (parsed.amount === 0n) return null;
        return { token, spender, ...parsed };
      } catch {
        failedChecks += 1;
        return null;
      }
    }),
  );
  const results = await Promise.all(checks);
  return {
    allowances: results.filter((allowance): allowance is TokenAllowance => allowance !== null),
    failedChecks,
    currentLedger: sequence,
  };
}

export async function buildAllowanceUpdateTransaction(
  owner: string,
  networkPassphrase: string,
  allowance: TokenAllowance,
  amount: bigint,
  expirationLedger: number,
  server = makeServer(networkPassphrase),
): Promise<string> {
  if (amount < 0n || amount >= allowance.amount) {
    throw new Error("An allowance update must lower the current allowance.");
  }
  if (!Number.isSafeInteger(expirationLedger) || expirationLedger < 0) {
    throw new Error("Enter a valid allowance expiration ledger.");
  }
  const sourceAccount = await server.getAccount(owner);
  const transaction = new TransactionBuilder(sourceAccount, {
    fee: "100",
    networkPassphrase,
  })
    .addOperation(
      new Contract(allowance.token.contractId).call(
        "approve",
        new Address(owner).toScVal(),
        new Address(allowance.spender.address).toScVal(),
        nativeToScVal(amount, { type: "i128" }),
        nativeToScVal(expirationLedger, { type: "u32" }),
      ),
    )
    .setTimeout(30)
    .build();
  const prepared = await server.prepareTransaction(transaction);
  return prepared.toXDR();
}

export function buildRevokeTransaction(
  owner: string,
  networkPassphrase: string,
  allowance: TokenAllowance,
  server = makeServer(networkPassphrase),
): Promise<string> {
  return buildAllowanceUpdateTransaction(
    owner,
    networkPassphrase,
    allowance,
    0n,
    0,
    server,
  );
}

export async function submitSignedTransaction(
  signedXdr: string,
  networkPassphrase: string,
  server = makeServer(networkPassphrase),
) {
  const transaction = TransactionBuilder.fromXDR(signedXdr, networkPassphrase);
  return server.sendTransaction(transaction);
}