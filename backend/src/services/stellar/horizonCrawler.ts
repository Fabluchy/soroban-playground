import axios from 'axios';
import { Redis } from 'ioredis';

export interface StellarNode {
  url: string;
  type: 'horizon' | 'rpc';
  latestLedger: number;
  latencyMs: number;
  isHealthy: boolean;
  lastChecked: number;
}

const REDIS_NODES_KEY = 'stellar:active_nodes';
const LEDGER_DESYNC_THRESHOLD = 3; // Max allowable ledger lag behind consensus

// Initial public seed endpoints
const SEED_NODES = [
  { url: 'https://horizon-testnet.stellar.org', type: 'horizon' as const },
  { url: 'https://soroban-testnet.stellar.org', type: 'rpc' as const },
  { url: 'https://horizon.stellar.org', type: 'horizon' as const },
  { url: 'https://rpc-mainnet.stellar.org', type: 'rpc' as const },
];

export class HorizonCrawlerService {
  private redis: Redis;
  private isRunning: boolean = false;
  private crawlerIntervalMs: number = 30000; // Crawl every 30 seconds

  constructor(redisClient: Redis) {
    this.redis = redisClient;
  }

  /**
   * Start background discovery and health benchmarking loop
   */
  public startCrawler(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    console.log('[HorizonCrawler] Background node discovery crawler started.');

    // Initial crawl run
    this.runCrawlCycle();

    // Schedule background loop
    setInterval(() => {
      if (this.isRunning) {
        this.runCrawlCycle().catch((err) =>
          console.error('[HorizonCrawler] Crawl cycle error:', err.message)
        );
      }
    }, this.crawlerIntervalMs);
  }

  public stopCrawler(): void {
    this.isRunning = false;
    console.log('[HorizonCrawler] Background crawler stopped.');
  }

  /**
   * Main crawl cycle: Validate consensus ledger, benchmark endpoints, update Redis registry
   */
  public async runCrawlCycle(): Promise<StellarNode[]> {
    // 1. Determine consensus ledger height across primary nodes
    const consensusLedger = await this.getConsensusLedgerHeight();

    // 2. Validate and benchmark candidate nodes
    const candidateNodes = [...SEED_NODES];
    const validatedNodes: StellarNode[] = [];

    for (const node of candidateNodes) {
      const health = await this.benchmarkNode(
        node.url,
        node.type,
        consensusLedger
      );
      if (health.isHealthy) {
        validatedNodes.push(health);
      }
    }

    // 3. Sort nodes by latency ascending (fastest, most reliable first)
    validatedNodes.sort((a, b) => a.latencyMs - b.latencyMs);

    // 4. Update Redis registry
    if (validatedNodes.length > 0) {
      await this.redis.set(REDIS_NODES_KEY, JSON.stringify(validatedNodes));
    }

    return validatedNodes;
  }

  /**
   * Fetches latest ledger height across seed nodes to calculate consensus height
   */
  private async getConsensusLedgerHeight(): Promise<number> {
    const ledgerHeights: number[] = [];

    for (const seed of SEED_NODES) {
      try {
        if (seed.type === 'horizon') {
          const res = await axios.get(
            `${seed.url}/ledgers?order=desc&limit=1`,
            { timeout: 3000 }
          );
          const sequence = res.data._embedded.records[0].sequence;
          ledgerHeights.push(sequence);
        }
      } catch (err) {
        // Skip unresponsive consensus seeds
      }
    }

    if (ledgerHeights.length === 0) return 0;
    // Median or maximum ledger sequence as consensus baseline
    return Math.max(...ledgerHeights);
  }

  /**
   * Benchmark latency and check synchronization state of an individual endpoint
   */
  public async benchmarkNode(
    url: string,
    type: 'horizon' | 'rpc',
    consensusLedger: number
  ): Promise<StellarNode> {
    const startTime = Date.now();
    try {
      let latestLedger = 0;

      if (type === 'horizon') {
        const res = await axios.get(`${url}/ledgers?order=desc&limit=1`, {
          timeout: 4000,
        });
        latestLedger = res.data._embedded.records[0].sequence;
      } else {
        const res = await axios.post(
          url,
          { jsonrpc: '2.0', id: 1, method: 'getLatestLedger' },
          { timeout: 4000 }
        );
        latestLedger = res.data.result.sequence;
      }

      const latencyMs = Date.now() - startTime;

      // Node is healthy if within allowable ledger synchronization threshold
      const isHealthy =
        consensusLedger === 0 ||
        consensusLedger - latestLedger <= LEDGER_DESYNC_THRESHOLD;

      return {
        url,
        type,
        latestLedger,
        latencyMs,
        isHealthy,
        lastChecked: Date.now(),
      };
    } catch (error) {
      return {
        url,
        type,
        latestLedger: 0,
        latencyMs: 9999,
        isHealthy: false,
        lastChecked: Date.now(),
      };
    }
  }

  /**
   * Get list of healthy prioritized failover nodes from Redis
   */
  public async getHealthyNodes(): Promise<StellarNode[]> {
    const cached = await this.redis.get(REDIS_NODES_KEY);
    return cached ? JSON.parse(cached) : [];
  }
}
