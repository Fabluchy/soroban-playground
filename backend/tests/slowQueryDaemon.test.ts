import { SlowQueryAnalyzerDaemon } from '../db/analyzer/slowQueryDaemon';

describe('SlowQueryAnalyzerDaemon (#1788)', () => {
  let mockPool: any;
  let daemon: SlowQueryAnalyzerDaemon;

  beforeEach(() => {
    mockPool = {
      connect: jest.fn().mockResolvedValue({
        query: jest.fn().mockImplementation(async (sql: string) => {
          if (sql.includes('pg_stat_statements')) {
            return {
              rows: [
                {
                  query: 'SELECT * FROM contracts WHERE status = $1',
                  calls: 540,
                  totalTimeMs: 150000,
                  meanTimeMs: 277.7,
                  rows: 1200,
                },
              ],
            };
          }
          if (sql.includes('pg_stat_user_tables')) {
            return {
              rows: [
                {
                  tableName: 'public.transactions',
                  seqScans: 4500,
                  idxScans: 120,
                },
              ],
            };
          }
          return { rows: [] };
        }),
        release: jest.fn(),
      }),
    };

    daemon = new SlowQueryAnalyzerDaemon(mockPool);
  });

  afterEach(() => {
    daemon.stopDaemon();
  });

  it('should identify slow queries exceeding threshold and generate index recommendations', async () => {
    const result = await daemon.runAnalysisCycle();

    expect(result.slowQueries.length).toBe(1);
    expect(result.slowQueries[0].meanTimeMs).toBeGreaterThan(200);
    expect(result.recommendations.length).toBe(1);
    expect(result.recommendations[0].suggestedSql).toContain('CONCURRENTLY');
  });

  it('should execute non-blocking REINDEX TABLE CONCURRENTLY', async () => {
    const mockClient = {
      query: jest.fn().mockResolvedValue({}),
      release: jest.fn(),
    };
    mockPool.connect.mockResolvedValue(mockClient);

    await daemon.reindexTableConcurrently('public.contracts');
    expect(mockClient.query).toHaveBeenCalledWith(
      'REINDEX TABLE CONCURRENTLY public.contracts;'
    );
  });
});
