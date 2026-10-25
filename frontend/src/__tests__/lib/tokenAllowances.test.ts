import {
  Account,
  Keypair,
  nativeToScVal,
  scValToNative,
  StrKey,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk";
import {
  buildRevokeTransaction,
  scanTokenAllowances,
  TokenAllowance,
} from "@/lib/tokenAllowances";

const OWNER = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 1)).publicKey();
const SPENDER = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 2)).publicKey();
const TOKEN_CONTRACT = StrKey.encodeContract(Buffer.alloc(32, 17));
const PASSPHRASE = "Test SDF Network ; September 2015";
const SOURCE_ACCOUNT = new Account(OWNER, "100");
const TOKEN = {
  contractId: TOKEN_CONTRACT,
  symbol: "SAMPLE",
  name: "Sample Token",
  decimals: 7,
};
const SPENDER_INFO = { address: SPENDER, name: "Example DEX" };

function mockServer(overrides: Record<string, unknown> = {}) {
  return {
    getLatestLedger: jest.fn().mockResolvedValue({ sequence: 50_000 }),
    getAccount: jest.fn().mockResolvedValue(SOURCE_ACCOUNT),
    simulateTransaction: jest.fn().mockResolvedValue({
      result: {
        retval: xdr.ScVal.scvMap([
          new xdr.ScMapEntry({
            key: nativeToScVal("amount"),
            val: nativeToScVal(2_500_000_000n, { type: "i128" }),
          }),
          new xdr.ScMapEntry({
            key: nativeToScVal("expiration_ledger"),
            val: nativeToScVal(80_000, { type: "u32" }),
          }),
        ]),
      },
    }),
    prepareTransaction: jest.fn(async (transaction) => transaction),
    ...overrides,
  };
}

describe("token allowance service", () => {
  it("discovers a nonzero allowance from a SEP-41 read simulation", async () => {
    const server = mockServer();
    const result = await scanTokenAllowances(
      OWNER,
      PASSPHRASE,
      [TOKEN],
      [SPENDER_INFO],
      server as never,
    );

    expect(server.simulateTransaction).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ currentLedger: 50_000, failedChecks: 0 });
    expect(result.allowances).toHaveLength(1);
    expect(result.allowances[0]).toMatchObject({
      token: TOKEN,
      spender: SPENDER_INFO,
      amount: 2_500_000_000n,
      expirationLedger: 80_000,
    });
  });

  it("prepares approve(owner, spender, 0, 0) for revocation", async () => {
    const allowance: TokenAllowance = {
      token: TOKEN,
      spender: SPENDER_INFO,
      amount: 2_500_000_000n,
      expirationLedger: 80_000,
    };
    const server = mockServer();
    const xdr = await buildRevokeTransaction(
      OWNER,
      PASSPHRASE,
      allowance,
      server as never,
    );
    const transaction = TransactionBuilder.fromXDR(xdr, PASSPHRASE);
    const invokeArgs = transaction.operations[0].func.invokeContract();
    const args = invokeArgs.args().map((value) => scValToNative(value));

    expect(invokeArgs.functionName().toString()).toBe("approve");
    expect(args[0]).toBe(OWNER);
    expect(args[1]).toBe(SPENDER);
    expect(args[2]).toBe(0n);
    expect(args[3]).toBe(0);
    expect(server.prepareTransaction).toHaveBeenCalledTimes(1);
  });
});