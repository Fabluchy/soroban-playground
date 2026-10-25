import {
  Address,
  Keypair,
  Networks,
  Operation,
  hash,
  xdr,
} from '@stellar/stellar-sdk';
import {
  DEPLOY_NETWORKS,
  deriveContractId,
  evaluateFunding,
  runDeployPreflight,
  toStroops,
} from '../src/services/deployPreflight.js';

const deployer = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 7)).publicKey();
const salt = 'ab'.repeat(32);
const wasm = Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]);
function fixture(overrides = {}) {
  return {
    account_id: deployer,
    sequence: '1',
    subentry_count: 0,
    num_sponsoring: 0,
    num_sponsored: 0,
    balances: [
      {
        asset_type: 'native',
        balance: '100.0000000',
        selling_liabilities: '0',
      },
    ],
    thresholds: { med_threshold: 1 },
    signers: [{ key: deployer, weight: 1 }],
    ...overrides,
  };
}
function harness(options = {}) {
  const fetch = jest.fn(async (url, request) => {
    if (
      !request?.body &&
      !url.includes('/accounts/') &&
      !url.includes('/ledgers?')
    )
      return {
        ok: true,
        json: async () => ({
          network_passphrase: options.horizonPassphrase || Networks.TESTNET,
        }),
      };
    if (url.includes('/accounts/'))
      return { ok: true, json: async () => fixture(options.account) };
    if (url.includes('/ledgers?'))
      return {
        ok: true,
        json: async () => ({
          _embedded: {
            records: [
              {
                base_reserve_in_stroops: '5000000',
                base_fee_in_stroops: '100',
              },
            ],
          },
        }),
      };
    const { method, params } = JSON.parse(request.body);
    const response = {
      getNetwork: { passphrase: options.passphrase || Networks.TESTNET },
      getFeeStats: { sorobanInclusionFee: { p90: '100' } },
      getLedgerEntries: {
        latestLedger: 100,
        entries: [
          ...(options.noCode
            ? []
            : [
                {
                  key: params?.keys?.[0],
                  liveUntilLedgerSeq: options.expired ? 99 : 150,
                },
              ]),
          ...(options.collision ? [{ key: params?.keys?.[1] }] : []),
        ],
      },
      simulateTransaction: options.simulation || { minResourceFee: '1200' },
    }[method];
    return { ok: true, json: async () => ({ result: response }) };
  });
  return { fetch, readFile: jest.fn().mockResolvedValue(wasm) };
}
const input = {
  wasmPath: 'contract.wasm',
  network: 'testnet',
  sourceAccount: deployer,
  salt,
};

describe('deployment pre-flight rules', () => {
  test('derives the same contract ID as the actual operation preimage, independent of WASM content', () => {
    const op = Operation.createCustomContract({
      address: new Address(deployer),
      salt: Buffer.from(salt, 'hex'),
      wasmHash: hash(wasm),
    });
    const host = op.body.invokeHostFunctionOp.hostFunction;
    const operationPreimage = host.value.contractIdPreimage;
    const envelope = xdr.HashIdPreimage.envelopeTypeContractId(
      new xdr.HashIdPreimageContractId({
        networkId: hash(Buffer.from(Networks.TESTNET)),
        contractIdPreimage: operationPreimage,
      })
    );
    const { StrKey } = require('@stellar/stellar-sdk');
    expect(deriveContractId(deployer, salt, Networks.TESTNET)).toBe(
      StrKey.encodeContract(hash(envelope.toXdr()))
    );
    expect(deriveContractId(deployer, salt, Networks.TESTNET)).not.toBe(
      deriveContractId(deployer, salt, Networks.PUBLIC)
    );
  });
  test('rejects malformed salts and deployer keys', () => {
    for (const value of ['', 'ff', 'z'.repeat(64)])
      expect(() => deriveContractId(deployer, value, Networks.TESTNET)).toThrow(
        'salt'
      );
    expect(() => deriveContractId('bad', salt, Networks.TESTNET)).toThrow(
      'public key'
    );
  });
  test('uses exact stroops and rejects rounding, negative and exponent inputs', () => {
    expect(toStroops('1.0000001')).toBe(10000001n);
    expect(toStroops('9007199254740993')).toBe(90071992547409930000000n);
    for (const value of ['-1', '1e3', '0.00000001'])
      expect(() => toStroops(value)).toThrow();
  });
  test('accounts for subentries, sponsorship and selling liabilities', () => {
    const result = evaluateFunding(
      fixture({
        subentry_count: 3,
        num_sponsoring: 2,
        num_sponsored: 1,
        balances: [
          { asset_type: 'native', balance: '5', selling_liabilities: '1' },
        ],
      }),
      '5000000',
      '10000000'
    );
    expect(result.reserveStroops).toBe('30000000');
    expect(result.availableStroops).toBe('10000000');
    expect(result.sufficient).toBe(true);
    expect(
      evaluateFunding(
        fixture({ balances: [{ asset_type: 'native', balance: '1.0000099' }] }),
        '5000000',
        '100'
      ).sufficient
    ).toBe(false);
  });
  test('blocks disabled master signers and unmet medium thresholds', () => {
    expect(
      evaluateFunding(
        fixture({ thresholds: { med_threshold: 2 } }),
        '5000000',
        '100'
      ).authorized
    ).toBe(false);
    expect(
      evaluateFunding(
        fixture({ signers: [{ key: deployer, weight: 0 }] }),
        '5000000',
        '100'
      ).authorized
    ).toBe(false);
  });
  test('checks real network identity, live WASM, simulation and account funding', async () => {
    const deps = harness();
    const result = await runDeployPreflight(input, deps);
    expect(result.ready).toBe(true);
    expect(result.codeStatus).toBe('live');
    expect(result.deployer).toBe(deployer);
    expect(result.wasmHash).toBe(Buffer.from(hash(wasm)).toString('hex'));
    expect(result.contractId).toBe(
      deriveContractId(deployer, salt, Networks.TESTNET)
    );
    expect(result.funding.feeStroops).toBe('2500');
    expect(result.checks.every((c) => c.passed)).toBe(true);
  });
  test('missing WASM is explicit and includes upload simulation plus creation allowance', async () => {
    const result = await runDeployPreflight(input, harness({ noCode: true }));
    expect(result.codeStatus).toBe('not-uploaded');
    expect(result.funding.feeStroops).toBe('10002600');
    expect(result.warnings.join()).toMatch(/Upload is required/);
  });
  test('blocks expired code and address collisions', async () => {
    expect(
      (await runDeployPreflight(input, harness({ expired: true }))).ready
    ).toBe(false);
    expect(
      (await runDeployPreflight(input, harness({ collision: true }))).ready
    ).toBe(false);
  });
  test('fails closed on network mismatch, simulation failure and changed code', async () => {
    await expect(
      runDeployPreflight(input, harness({ passphrase: Networks.PUBLIC }))
    ).rejects.toThrow('mismatch');
    await expect(
      runDeployPreflight(input, harness({ simulation: { error: 'bad auth' } }))
    ).rejects.toThrow('simulation');
    await expect(
      runDeployPreflight(
        { ...input, expectedWasmHash: '00'.repeat(32) },
        harness()
      )
    ).rejects.toThrow('changed');
  });
  test('rejects unknown networks and invalid compiled files', async () => {
    await expect(
      runDeployPreflight({ ...input, network: 'untrusted-url' }, harness())
    ).rejects.toThrow('Choose');
    const deps = harness();
    deps.readFile.mockResolvedValue(Buffer.from('not wasm'));
    await expect(runDeployPreflight(input, deps)).rejects.toThrow('WASM');
    expect(Object.keys(DEPLOY_NETWORKS)).toEqual([
      'local',
      'testnet',
      'futurenet',
      'mainnet',
    ]);
  });
  test('Horizon and RPC must identify the same selected network', async () => {
    await expect(
      runDeployPreflight(input, harness({ horizonPassphrase: Networks.PUBLIC }))
    ).rejects.toThrow('mismatch');
  });
  test('network errors are never represented as passing checks', async () => {
    const deps = harness();
    deps.fetch.mockRejectedValue(new Error('offline'));
    await expect(runDeployPreflight(input, deps)).rejects.toThrow('offline');
  });
});
