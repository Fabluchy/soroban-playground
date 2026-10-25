//! # RWA Tranche — #1804 [SC-08]
//!
//! Structured finance Real-World Asset tokenization contract with:
//! - Senior (fixed yield, priority payout) and Junior (high yield, first-loss) tranches
//! - ERC-4626 style vault share tokens for pooled RWA debt obligations
//! - Waterfall cashflow: Senior Interest → Senior Principal → Junior Surplus
//! - First-loss capital protection: Junior absorbs defaults before Senior
//! - Compliance whitelist (ERC-3643 / SEP-08 style) for accredited investors
//! - Automated NAV updates via certified auditor oracle

#![no_std]

mod storage;
mod types;

#[cfg(test)]
mod test;

use soroban_sdk::{contract, contractimpl, symbol_short, Address, Env};
use storage::{
    add_investor_slot, get_pool, get_position, is_initialized, is_whitelisted, remove_position,
    save_pool, save_position, set_initialized, set_whitelist,
};
use types::{Error, PoolState, Position, TrancheClass};

/// NAV precision scaler (1 share = 1_000_000 NAV units at par).
const NAV_SCALE: i128 = 1_000_000;
/// Basis points denominator.
const BPS: i128 = 10_000;

#[contract]
pub struct RwaTranche;

#[contractimpl]
impl RwaTranche {
    // ── Initialisation ────────────────────────────────────────────────────────

    /// Create the RWA tranche pool.
    ///
    /// * `admin`                – Pool issuer / admin.
    /// * `auditor`              – Address authorised to push NAV updates.
    /// * `senior_yield_bps`     – Fixed annual yield for senior tranche (bps).
    /// * `junior_sub_ratio_bps` – Max % of pool size junior absorbs as first
    ///                            loss buffer (bps, e.g. 2000 = 20%).
    pub fn initialize(
        env: Env,
        admin: Address,
        auditor: Address,
        senior_yield_bps: u32,
        junior_sub_ratio_bps: u32,
    ) -> Result<(), Error> {
        if is_initialized(&env) {
            return Err(Error::AlreadyInitialized);
        }
        admin.require_auth();
        if senior_yield_bps == 0 || senior_yield_bps > 10_000 {
            return Err(Error::InvalidYield);
        }
        if junior_sub_ratio_bps == 0 || junior_sub_ratio_bps > 10_000 {
            return Err(Error::InvalidSubRatio);
        }

        let pool = PoolState {
            admin: admin.clone(),
            auditor: auditor.clone(),
            senior_yield_bps,
            junior_sub_ratio_bps,
            senior_principal: 0,
            junior_principal: 0,
            senior_interest_paid: 0,
            senior_principal_paid: 0,
            junior_surplus_paid: 0,
            junior_write_down: 0,
            nav_per_share: NAV_SCALE,
            paused: false,
        };
        save_pool(&env, &pool);
        set_initialized(&env);
        env.events()
            .publish((symbol_short!("init"),), (senior_yield_bps, junior_sub_ratio_bps));
        Ok(())
    }

    // ── Compliance whitelist ──────────────────────────────────────────────────

    /// Admin-only: add or remove an investor from the accredited investor whitelist.
    pub fn set_whitelist(
        env: Env,
        admin: Address,
        investor: Address,
        allowed: bool,
    ) -> Result<(), Error> {
        admin.require_auth();
        let pool = get_pool(&env)?;
        if pool.admin != admin {
            return Err(Error::Unauthorized);
        }
        set_whitelist(&env, &investor, allowed);
        env.events()
            .publish((symbol_short!("whitelist"),), (&investor, allowed));
        Ok(())
    }

    pub fn is_whitelisted(env: Env, investor: Address) -> bool {
        is_whitelisted(&env, &investor)
    }

    // ── Deposits ──────────────────────────────────────────────────────────────

    /// Deposit into a tranche.  Only whitelisted investors may participate.
    ///
    /// Returns the number of vault shares minted.
    ///
    /// Share price at par (1 share = NAV_SCALE units), post-NAV updates use
    /// the current NAV to price new deposits.
    pub fn deposit(
        env: Env,
        investor: Address,
        tranche: TrancheClass,
        amount: i128,
    ) -> Result<i128, Error> {
        Self::require_active(&env)?;
        investor.require_auth();
        if !is_whitelisted(&env, &investor) {
            return Err(Error::NotWhitelisted);
        }
        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }

        let mut pool = get_pool(&env)?;

        // Shares = amount * NAV_SCALE / nav_per_share
        let shares = amount
            .checked_mul(NAV_SCALE)
            .ok_or(Error::ArithmeticOverflow)?
            .checked_div(pool.nav_per_share)
            .ok_or(Error::ArithmeticOverflow)?;

        match tranche {
            TrancheClass::Senior => {
                pool.senior_principal = pool
                    .senior_principal
                    .checked_add(amount)
                    .ok_or(Error::ArithmeticOverflow)?;
            }
            TrancheClass::Junior => {
                pool.junior_principal = pool
                    .junior_principal
                    .checked_add(amount)
                    .ok_or(Error::ArithmeticOverflow)?;
            }
        }

        // Upsert position
        let existing = get_position(&env, &investor, tranche);
        let pos = match existing {
            Some(mut p) => {
                p.shares = p
                    .shares
                    .checked_add(shares)
                    .ok_or(Error::ArithmeticOverflow)?;
                p.principal = p
                    .principal
                    .checked_add(amount)
                    .ok_or(Error::ArithmeticOverflow)?;
                p
            }
            None => {
                add_investor_slot(&env, &investor);
                Position {
                    investor: investor.clone(),
                    tranche,
                    shares,
                    principal: amount,
                }
            }
        };
        save_position(&env, &pos);
        save_pool(&env, &pool);

        env.events()
            .publish((symbol_short!("deposit"),), (&investor, tranche, amount, shares));
        Ok(shares)
    }

    // ── Repayment waterfall ───────────────────────────────────────────────────

    /// Route an incoming repayment through the priority waterfall:
    ///   1. Senior Interest (fixed yield on outstanding principal)
    ///   2. Senior Principal (return original principal)
    ///   3. Junior Surplus (remaining after senior is whole)
    ///
    /// If the repayment is insufficient to cover senior interest, the
    /// shortfall is treated as a loss.  Junior absorbs losses first up to
    /// `junior_sub_ratio_bps` × total pool. Beyond that threshold, senior
    /// begins to suffer losses.
    ///
    /// * `repayment` – Gross payment received from the RWA obligor.
    /// * `accrued_interest` – Amount of `repayment` attributable to interest.
    pub fn distribute_repayment(
        env: Env,
        admin: Address,
        repayment: i128,
        accrued_interest: i128,
    ) -> Result<(), Error> {
        Self::require_active(&env)?;
        admin.require_auth();
        let mut pool = get_pool(&env)?;
        if pool.admin != admin {
            return Err(Error::Unauthorized);
        }
        if repayment <= 0 {
            return Err(Error::ZeroRepayment);
        }

        let mut remaining = repayment;

        // ── Step 1: Senior Interest ───────────────────────────────────────────
        let senior_interest_due = accrued_interest
            .checked_mul(pool.senior_principal)
            .ok_or(Error::ArithmeticOverflow)?
            .checked_div(
                pool.senior_principal
                    .checked_add(pool.junior_principal)
                    .unwrap_or(1)
                    .max(1),
            )
            .unwrap_or(0);

        let senior_interest_paid = senior_interest_due.min(remaining);
        remaining -= senior_interest_paid;
        pool.senior_interest_paid = pool
            .senior_interest_paid
            .checked_add(senior_interest_paid)
            .ok_or(Error::ArithmeticOverflow)?;

        // If senior interest was not fully covered, compute shortfall
        let interest_shortfall = senior_interest_due - senior_interest_paid;
        if interest_shortfall > 0 {
            // Junior absorbs interest shortfall first
            let total_pool = pool
                .senior_principal
                .checked_add(pool.junior_principal)
                .unwrap_or(1)
                .max(1);
            let junior_buffer = total_pool
                .checked_mul(pool.junior_sub_ratio_bps as i128)
                .ok_or(Error::ArithmeticOverflow)?
                .checked_div(BPS)
                .unwrap_or(0);
            let available_junior_buffer = junior_buffer - pool.junior_write_down;

            if interest_shortfall <= available_junior_buffer {
                pool.junior_write_down = pool
                    .junior_write_down
                    .checked_add(interest_shortfall)
                    .ok_or(Error::ArithmeticOverflow)?;
            } else {
                // Junior buffer exhausted – senior suffers the excess loss
                pool.junior_write_down =
                    pool.junior_write_down.checked_add(available_junior_buffer).unwrap_or(i128::MAX);
            }
        }

        // ── Step 2: Senior Principal ──────────────────────────────────────────
        let senior_principal_outstanding =
            (pool.senior_principal - pool.senior_principal_paid).max(0);
        let senior_principal_repay = senior_principal_outstanding.min(remaining);
        remaining -= senior_principal_repay;
        pool.senior_principal_paid = pool
            .senior_principal_paid
            .checked_add(senior_principal_repay)
            .ok_or(Error::ArithmeticOverflow)?;

        // ── Step 3: Junior Surplus ────────────────────────────────────────────
        if remaining > 0 {
            pool.junior_surplus_paid = pool
                .junior_surplus_paid
                .checked_add(remaining)
                .ok_or(Error::ArithmeticOverflow)?;
        }

        // Recompute NAV per share
        let total_shares = pool
            .senior_principal
            .checked_add(pool.junior_principal)
            .unwrap_or(1)
            .max(1);
        let total_assets = pool
            .senior_principal
            .checked_add(pool.junior_principal)
            .unwrap_or(0)
            .checked_add(pool.senior_interest_paid)
            .unwrap_or(0)
            .checked_add(pool.junior_surplus_paid)
            .unwrap_or(0)
            .saturating_sub(pool.junior_write_down);
        pool.nav_per_share = total_assets
            .checked_mul(NAV_SCALE)
            .unwrap_or(NAV_SCALE)
            .checked_div(total_shares)
            .unwrap_or(NAV_SCALE);

        save_pool(&env, &pool);
        env.events().publish(
            (symbol_short!("distrib"),),
            (
                senior_interest_paid,
                senior_principal_repay,
                remaining,
            ),
        );
        Ok(())
    }

    // ── Default / write-down ──────────────────────────────────────────────────

    /// Record a principal default (write-down).  Junior absorbs first; if
    /// junior buffer exhausted, flag the pool.
    pub fn record_default(
        env: Env,
        admin: Address,
        loss_amount: i128,
    ) -> Result<(), Error> {
        Self::require_active(&env)?;
        admin.require_auth();
        let mut pool = get_pool(&env)?;
        if pool.admin != admin {
            return Err(Error::Unauthorized);
        }
        if loss_amount <= 0 {
            return Err(Error::InvalidAmount);
        }

        let total_pool = pool
            .senior_principal
            .checked_add(pool.junior_principal)
            .unwrap_or(1)
            .max(1);
        let max_junior_absorb = total_pool
            .checked_mul(pool.junior_sub_ratio_bps as i128)
            .ok_or(Error::ArithmeticOverflow)?
            .checked_div(BPS)
            .unwrap_or(0);
        let remaining_buffer = (max_junior_absorb - pool.junior_write_down).max(0);

        if loss_amount <= remaining_buffer {
            pool.junior_write_down = pool
                .junior_write_down
                .checked_add(loss_amount)
                .ok_or(Error::ArithmeticOverflow)?;
        } else {
            // Junior exhausted; senior starts absorbing
            pool.junior_write_down = max_junior_absorb;
            env.events()
                .publish((symbol_short!("jrExhaust"),), loss_amount - remaining_buffer);
        }

        // Recalculate NAV
        let total_assets = pool
            .senior_principal
            .checked_add(pool.junior_principal)
            .unwrap_or(0)
            .saturating_sub(pool.junior_write_down);
        pool.nav_per_share = total_assets
            .checked_mul(NAV_SCALE)
            .unwrap_or(0)
            .checked_div(total_pool)
            .unwrap_or(0);

        save_pool(&env, &pool);
        env.events().publish((symbol_short!("default"),), loss_amount);
        Ok(())
    }

    // ── NAV oracle update ─────────────────────────────────────────────────────

    /// Auditor-only: push a new NAV per share (scaled by NAV_SCALE).
    pub fn update_nav(
        env: Env,
        auditor: Address,
        new_nav_per_share: i128,
    ) -> Result<(), Error> {
        auditor.require_auth();
        let mut pool = get_pool(&env)?;
        if pool.auditor != auditor {
            return Err(Error::UnauthorizedAuditor);
        }
        if new_nav_per_share <= 0 {
            return Err(Error::InvalidAmount);
        }
        pool.nav_per_share = new_nav_per_share;
        save_pool(&env, &pool);
        env.events()
            .publish((symbol_short!("nav"),), new_nav_per_share);
        Ok(())
    }

    // ── Withdrawal ────────────────────────────────────────────────────────────

    /// Redeem shares.  Returns the asset amount due.
    ///
    /// For Junior: redemption value is reduced by pro-rata write-downs.
    pub fn withdraw(
        env: Env,
        investor: Address,
        tranche: TrancheClass,
        shares: i128,
    ) -> Result<i128, Error> {
        Self::require_active(&env)?;
        investor.require_auth();
        if !is_whitelisted(&env, &investor) {
            return Err(Error::NotWhitelisted);
        }
        if shares <= 0 {
            return Err(Error::InvalidAmount);
        }

        let pool = get_pool(&env)?;
        let mut pos = get_position(&env, &investor, tranche)
            .ok_or(Error::PositionNotFound)?;

        if shares > pos.shares {
            return Err(Error::InsufficientShares);
        }

        // Assets = shares * nav_per_share / NAV_SCALE
        let gross_assets = shares
            .checked_mul(pool.nav_per_share)
            .ok_or(Error::ArithmeticOverflow)?
            .checked_div(NAV_SCALE)
            .ok_or(Error::ArithmeticOverflow)?;

        // For junior: apply write-down haircut proportionally
        let assets = if tranche == TrancheClass::Junior && pool.junior_write_down > 0 {
            let total_junior_pool = pool.junior_principal.max(1);
            let haircut_ratio = pool.junior_write_down
                .checked_mul(NAV_SCALE)
                .unwrap_or(NAV_SCALE)
                .checked_div(total_junior_pool)
                .unwrap_or(0);
            let haircut = gross_assets
                .checked_mul(haircut_ratio)
                .unwrap_or(0)
                .checked_div(NAV_SCALE)
                .unwrap_or(0);
            gross_assets - haircut
        } else {
            gross_assets
        };

        pos.shares -= shares;
        if pos.shares == 0 {
            remove_position(&env, &investor, tranche);
        } else {
            save_position(&env, &pos);
        }

        env.events()
            .publish((symbol_short!("withdraw"),), (&investor, tranche, shares, assets));
        Ok(assets)
    }

    // ── Secondary transfer (compliance-gated) ────────────────────────────────

    /// Transfer shares between two whitelisted investors.
    pub fn transfer_shares(
        env: Env,
        from: Address,
        to: Address,
        tranche: TrancheClass,
        shares: i128,
    ) -> Result<(), Error> {
        Self::require_active(&env)?;
        from.require_auth();
        if !is_whitelisted(&env, &from) || !is_whitelisted(&env, &to) {
            return Err(Error::TransferNotAllowed);
        }
        if shares <= 0 {
            return Err(Error::InvalidAmount);
        }

        let mut from_pos = get_position(&env, &from, tranche)
            .ok_or(Error::PositionNotFound)?;

        if shares > from_pos.shares {
            return Err(Error::InsufficientShares);
        }

        let pool = get_pool(&env)?;
        // Compute pro-rata principal transferred
        let principal_transfer = shares
            .checked_mul(from_pos.principal)
            .ok_or(Error::ArithmeticOverflow)?
            .checked_div(from_pos.shares.max(1))
            .unwrap_or(0);

        from_pos.shares -= shares;
        from_pos.principal -= principal_transfer;

        if from_pos.shares == 0 {
            remove_position(&env, &from, tranche);
        } else {
            save_position(&env, &from_pos);
        }

        let to_pos = match get_position(&env, &to, tranche) {
            Some(mut p) => {
                p.shares = p
                    .shares
                    .checked_add(shares)
                    .ok_or(Error::ArithmeticOverflow)?;
                p.principal = p
                    .principal
                    .checked_add(principal_transfer)
                    .ok_or(Error::ArithmeticOverflow)?;
                p
            }
            None => {
                add_investor_slot(&env, &to);
                Position {
                    investor: to.clone(),
                    tranche,
                    shares,
                    principal: principal_transfer,
                }
            }
        };
        save_position(&env, &to_pos);
        let _ = pool; // suppress unused warning

        env.events()
            .publish((symbol_short!("xferShrs"),), (&from, &to, tranche, shares));
        Ok(())
    }

    // ── Pause ─────────────────────────────────────────────────────────────────

    pub fn pause(env: Env, admin: Address) -> Result<(), Error> {
        admin.require_auth();
        let mut pool = get_pool(&env)?;
        if pool.admin != admin {
            return Err(Error::Unauthorized);
        }
        pool.paused = true;
        save_pool(&env, &pool);
        env.events().publish((symbol_short!("paused"),), admin);
        Ok(())
    }

    pub fn unpause(env: Env, admin: Address) -> Result<(), Error> {
        admin.require_auth();
        let mut pool = get_pool(&env)?;
        if pool.admin != admin {
            return Err(Error::Unauthorized);
        }
        pool.paused = false;
        save_pool(&env, &pool);
        env.events().publish((symbol_short!("unpaused"),), admin);
        Ok(())
    }

    // ── Queries ───────────────────────────────────────────────────────────────

    pub fn get_pool(env: Env) -> Result<PoolState, Error> {
        get_pool(&env)
    }

    pub fn get_position(
        env: Env,
        investor: Address,
        tranche: TrancheClass,
    ) -> Option<Position> {
        get_position(&env, &investor, tranche)
    }

    pub fn get_nav_per_share(env: Env) -> Result<i128, Error> {
        Ok(get_pool(&env)?.nav_per_share)
    }

    pub fn shares_to_assets(env: Env, shares: i128) -> Result<i128, Error> {
        let pool = get_pool(&env)?;
        shares
            .checked_mul(pool.nav_per_share)
            .ok_or(Error::ArithmeticOverflow)?
            .checked_div(NAV_SCALE)
            .ok_or(Error::ArithmeticOverflow)
    }

    // ── Internal helpers ──────────────────────────────────────────────────────

    fn require_active(env: &Env) -> Result<(), Error> {
        let pool = get_pool(env)?;
        if pool.paused {
            return Err(Error::PoolPaused);
        }
        Ok(())
    }
}
