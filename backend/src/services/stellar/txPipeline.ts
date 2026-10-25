import { createHash, randomUUID } from 'node:crypto';
import {
  Horizon,
  Networks,
  TransactionBuilder,
  type FeeBumpTransaction,
  type Transaction,
} from '@stellar/stellar-sdk';
import type Redis from 'ioredis';

const INITIALIZE_SEQUENCE_LUA = `
  local sequence = redis.call('GET', KEYS[1])
  if not sequence then
    redis.call('SET', KEYS[1], ARGV[1])
    return ARGV[1]
  end
  return sequence
`;

const RELEASE_LOCK_LUA = `
  if redis.call('GET', KEYS[1]) == ARGV[1] then
    return redis.call('DEL', KEYS[1])
  end
  return 0
`;

const RENEW_LOCK_LUA = `
  if redis.call('GET', KEYS[1]) == ARGV[1] then
    return redis.call('EXPIRE', KEYS[1], ARGV[2])
  end
  return 0
`;

type StellarTransaction = Transaction | FeeBumpTransaction;
type TransactionStatus = 'completed' | 'failed' | 'pending';

interface PipelineRecord {
  fingerprint: string;
  status: 'prepared' | 'submitted' | 'completed' | 'failed';
  transactionXdr?: string;
  hash?: string;
  result?: TransactionResult;
  error?: { code: string; message: string };
  feeBumped?: boolean;
}

interface HorizonTransactionRecord {
  hash: string;
  successful?: boolean;
  status?: string;
}

export interface TransactionResult {
  hash: string;
  status: TransactionStatus;
  transaction: unknown;
  feeBumped?: boolean;
}

export class StellarSubmissionError extends Error {
  code: string;
  hash?: string;

  constructor(code: string, message: string, hash?: string) {
    super(message);
    this.name = 'StellarSubmissionError';
    this.code = code;
    this.hash = hash;
  }
}

export interface SubmitTransactionOptions {
  sourceAccount: string;
  clientRequestToken: string;
  requestFingerprint: string;
  buildTransaction: (sequence: bigint) => Promise<Transaction> | Transaction;
  buildFeeBumpTransaction?: (
    transaction: Transaction,
    fee: string
  ) => Promise<FeeBumpTransaction> | FeeBumpTransaction;
  feeBumpFee?: string;
}

export interface StellarTransactionPipelineOptions {
  redis: Redis;
  horizonServer?: Horizon.Server;
  horizonUrl?: string;
  networkPassphrase?: string;
  pollIntervalMs?: number;
  maxPollIntervalMs?: number;
  submissionTimeoutMs?: number;
  feeBumpTimeoutMs?: number;
  lockTtlSeconds?: number;
  maxSequenceRetries?: number;
  maxResubmissions?: number;
  logger?: Pick<Console, 'warn' | 'error'>;
}

export class StellarTransactionPipeline {
  private readonly redis: Redis;
  private readonly horizon: Horizon.Server;
  private readonly networkPassphrase: string;
  private readonly pollIntervalMs: number;
  private readonly maxPollIntervalMs: number;
  private readonly submissionTimeoutMs: number;
  private readonly feeBumpTimeoutMs: number;
  private readonly lockTtlSeconds: number;
  private readonly maxSequenceRetries: number;
  private readonly maxResubmissions: number;
  private readonly logger: Pick<Console, 'warn' | 'error'>;

  constructor(options: StellarTransactionPipelineOptions) {
    if (!options.redis) throw new Error('A Redis client is required');
    this.redis = options.redis;
    this.horizon =
      options.horizonServer ??
      new Horizon.Server(
        options.horizonUrl ?? 'https://horizon-testnet.stellar.org'
      );
    this.networkPassphrase = options.networkPassphrase ?? Networks.TESTNET;
    this.pollIntervalMs = options.pollIntervalMs ?? 1000;
    this.maxPollIntervalMs = options.maxPollIntervalMs ?? 15000;
    this.submissionTimeoutMs = options.submissionTimeoutMs ?? 120000;
    this.feeBumpTimeoutMs = options.feeBumpTimeoutMs ?? 30000;
    this.lockTtlSeconds = options.lockTtlSeconds ?? 600;
    this.maxSequenceRetries = options.maxSequenceRetries ?? 3;
    this.maxResubmissions = options.maxResubmissions ?? 1;
    this.logger = options.logger ?? console;
  }

  async submit(options: SubmitTransactionOptions): Promise<TransactionResult> {
    this.validateRequest(options);
    const idempotencyKey = this.idempotencyKey(options.clientRequestToken);
    const idempotencyLock = `${idempotencyKey}:lock`;
    const idempotencyLockToken = await this.acquireLock(idempotencyLock);
    const stopIdempotencyRenewal = this.renewLock(
      idempotencyLock,
      idempotencyLockToken
    );

    try {
      const record = await this.readRecord(idempotencyKey);
      if (record && record.fingerprint !== options.requestFingerprint) {
        throw new StellarSubmissionError(
          'txIDEMPOTENCY_CONFLICT',
          'The client request token was already used for a different transaction.'
        );
      }
      if (record?.status === 'completed' && record.result) return record.result;
      if (record?.status === 'failed' && record.error) {
        throw new StellarSubmissionError(
          record.error.code,
          record.error.message,
          record.hash
        );
      }

      let transaction: StellarTransaction | undefined;
      let submittedResult: unknown;
      let submittedHash: string | undefined;
      let workingRecord = record;
      const reusingTransaction = Boolean(record?.transactionXdr);

      if (record?.transactionXdr) {
        transaction = TransactionBuilder.fromXDR(
          record.transactionXdr,
          this.networkPassphrase
        );
        const existing = await this.findTransaction(
          transaction.hash().toString('hex')
        );
        if (existing) {
          submittedResult = existing;
          submittedHash = existing.hash;
        } else if (record.status === 'submitted') {
          submittedHash = record.hash ?? transaction.hash().toString('hex');
        }
      }

      if (!submittedHash) {
        const sequenceLock = this.sequenceLockKey(options.sourceAccount);
        const sequenceLockToken = await this.acquireLock(sequenceLock);
        const stopSequenceRenewal = this.renewLock(
          sequenceLock,
          sequenceLockToken
        );
        try {
          for (let attempt = 0; attempt <= this.maxSequenceRetries; attempt++) {
            if (!transaction || attempt > 0) {
              const sequence = await this.allocateSequence(
                options.sourceAccount
              );
              transaction = await options.buildTransaction(sequence);
              workingRecord = {
                fingerprint: options.requestFingerprint,
                status: 'prepared',
                transactionXdr: transaction.toXDR(),
                hash: transaction.hash().toString('hex'),
              };
              await this.writeRecord(idempotencyKey, workingRecord);
            }

            try {
              submittedResult =
                await this.horizon.submitTransaction(transaction);
              submittedHash =
                (submittedResult as { hash?: string }).hash ??
                transaction.hash().toString('hex');
              workingRecord = {
                fingerprint: options.requestFingerprint,
                status: 'submitted',
                transactionXdr: transaction.toXDR(),
                hash: submittedHash,
              };
              await this.writeRecord(idempotencyKey, workingRecord);
              break;
            } catch (error) {
              if (this.isBadSequence(error) && reusingTransaction) {
                submittedHash = transaction.hash().toString('hex');
                workingRecord = {
                  ...record!,
                  status: 'submitted',
                  hash: submittedHash,
                };
                await this.writeRecord(idempotencyKey, workingRecord);
                break;
              }
              if (
                this.isBadSequence(error) &&
                attempt < this.maxSequenceRetries
              ) {
                await this.resyncSequence(options.sourceAccount);
                transaction = undefined;
                continue;
              }
              if (this.isAlreadySubmitted(error)) {
                submittedHash = transaction.hash().toString('hex');
                workingRecord = {
                  fingerprint: options.requestFingerprint,
                  status: 'submitted',
                  transactionXdr: transaction.toXDR(),
                  hash: submittedHash,
                };
                await this.writeRecord(idempotencyKey, workingRecord);
                break;
              }

              const classified = this.classifyError(error);
              if (classified.code !== 'txNETWORK_ERROR') {
                await this.writeRecord(idempotencyKey, {
                  ...workingRecord,
                  status: 'failed',
                  error: {
                    code: classified.code,
                    message: classified.message,
                  },
                });
              }
              throw classified;
            }
          }
        } finally {
          stopSequenceRenewal();
          await this.releaseLock(sequenceLock, sequenceLockToken);
        }
      }

      if (!transaction || !submittedHash) {
        throw new StellarSubmissionError(
          'txBAD_SEQ',
          'Sequence number remained out of sync after retrying.'
        );
      }

      return await this.monitorAndStore(
        idempotencyKey,
        workingRecord!,
        submittedHash,
        submittedResult,
        options
      );
    } finally {
      stopIdempotencyRenewal();
      await this.releaseLock(idempotencyLock, idempotencyLockToken);
    }
  }

  private validateRequest(options: SubmitTransactionOptions): void {
    if (!options.sourceAccount) {
      throw new Error('sourceAccount is required');
    }
    if (!options.clientRequestToken?.trim()) {
      throw new Error('clientRequestToken is required');
    }
    if (!options.requestFingerprint?.trim()) {
      throw new Error('requestFingerprint is required');
    }
    if (typeof options.buildTransaction !== 'function') {
      throw new Error('buildTransaction is required');
    }
  }

  private idempotencyKey(token: string): string {
    const digest = createHash('sha256').update(token).digest('hex');
    return `stellar:tx:idempotency:${digest}`;
  }

  private sequenceKey(account: string): string {
    return `stellar:tx:sequence:${account}`;
  }

  private sequenceLockKey(account: string): string {
    return `stellar:tx:sequence-lock:${account}`;
  }

  private async allocateSequence(account: string): Promise<bigint> {
    const key = this.sequenceKey(account);
    if ((await this.redis.get(key)) === null) {
      const ledgerSequence = await this.fetchSequence(account);
      await this.redis.eval(INITIALIZE_SEQUENCE_LUA, 1, key, ledgerSequence);
    }
    return BigInt(await this.redis.incr(key));
  }

  private async fetchSequence(account: string): Promise<string> {
    const loaded = await this.horizon.loadAccount(account);
    return loaded.sequence;
  }

  private async resyncSequence(account: string): Promise<void> {
    const sequence = await this.fetchSequence(account);
    await this.redis.set(this.sequenceKey(account), sequence);
  }

  private async acquireLock(key: string): Promise<string> {
    const token = randomUUID();
    const deadline = Date.now() + this.lockTtlSeconds * 1000;
    let delay = 10;

    while (Date.now() < deadline) {
      const acquired = await this.redis.set(
        key,
        token,
        'EX',
        this.lockTtlSeconds,
        'NX'
      );
      if (acquired === 'OK') return token;
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay = Math.min(delay * 2, 250);
    }

    throw new StellarSubmissionError(
      'txLOCK_TIMEOUT',
      `Timed out waiting for transaction lock ${key}.`
    );
  }

  private async releaseLock(key: string, token: string): Promise<void> {
    await this.redis.eval(RELEASE_LOCK_LUA, 1, key, token);
  }

  private renewLock(key: string, token: string): () => void {
    const timer = setInterval(
      () => {
        void this.redis
          .eval(RENEW_LOCK_LUA, 1, key, token, this.lockTtlSeconds)
          .then((renewed) => {
            if (Number(renewed) !== 1) {
              this.logger.error(`Lost Stellar transaction lock ${key}.`);
            }
          })
          .catch((error: unknown) => {
            this.logger.error(
              `Failed to renew Stellar transaction lock ${key}: ${this.errorMessage(error)}`
            );
          });
      },
      Math.max(1000, Math.floor((this.lockTtlSeconds * 1000) / 3))
    );
    timer.unref?.();
    return () => clearInterval(timer);
  }

  private async readRecord(key: string): Promise<PipelineRecord | null> {
    const value = await this.redis.get(key);
    if (!value) return null;
    return JSON.parse(value) as PipelineRecord;
  }

  private async writeRecord(
    key: string,
    record: PipelineRecord
  ): Promise<void> {
    await this.redis.set(key, JSON.stringify(record));
  }

  private async findTransaction(
    hash: string
  ): Promise<HorizonTransactionRecord | null> {
    try {
      return (await this.horizon.getTransaction(
        hash
      )) as HorizonTransactionRecord;
    } catch (error) {
      if (this.isNotFound(error)) return null;
      this.logger.warn(
        `Unable to look up Stellar transaction ${hash}: ${this.errorMessage(error)}`
      );
      return null;
    }
  }

  private async monitorAndStore(
    key: string,
    record: PipelineRecord,
    hash: string,
    initialResult: unknown,
    options?: SubmitTransactionOptions
  ): Promise<TransactionResult> {
    const waitForFeeBump =
      options?.buildFeeBumpTransaction !== undefined && !record.feeBumped;
    let status = await this.pollForStatus(
      hash,
      initialResult,
      waitForFeeBump
        ? Math.min(this.feeBumpTimeoutMs, this.submissionTimeoutMs)
        : this.submissionTimeoutMs
    );
    let feeBumped = false;

    if (
      status.status === 'pending' &&
      options?.buildFeeBumpTransaction &&
      !record.feeBumped
    ) {
      const inner = TransactionBuilder.fromXDR(
        record.transactionXdr!,
        this.networkPassphrase
      );
      const feeBump = await options.buildFeeBumpTransaction(
        inner as Transaction,
        options.feeBumpFee ?? '100'
      );
      await this.writeRecord(key, {
        ...record,
        status: 'prepared',
        transactionXdr: feeBump.toXDR(),
        hash: feeBump.hash().toString('hex'),
        feeBumped: true,
      });
      const submitted = await this.horizon.submitTransaction(feeBump);
      hash = submitted.hash ?? feeBump.hash().toString('hex');
      record = {
        ...record,
        status: 'submitted',
        transactionXdr: feeBump.toXDR(),
        hash,
        feeBumped: true,
      };
      await this.writeRecord(key, record);
      status = await this.pollForStatus(
        hash,
        submitted,
        this.submissionTimeoutMs
      );
      feeBumped = true;
    }

    for (
      let attempt = 0;
      status.status === 'pending' && attempt < this.maxResubmissions;
      attempt++
    ) {
      const transaction = TransactionBuilder.fromXDR(
        record.transactionXdr!,
        this.networkPassphrase
      );
      try {
        const resubmitted = await this.horizon.submitTransaction(transaction);
        status = await this.pollForStatus(
          hash,
          resubmitted,
          this.submissionTimeoutMs
        );
      } catch (error) {
        const classified = this.classifyError(error);
        if (
          classified.code !== 'txBAD_SEQ' &&
          classified.code !== 'txNETWORK_ERROR' &&
          !this.isAlreadySubmitted(error)
        ) {
          throw classified;
        }
        this.logger.warn(
          `Resubmission of Stellar transaction ${hash} was not accepted: ${this.errorMessage(error)}`
        );
        status = await this.pollForStatus(
          hash,
          undefined,
          this.submissionTimeoutMs
        );
      }
    }

    if (status.status === 'pending') {
      throw new StellarSubmissionError(
        'txTIMEOUT',
        `Transaction ${hash} was not confirmed before the timeout.`,
        hash
      );
    }
    if (status.status === 'failed') {
      const failure = new StellarSubmissionError(
        'txFAILED',
        `Transaction ${hash} failed on Stellar.`,
        hash
      );
      await this.writeRecord(key, {
        ...record,
        status: 'failed',
        error: { code: failure.code, message: failure.message },
      });
      throw failure;
    }

    const result: TransactionResult = {
      hash,
      status: 'completed',
      transaction: status.transaction,
      ...(feeBumped ? { feeBumped: true } : {}),
    };
    await this.writeRecord(key, {
      ...record,
      status: 'completed',
      hash,
      result,
    });
    return result;
  }

  private async pollForStatus(
    hash: string,
    initialResult: unknown,
    timeoutMs: number
  ): Promise<{
    status: TransactionStatus;
    transaction: unknown;
  }> {
    const startedAt = Date.now();
    let interval = this.pollIntervalMs;
    let transaction = initialResult;

    while (Date.now() - startedAt < timeoutMs) {
      try {
        transaction = await this.horizon.getTransaction(hash);
        const result = this.transactionStatus(transaction);
        if (result !== 'pending') {
          return { status: result, transaction };
        }
      } catch (error) {
        if (!this.isNotFound(error)) {
          this.logger.warn(
            `Stellar transaction status check failed for ${hash}: ${this.errorMessage(error)}`
          );
        }
      }
      await this.wait(Math.min(interval, timeoutMs - (Date.now() - startedAt)));
      interval = Math.min(interval * 2, this.maxPollIntervalMs);
    }

    return { status: 'pending', transaction };
  }

  private transactionStatus(value: unknown): TransactionStatus {
    if (!value || typeof value !== 'object') return 'pending';
    const transaction = value as { successful?: boolean; status?: string };
    if (transaction.successful === true) return 'completed';
    if (transaction.successful === false || transaction.status === 'failed') {
      return 'failed';
    }
    return 'pending';
  }

  private classifyError(error: unknown): StellarSubmissionError {
    const details = error as {
      response?: {
        data?: { extras?: { result_codes?: { transaction?: string } } };
        status?: number;
      };
      message?: string;
    };
    const rawCode = details?.response?.data?.extras?.result_codes?.transaction;
    const message = this.errorMessage(error);
    const searchable = `${rawCode ?? ''} ${message}`.toLowerCase();
    let code = 'txFAILED';

    if (/insufficient_balance|underfunded/.test(searchable)) {
      code = 'txINSUFFICIENT_BALANCE';
    } else if (/bad_seq|seq_no_too_low|sequence/.test(searchable)) {
      code = 'txBAD_SEQ';
    } else if (
      /timeout|timed out|econnreset|network|fetch failed/.test(searchable)
    ) {
      code = 'txNETWORK_ERROR';
    }

    return new StellarSubmissionError(code, message);
  }

  private isBadSequence(error: unknown): boolean {
    return this.classifyError(error).code === 'txBAD_SEQ';
  }

  private isAlreadySubmitted(error: unknown): boolean {
    return /already (?:exists|submitted)|duplicate transaction/i.test(
      this.errorMessage(error)
    );
  }

  private isNotFound(error: unknown): boolean {
    const candidate = error as {
      response?: { status?: number };
      status?: number;
    };
    return (
      candidate?.response?.status === 404 ||
      candidate?.status === 404 ||
      /not found/i.test(this.errorMessage(error))
    );
  }

  private errorMessage(error: unknown): string {
    if (error instanceof Error) return error.message;
    return String(error);
  }

  private wait(milliseconds: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }
}
