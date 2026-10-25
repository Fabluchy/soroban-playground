import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import {
  Address,
  Account,
  Contract,
  Operation,
  StrKey,
  TransactionBuilder,
  hash,
  xdr,
} from '@stellar/stellar-sdk';

const execute = promisify(execFile);
export const DEPLOY_NETWORKS = Object.freeze({
  local: {
    passphrase: 'Standalone Network ; February 2017',
    rpc: 'http://localhost:8000/rpc',
    horizon: 'http://localhost:8000',
  },
  testnet: {
    passphrase: 'Test SDF Network ; September 2015',
    rpc: 'https://soroban-testnet.stellar.org',
    horizon: 'https://horizon-testnet.stellar.org',
  },
  futurenet: {
    passphrase: 'Test SDF Future Network ; October 2022',
    rpc: 'https://rpc-futurenet.stellar.org',
    horizon: 'https://horizon-futurenet.stellar.org',
  },
  mainnet: {
    passphrase: 'Public Global Stellar Network ; September 2015',
    rpc: 'https://soroban-rpc.mainnet.stellar.org',
    horizon: 'https://horizon.stellar.org',
  },
});

export function toStroops(value) {
  if (typeof value !== 'string' || !/^\d+(\.\d{1,7})?$/.test(value))
    throw new Error('Invalid XLM amount');
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole) * 10000000n + BigInt(fraction.padEnd(7, '0'));
}

export function deriveContractId(deployer, salt, passphrase) {
  if (!StrKey.isValidEd25519PublicKey(deployer))
    throw new Error('A valid deployer public key is required');
  if (!/^[a-fA-F0-9]{64}$/.test(salt))
    throw new Error(
      'Deployment salt must be exactly 32 bytes (64 hex characters)'
    );
  const preimage = new xdr.HashIdPreimageContractId({
    networkId: hash(Buffer.from(passphrase)),
    contractIdPreimage: xdr.ContractIdPreimage.contractIdPreimageFromAddress(
      new xdr.ContractIdPreimageFromAddress({
        address: new Address(deployer).toScAddress(),
        salt: Buffer.from(salt, 'hex'),
      })
    ),
  });
  return StrKey.encodeContract(
    hash(xdr.HashIdPreimage.envelopeTypeContractId(preimage).toXdr())
  );
}

export function evaluateFunding(account, baseReserve, feeStroops) {
  const native = account.balances.find((b) => b.asset_type === 'native');
  if (!native) throw new Error('The deployer has no native XLM balance');
  const units =
    2n +
    BigInt(account.subentry_count || 0) +
    BigInt(account.num_sponsoring || 0) -
    BigInt(account.num_sponsored || 0);
  if (units < 0n) throw new Error('Invalid account reserve metadata');
  const reserve = units * BigInt(baseReserve);
  const available =
    toStroops(native.balance) -
    toStroops(native.selling_liabilities || '0') -
    reserve;
  const signer = account.signers.find((s) => s.key === account.account_id);
  const authorized =
    Number(signer?.weight || 0) > 0 &&
    Number(signer?.weight || 0) >= Number(account.thresholds.med_threshold);
  return {
    sufficient: available >= BigInt(feeStroops),
    authorized,
    reserveStroops: String(reserve),
    availableStroops: String(available),
    feeStroops: String(feeStroops),
  };
}

/** Read-only pre-flight; the CLI performs its own final simulation at broadcast. */
export async function runDeployPreflight(input, deps = {}) {
  const started = Date.now();
  const network = DEPLOY_NETWORKS[input.network];
  if (!network)
    throw new Error(
      'Choose Localhost Quickstart, Testnet, Futurenet or Mainnet'
    );
  if (!/^[a-fA-F0-9]{64}$/.test(input.salt))
    throw new Error('Deployment salt must be exactly 64 hex characters');
  const sourceAccount =
    input.sourceAccount || process.env.SOROBAN_SOURCE_ACCOUNT;
  if (!sourceAccount || !/^[a-zA-Z0-9_-]{1,128}$/.test(sourceAccount))
    throw new Error(
      'Configure SOROBAN_SOURCE_ACCOUNT with the server deployment identity'
    );
  const publicKey = StrKey.isValidEd25519PublicKey(sourceAccount)
    ? sourceAccount
    : (
        await (deps.execute || execute)(
          process.env.SOROBAN_CLI || 'soroban',
          ['keys', 'address', sourceAccount],
          { timeout: 3000, maxBuffer: 4096 }
        )
      ).stdout.trim();
  const prefix = `SOROBAN_${input.network.toUpperCase()}_`;
  const rpcUrl = process.env[prefix + 'RPC_URL'] || network.rpc;
  const horizonUrl = (
    process.env[prefix + 'HORIZON_URL'] || network.horizon
  ).replace(/\/$/, '');
  const passphrase =
    process.env[prefix + 'NETWORK_PASSPHRASE'] || network.passphrase;
  const contractId = deriveContractId(publicKey, input.salt, passphrase);
  const wasm = await (deps.readFile || fs.readFile)(input.wasmPath);
  if (
    wasm.length > 16 * 1024 * 1024 ||
    wasm.length < 8 ||
    !wasm.subarray(0, 4).equals(Buffer.from([0, 97, 115, 109]))
  )
    throw new Error('The compiled artifact is not a valid WASM module');
  const wasmHash = Buffer.from(hash(wasm)).toString('hex');
  if (input.expectedWasmHash && input.expectedWasmHash !== wasmHash)
    throw new Error('The WASM artifact changed. Run pre-flight again.');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  const read = async (url, options = {}) => {
    const response = await (deps.fetch || fetch)(url, {
      ...options,
      signal: controller.signal,
    });
    if (!response.ok)
      throw new Error(`Network verification failed (${response.status})`);
    return response.json();
  };
  const rpc = async (method, params = {}) => {
    const result = await read(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    if (result.error) throw new Error(`RPC ${method} failed`);
    return result.result;
  };
  try {
    const codeKey = xdr.LedgerKey.contractCode(
      new xdr.LedgerKeyContractCode({ hash: Buffer.from(wasmHash, 'hex') })
    ).toXdr('base64');
    const instanceKey = new Contract(contractId).getFootprint().toXdr('base64');
    const [account, ledgers, info, entries, fees, horizon] = await Promise.all([
      read(`${horizonUrl}/accounts/${publicKey}`),
      read(`${horizonUrl}/ledgers?order=desc&limit=1`),
      rpc('getNetwork'),
      rpc('getLedgerEntries', { keys: [codeKey, instanceKey] }),
      rpc('getFeeStats'),
      read(horizonUrl),
    ]);
    if (
      info.passphrase !== passphrase ||
      horizon.network_passphrase !== passphrase ||
      account.account_id !== publicKey
    )
      throw new Error('Network or deployer identity mismatch');
    const ledger = ledgers._embedded.records[0];
    const code = entries.entries?.find((entry) => entry.key === codeKey);
    const codeLive = Boolean(
      code && Number(code.liveUntilLedgerSeq) > Number(entries.latestLedger)
    );
    const collision = Boolean(
      entries.entries?.some((entry) => entry.key === instanceKey)
    );
    const inclusionFee = BigInt(
      fees.sorobanInclusionFee?.p90 || ledger.base_fee_in_stroops
    );
    const op = codeLive
      ? Operation.createCustomContract({
          address: new Address(publicKey),
          wasmHash: Buffer.from(wasmHash, 'hex'),
          salt: Buffer.from(input.salt, 'hex'),
        })
      : Operation.uploadContractWasm({ wasm });
    const tx = new TransactionBuilder(
      new Account(publicKey, account.sequence),
      { fee: String(inclusionFee), networkPassphrase: passphrase }
    )
      .addOperation(op)
      .setTimeout(30)
      .build();
    const simulation = await rpc('simulateTransaction', {
      transaction: tx.toXDR(),
    });
    if (simulation.error || simulation.restorePreamble)
      throw new Error(
        simulation.restorePreamble
          ? 'Archived state must be restored before deploying'
          : 'Deployment simulation failed; check contract authorization and constructor requirements'
      );
    for (const auth of simulation.results?.flatMap(
      (result) => result.auth || []
    ) || []) {
      const credentials = xdr.SorobanAuthorizationEntry.fromXDR(
        auth,
        'base64'
      ).credentials();
      if (credentials.type !== 'sorobanCredentialsSourceAccount')
        throw new Error(
          'Additional contract administrator authorization is required before deployment'
        );
    }
    if (!/^\d+$/.test(String(simulation.minResourceFee)))
      throw new Error('RPC did not return a usable resource fee estimate');
    // A create cannot be simulated before code is installed. Reserve an explicit
    // additional budget, then let the CLI simulate creation after installation.
    const createBudget = codeLive
      ? 0n
      : BigInt(process.env.DEPLOY_CREATE_FEE_RESERVE_STROOPS || '10000000');
    const estimatedFee =
      BigInt(simulation.minResourceFee) * 2n +
      inclusionFee * (codeLive ? 1n : 2n) +
      createBudget;
    const funding = evaluateFunding(
      account,
      ledger.base_reserve_in_stroops,
      estimatedFee
    );
    const warnings = [];
    if (!codeLive)
      warnings.push(
        'WASM is not live on this network. Upload is required; the estimate includes a separate 1 XLM creation budget by default. Creation will be simulated by the CLI after upload.'
      );
    if (code && !codeLive)
      warnings.push(
        'The previously uploaded code is expired. Restore or re-upload it before creation.'
      );
    if (input.network === 'mainnet')
      warnings.push(
        'MAINNET: deployment spends real XLM. Confirm this network explicitly.'
      );
    return {
      ready:
        funding.sufficient &&
        funding.authorized &&
        !collision &&
        (!code || codeLive),
      network: input.network,
      sourceAccount,
      deployer: publicKey,
      salt: input.salt.toLowerCase(),
      wasmHash,
      contractId,
      rpcUrl,
      passphrase,
      codeStatus: codeLive ? 'live' : code ? 'expired' : 'not-uploaded',
      collision,
      funding,
      warnings,
      checkedAt: Date.now(),
      elapsedMs: Date.now() - started,
      checks: [
        { id: 'network', label: 'Network and deployer identity', passed: true },
        {
          id: 'code',
          label: codeLive
            ? 'WASM is live and reusable'
            : code
              ? 'Expired WASM must be restored or re-uploaded'
              : 'WASM upload is required and included in budget',
          passed: !code || codeLive,
        },
        {
          id: 'balance',
          label: 'XLM reserve, liabilities and estimated fees',
          passed: funding.sufficient,
        },
        {
          id: 'authorization',
          label: 'Deployer signing weight meets account threshold',
          passed: funding.authorized,
        },
        {
          id: 'address',
          label: 'Salt is valid and predicted contract address is unused',
          passed: !collision,
        },
        {
          id: 'simulation',
          label: codeLive
            ? 'Contract creation simulation'
            : 'WASM upload simulation (creation budget reserved)',
          passed: true,
        },
      ],
    };
  } finally {
    clearTimeout(timeout);
  }
}
