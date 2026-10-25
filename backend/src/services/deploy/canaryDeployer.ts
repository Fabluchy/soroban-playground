export interface DeploymentConfig {
  version: string;
  stages: number[]; // e.g., [5, 25, 50, 100]
  evaluationIntervalMs: number;
}

export interface WorkerMetrics {
  failureRate: number; // percentage (0 - 100)
  meanLatencyMs: number;
  cpuDiscrepancyCount: number;
}

export class CanaryDeployer {
  private currentStageIndex: number = 0;
  private currentTrafficPercent: number = 0;
  private isRollingBack: boolean = false;
  private config: DeploymentConfig;

  constructor(config?: Partial<DeploymentConfig>) {
    this.config = {
      version: config?.version ?? 'v2.0.0-canary',
      stages: config?.stages ?? [5, 25, 50, 100],
      evaluationIntervalMs: config?.evaluationIntervalMs ?? 60000, // 1 minute per stage
    };
  }

  /**
   * Initialize canary rollout at 5% traffic
   */
  public startCanary(): void {
    this.currentStageIndex = 0;
    this.currentTrafficPercent = this.config.stages[0];
    this.isRollingBack = false;
    console.log(
      `[CanaryDeployer] Started canary rollout for version ${this.config.version} at ${this.currentTrafficPercent}% traffic.`
    );
  }

  /**
   * Evaluate canary metrics against baseline. If failure rate exceeds baseline by > 1%, trigger instant rollback.
   */
  public evaluateMetrics(
    canaryMetrics: WorkerMetrics,
    baselineMetrics: WorkerMetrics
  ): boolean {
    if (this.isRollingBack) return false;

    const errorRateDiff =
      canaryMetrics.failureRate - baselineMetrics.failureRate;

    // Trigger instant automated rollback if canary error rate exceeds baseline by > 1%
    if (errorRateDiff > 1.0 || canaryMetrics.cpuDiscrepancyCount > 0) {
      this.rollback(
        `Anomaly detected: Error rate diff is +${errorRateDiff.toFixed(2)}% or CPU instruction discrepancy found.`
      );
      return false;
    }

    // Otherwise, advance rollout stage if healthy
    this.advanceStage();
    return true;
  }

  /**
   * Progressively advance traffic percentage to next stage
   */
  private advanceStage(): void {
    if (this.currentStageIndex < this.config.stages.length - 1) {
      this.currentStageIndex++;
      this.currentTrafficPercent = this.config.stages[this.currentStageIndex];
      console.log(
        `[CanaryDeployer] Stage promoted! Canary traffic increased to ${this.currentTrafficPercent}%.`
      );
    } else {
      console.log(
        `[CanaryDeployer] Canary rollout successfully completed at 100% traffic for version ${this.config.version}!`
      );
    }
  }

  /**
   * Trigger instant automated rollback to 0% canary traffic (baseline)
   */
  public rollback(reason: string): void {
    this.isRollingBack = true;
    this.currentTrafficPercent = 0;
    console.warn(
      `[CanaryDeployer ROLLBACK] Instant rollback triggered for version ${this.config.version}. Reason: ${reason}`
    );
  }

  public getTrafficPercent(): number {
    return this.currentTrafficPercent;
  }

  public getIsRollingBack(): boolean {
    return this.isRollingBack;
  }
}
