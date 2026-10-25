import { Redis } from 'ioredis';
import * as crypto from 'crypto';

export interface RedlockOptions {
  retryCount?: number;
  retryDelayMinMs?: number;
  retryDelayMaxMs?: number;
  driftFactor?: number;
}

export interface Lock {
  resource: string;
  value: string;
  validityTime: number;
}

export class DistributedLockManager {
  private clients: Redis[];
  private quorum: number;
  private options: Required<RedlockOptions>;

  constructor(clients: Redis[], options?: RedlockOptions) {
    if (!clients || clients.length === 0) {
      throw new Error('Redlock requires at least one Redis client instance.');
    }
    this.clients = clients;
    this.quorum = Math.floor(clients.length / 2) + 1;
    this.options = {
      retryCount: options?.retryCount ?? 3,
      retryDelayMinMs: options?.retryDelayMinMs ?? 200,
      retryDelayMaxMs: options?.retryDelayMaxMs ?? 400,
      driftFactor: options?.driftFactor ?? 0.01,
    };
  }

  /**
   * Acquire a distributed lock across Redis instances with quorum consensus
   */
  public async acquire(resource: string, ttlMs: number): Promise<Lock> {
    const val = crypto.randomBytes(16).toString('hex');
    let attempts = 0;

    while (attempts <= this.options.retryCount) {
      attempts++;
      const startTime = Date.now();
      let successCount = 0;

      // Try acquiring lock on all Redis client nodes in parallel
      const acquirePromises = this.clients.map(async (client) => {
        try {
          const res = await client.set(resource, val, 'PX', ttlMs, 'NX');
          return res === 'OK';
        } catch (err) {
          return false;
        }
      });

      const results = await Promise.all(acquirePromises);
      successCount = results.filter(Boolean).length;

      const elapsed = Date.now() - startTime;
      const validityTime =
        ttlMs - elapsed - Math.floor(ttlMs * this.options.driftFactor) - 50;

      // Check quorum and validity time
      if (successCount >= this.quorum && validityTime > 0) {
        return { resource, value: val, validityTime };
      } else {
        // Release any partial locks acquired
        await this.releaseLockInstances(resource, val);

        if (attempts > this.options.retryCount) {
          throw new Error(
            `Failed to acquire distributed lock for resource: "${resource}" after ${attempts} attempts.`
          );
        }

        // Apply randomized jitter backoff to prevent lock starvation
        const jitter =
          Math.random() *
            (this.options.retryDelayMaxMs - this.options.retryDelayMinMs) +
          this.options.retryDelayMinMs;
        await new Promise((resolve) => setTimeout(resolve, jitter));
      }
    }

    throw new Error(`Failed to acquire lock for resource: "${resource}"`);
  }

  /**
   * Release a distributed lock across all nodes safely using Lua script (ensures value match)
   */
  public async release(lock: Lock): Promise<void> {
    await this.releaseLockInstances(lock.resource, lock.value);
  }

  private async releaseLockInstances(
    resource: string,
    value: string
  ): Promise<void> {
    const luaScript = `
      if redis.call("get", KEYS[1]) == ARGV[1] then
        return redis.call("del", KEYS[1])
      else
        return 0
      end
    `;

    await Promise.all(
      this.clients.map(async (client) => {
        try {
          await client.eval(luaScript, 1, resource, value);
        } catch (err) {
          // Ignore individual node disconnects during release
        }
      })
    );
  }

  /**
   * RAII-style async wrapper ensuring automatic lock release in finally blocks,
   * with automatic heartbeat renewal and long-operation monitoring (> 10s alert).
   */
  public async using<T>(
    resource: string,
    ttlMs: number,
    fn: (lock: Lock) => Promise<T>
  ): Promise<T> {
    const lock = await this.acquire(resource, ttlMs);
    const startTime = Date.now();
    let isReleased = false;

    // Automatic heartbeat renewal timer (renews every TTL / 3)
    const renewalIntervalMs = Math.floor(ttlMs / 3);
    const renewalTimer = setInterval(async () => {
      if (isReleased) return;
      try {
        const extendScript = `
          if redis.call("get", KEYS[1]) == ARGV[1] then
            return redis.call("pexpire", KEYS[1], ARGV[2])
          else
            return 0
          end
        `;
        await Promise.all(
          this.clients.map((client) =>
            client.eval(extendScript, 1, resource, lock.value, ttlMs)
          )
        );
      } catch (err) {
        console.warn(
          `[Redlock] Failed to auto-renew lock for resource: ${resource}`,
          err
        );
      }
    }, renewalIntervalMs);

    try {
      const result = await fn(lock);
      const heldDuration = Date.now() - startTime;
      if (heldDuration > 10000) {
        console.warn(
          `[Redlock Alert] Resource "${resource}" held lock for excessively long duration: ${heldDuration}ms`
        );
      }
      return result;
    } finally {
      isReleased = true;
      clearInterval(renewalTimer);
      await this.release(lock).catch((err) =>
        console.error(
          `[Redlock] Error releasing lock in finally block for ${resource}:`,
          err
        )
      );
    }
  }
}
