export type SubscriptionTier = 'FREE' | 'PRO' | 'ENTERPRISE';

export interface UserQuota {
  tier: SubscriptionTier;
  buildMinutesLimit: number;
  buildMinutesUsed: number;
  storageMbLimit: number;
  storageMbUsed: number;
}

export class QuotaEngine {
  private static quotas: Map<string, UserQuota> = new Map();

  /**
   * Initialize or retrieve user quota profile
   */
  public static getUserQuota(userId: string): UserQuota {
    if (!this.quotas.has(userId)) {
      // Default to FREE tier
      this.quotas.set(userId, {
        tier: 'FREE',
        buildMinutesLimit: 100,
        buildMinutesUsed: 0,
        storageMbLimit: 1024, // 1 GB
        storageMbUsed: 0,
      });
    }
    return this.quotas.get(userId)!;
  }

  /**
   * Track resource consumption. Throws error if quota exceeded.
   */
  public static consumeBuildSeconds(
    userId: string,
    seconds: number
  ): { allowed: boolean; warning?: string } {
    const quota = this.getUserQuota(userId);
    const minutesToAdd = seconds / 60;
    quota.buildMinutesUsed += minutesToAdd;

    const usageRatio = quota.buildMinutesUsed / quota.buildMinutesLimit;

    if (
      quota.tier === 'FREE' &&
      quota.buildMinutesUsed > quota.buildMinutesLimit
    ) {
      throw new Error(
        `[QuotaExceeded] Build minutes quota exhausted for user ${userId}. Please upgrade to Pro.`
      );
    }

    if (usageRatio >= 0.9 && usageRatio < 1.0) {
      return {
        allowed: true,
        warning: `Warning: You have reached ${(usageRatio * 100).toFixed(0)}% of your build minutes quota.`,
      };
    }

    return { allowed: true };
  }

  /**
   * Upgrade user subscription tier (triggered by Stripe or Stellar crypto payment)
   */
  public static upgradeTier(userId: string, tier: SubscriptionTier): void {
    const quota = this.getUserQuota(userId);
    quota.tier = tier;

    if (tier === 'PRO') {
      quota.buildMinutesLimit = 1000;
      quota.storageMbLimit = 10240; // 10 GB
    } else if (tier === 'ENTERPRISE') {
      quota.buildMinutesLimit = 999999; // Unlimited
      quota.storageMbLimit = 102400; // 100 GB
    }

    console.log(
      `[QuotaEngine] Successfully upgraded user ${userId} to tier: ${tier}`
    );
  }

  /**
   * Process Stellar payment memo matching for native XLM/USDC top-ups or subscriptions
   */
  public static processStellarPaymentMemo(
    memoText: string,
    paidAmountXlm: number
  ): { success: boolean; userId?: string } {
    // Expected memo format: "SUB_PRO_<userId>" or "TOPUP_<userId>"
    if (memoText.startsWith('SUB_PRO_')) {
      const userId = memoText.replace('SUB_PRO_', '');
      if (paidAmountXlm >= 10) {
        // e.g. 10 XLM for Pro
        this.upgradeTier(userId, 'PRO');
        return { success: true, userId };
      }
    }
    return { success: false };
  }
}
