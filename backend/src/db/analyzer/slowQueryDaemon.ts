import { Pool } from 'pg';

export interface SlowQueryRecord {
  query: string;
  calls: number;
  totalTimeMs: number;
  meanTimeMs: number;
  rows: number;
}

export interface IndexRecommendation {
  tableName: string;
  columnName: string;
  reason: string;
  suggestedSql: string;
}

export class SlowQueryAnalyzerDaemon {
  private pool: Pool;
  private isRunning: boolean = false;
  private pollIntervalMs: number = 60000; // Poll every 60 seconds
  private slowQueryThresholdMs: number = 200;

  constructor(pgPool: Pool) {
    this.pool = pgPool;
  }

  /**
   * Start background daemon loop
   */
  public startDaemon(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    console.log(
      '[SlowQueryDaemon] Database analyzer and index rebuilder daemon started.'
    );

    this.runAnalysisCycle().catch((err) =>
      console.error('[SlowQueryDaemon] Error in analysis cycle:', err.message)
    );

    setInterval(() => {
      if (this.isRunning) {
        this.runAnalysisCycle().catch((err) =>
          console.error(
            '[SlowQueryDaemon] Error in analysis cycle:',
            err.message
          )
        );
      }
    }, this.pollIntervalMs);
  }

  public stopDaemon(): void {
    this.isRunning = false;
    console.log('[SlowQueryDaemon] Daemon stopped.');
  }

  /**
   * Main analysis cycle: Analyze pg_stat_statements, check index bloat, recommend optimizations
   */
  public async runAnalysisCycle(): Promise<{
    slowQueries: SlowQueryRecord[];
    recommendations: IndexRecommendation[];
  }> {
    const client = await this.pool.connect();
    try {
      // 1. Query pg_stat_statements for slow queries (> 200ms mean time)
      const slowQueryRes = await client.query(
        `
        SELECT 
          query,
          calls,
          total_exec_time AS "totalTimeMs",
          mean_exec_time AS "meanTimeMs",
          rows
        FROM pg_stat_statements
        WHERE mean_exec_time > $1
        ORDER BY mean_exec_time DESC
        LIMIT 10;
      `,
        [this.slowQueryThresholdMs]
      );

      const slowQueries: SlowQueryRecord[] = slowQueryRes.rows;

      // Log alerts for queries causing high latency
      for (const q of slowQueries) {
        if (q.meanTimeMs > 1000) {
          console.warn(
            `[SlowQueryAlert] Critical slow query detected (mean: ${q.meanTimeMs.toFixed(2)}ms): ${q.query.substring(0, 100)}...`
          );
        }
      }

      // 2. Identify tables with high sequential scans lacking optimal indexes
      const seqScanRes = await client.query(`
        SELECT
          schemaname || '.' || relname AS "tableName",
          seq_scan AS "seqScans",
          idx_scan AS "idxScans"
        FROM pg_stat_user_tables
        WHERE seq_scan > 1000 AND (idx_scan IS NULL OR idx_scan < seq_scan)
        ORDER BY seq_scan DESC
        LIMIT 5;
      `);

      const recommendations: IndexRecommendation[] = seqScanRes.rows.map(
        (row) => ({
          tableName: row.tableName,
          columnName: 'id_or_frequent_filter_col',
          reason: `High sequential scan count (${row.seqScanRes || row.seqScans}) relative to index scans.`,
          suggestedSql: `CREATE INDEX CONCURRENTLY idx_${row.tableName.replace('.', '_')}_optimized ON ${row.tableName} (frequent_column);`,
        })
      );

      return { slowQueries, recommendations };
    } finally {
      client.release();
    }
  }

  /**
   * Execute non-blocking REINDEX TABLE CONCURRENTLY
   */
  public async reindexTableConcurrently(tableName: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      console.log(
        `[SlowQueryDaemon] Starting non-blocking REINDEX TABLE CONCURRENTLY for ${tableName}...`
      );
      // Note: REINDEX CONCURRENTLY cannot be executed inside a transaction block
      await client.query(`REINDEX TABLE CONCURRENTLY ${tableName};`);
      console.log(
        `[SlowQueryDaemon] Successfully reindexed ${tableName} concurrently.`
      );
    } catch (err: any) {
      console.error(
        `[SlowQueryDaemon] Failed to reindex ${tableName}: ${err.message}`
      );
      throw err;
    } finally {
      client.release();
    }
  }
}
