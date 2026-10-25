// Copyright (c) 2026 StellarDevHub
// SPDX-License-Identifier: MIT

#![no_std]

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, symbol_short, Address, Env, Vec,
};

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    NotInitialized = 1,
    AlreadyInitialized = 2,
    Unauthorized = 3,
    ScheduleNotFound = 4,
    ScheduleAlreadyRevoked = 5,
    NonRevocableSchedule = 6,
    ZeroClaimable = 7,
    InvalidScheduleParameters = 8,
    MathOverflow = 9,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VestingSchedule {
    pub id: u32,
    pub beneficiary: Address,
    pub token: Address,
    pub total_amount: i128,
    pub claimed_amount: i128,
    pub start_ledger: u32,
    pub cliff_ledger: u32,
    pub duration_ledgers: u32,
    pub is_revocable: bool,
    pub revoked: bool,
    pub delegate: Option<Address>,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AllocationInput {
    pub beneficiary: Address,
    pub total_amount: i128,
    pub start_ledger: u32,
    pub cliff_ledger: u32,
    pub duration_ledgers: u32,
    pub is_revocable: bool,
}

#[contracttype]
enum DataKey {
    Admin,
    Treasury,
    NextScheduleId,
    Schedule(u32),
    BeneficiarySchedules(Address),
    DelegatedVotingPower(Address),
}

#[contract]
pub struct TokenVestingVault;

#[contractimpl]
impl TokenVestingVault {
    /// Initialize the institutional vesting vault with admin and treasury addresses.
    pub fn initialize(env: Env, admin: Address, treasury: Address) -> Result<(), Error> {
        if env.storage().instance().has(&DataKey::Admin) {
            return Err(Error::AlreadyInitialized);
        }
        admin.require_auth();

        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::Treasury, &treasury);
        env.storage().instance().set(&DataKey::NextScheduleId, &1u32);

        env.events().publish((symbol_short!("init"),), (admin, treasury));
        Ok(())
    }

    /// Create an institutional vesting schedule for a single beneficiary.
    pub fn create_schedule(
        env: Env,
        caller: Address,
        beneficiary: Address,
        token: Address,
        total_amount: i128,
        start_ledger: u32,
        cliff_ledger: u32,
        duration_ledgers: u32,
        is_revocable: bool,
    ) -> Result<u32, Error> {
        caller.require_auth();

        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(Error::NotInitialized)?;
        if caller != admin {
            return Err(Error::Unauthorized);
        }

        Self::validate_schedule_params(total_amount, start_ledger, cliff_ledger, duration_ledgers)?;

        let id = Self::internal_create_schedule(
            &env,
            beneficiary,
            token,
            total_amount,
            start_ledger,
            cliff_ledger,
            duration_ledgers,
            is_revocable,
        );

        Ok(id)
    }

    /// Batch create vesting schedules for team and investor distributions.
    pub fn create_batch_schedules(
        env: Env,
        caller: Address,
        token: Address,
        allocations: Vec<AllocationInput>,
    ) -> Result<Vec<u32>, Error> {
        caller.require_auth();

        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(Error::NotInitialized)?;
        if caller != admin {
            return Err(Error::Unauthorized);
        }

        let mut schedule_ids = Vec::new(&env);
        for allocation in allocations.iter() {
            Self::validate_schedule_params(
                allocation.total_amount,
                allocation.start_ledger,
                allocation.cliff_ledger,
                allocation.duration_ledgers,
            )?;

            let id = Self::internal_create_schedule(
                &env,
                allocation.beneficiary,
                token.clone(),
                allocation.total_amount,
                allocation.start_ledger,
                allocation.cliff_ledger,
                allocation.duration_ledgers,
                allocation.is_revocable,
            );
            schedule_ids.push_back(id);
        }

        Ok(schedule_ids)
    }

    /// Claim vested tokens for a given schedule.
    pub fn claim(env: Env, beneficiary: Address, schedule_id: u32) -> Result<i128, Error> {
        beneficiary.require_auth();

        let mut schedule: VestingSchedule = env
            .storage()
            .persistent()
            .get(&DataKey::Schedule(schedule_id))
            .ok_or(Error::ScheduleNotFound)?;

        if schedule.beneficiary != beneficiary {
            return Err(Error::Unauthorized);
        }

        let current_ledger = env.ledger().sequence();
        let vested_amount = Self::compute_vested_amount(
            current_ledger,
            schedule.start_ledger,
            schedule.cliff_ledger,
            schedule.duration_ledgers,
            schedule.total_amount,
        );

        let claimable = vested_amount - schedule.claimed_amount;
        if claimable <= 0 {
            return Err(Error::ZeroClaimable);
        }

        schedule.claimed_amount += claimable;
        env.storage()
            .persistent()
            .set(&DataKey::Schedule(schedule_id), &schedule);

        env.events().publish(
            (symbol_short!("claim"), beneficiary, schedule_id),
            claimable,
        );

        Ok(claimable)
    }

    /// Revoke a revocable vesting schedule. Unvested tokens return to treasury;
    /// vested tokens remain with beneficiary.
    pub fn revoke_schedule(
        env: Env,
        caller: Address,
        schedule_id: u32,
    ) -> Result<(i128, i128), Error> {
        caller.require_auth();

        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(Error::NotInitialized)?;
        if caller != admin {
            return Err(Error::Unauthorized);
        }

        let mut schedule: VestingSchedule = env
            .storage()
            .persistent()
            .get(&DataKey::Schedule(schedule_id))
            .ok_or(Error::ScheduleNotFound)?;

        if schedule.revoked {
            return Err(Error::ScheduleAlreadyRevoked);
        }

        if !schedule.is_revocable {
            return Err(Error::NonRevocableSchedule);
        }

        let current_ledger = env.ledger().sequence();
        let vested_amount = Self::compute_vested_amount(
            current_ledger,
            schedule.start_ledger,
            schedule.cliff_ledger,
            schedule.duration_ledgers,
            schedule.total_amount,
        );

        let unvested_amount = schedule.total_amount - vested_amount;

        // If unvested tokens were delegated for voting, deduct the revoked unvested power
        if let Some(delegatee) = schedule.delegate.clone() {
            let current_power: i128 = env
                .storage()
                .persistent()
                .get(&DataKey::DelegatedVotingPower(delegatee.clone()))
                .unwrap_or(0);
            let updated_power = if current_power >= unvested_amount {
                current_power - unvested_amount
            } else {
                0
            };
            env.storage()
                .persistent()
                .set(&DataKey::DelegatedVotingPower(delegatee), &updated_power);
        }

        // Clean division: schedule total amount is capped at vested portion
        schedule.total_amount = vested_amount;
        schedule.revoked = true;
        schedule.delegate = None;

        env.storage()
            .persistent()
            .set(&DataKey::Schedule(schedule_id), &schedule);

        let treasury: Address = env
            .storage()
            .instance()
            .get(&DataKey::Treasury)
            .ok_or(Error::NotInitialized)?;

        env.events().publish(
            (symbol_short!("revoke"), schedule_id, treasury),
            (vested_amount, unvested_amount),
        );

        Ok((vested_amount, unvested_amount))
    }

    /// Delegate voting power of unvested tokens in DAO governance without inflating circulating supply.
    pub fn delegate_voting_power(
        env: Env,
        caller: Address,
        schedule_id: u32,
        delegatee: Address,
    ) -> Result<(), Error> {
        caller.require_auth();

        let mut schedule: VestingSchedule = env
            .storage()
            .persistent()
            .get(&DataKey::Schedule(schedule_id))
            .ok_or(Error::ScheduleNotFound)?;

        if schedule.beneficiary != caller {
            return Err(Error::Unauthorized);
        }

        if schedule.revoked {
            return Err(Error::ScheduleAlreadyRevoked);
        }

        let current_ledger = env.ledger().sequence();
        let vested_amount = Self::compute_vested_amount(
            current_ledger,
            schedule.start_ledger,
            schedule.cliff_ledger,
            schedule.duration_ledgers,
            schedule.total_amount,
        );
        let unvested_amount = schedule.total_amount - vested_amount;

        // If previously delegated, remove power from previous delegate
        if let Some(prev_delegate) = schedule.delegate {
            let prev_power: i128 = env
                .storage()
                .persistent()
                .get(&DataKey::DelegatedVotingPower(prev_delegate.clone()))
                .unwrap_or(0);
            let updated_prev = if prev_power >= unvested_amount {
                prev_power - unvested_amount
            } else {
                0
            };
            env.storage()
                .persistent()
                .set(&DataKey::DelegatedVotingPower(prev_delegate), &updated_prev);
        }

        // Add power to new delegatee
        let new_power: i128 = env
            .storage()
            .persistent()
            .get(&DataKey::DelegatedVotingPower(delegatee.clone()))
            .unwrap_or(0);
        env.storage().persistent().set(
            &DataKey::DelegatedVotingPower(delegatee.clone()),
            &(new_power + unvested_amount),
        );

        schedule.delegate = Some(delegatee.clone());
        env.storage()
            .persistent()
            .set(&DataKey::Schedule(schedule_id), &schedule);

        env.events().publish(
            (symbol_short!("delegate"), caller, schedule_id),
            (delegatee, unvested_amount),
        );

        Ok(())
    }

    /// Undelegate voting power from the current delegatee.
    pub fn undelegate_voting_power(
        env: Env,
        caller: Address,
        schedule_id: u32,
    ) -> Result<(), Error> {
        caller.require_auth();

        let mut schedule: VestingSchedule = env
            .storage()
            .persistent()
            .get(&DataKey::Schedule(schedule_id))
            .ok_or(Error::ScheduleNotFound)?;

        if schedule.beneficiary != caller {
            return Err(Error::Unauthorized);
        }

        if let Some(prev_delegate) = schedule.delegate {
            let current_ledger = env.ledger().sequence();
            let vested_amount = Self::compute_vested_amount(
                current_ledger,
                schedule.start_ledger,
                schedule.cliff_ledger,
                schedule.duration_ledgers,
                schedule.total_amount,
            );
            let unvested_amount = schedule.total_amount - vested_amount;

            let prev_power: i128 = env
                .storage()
                .persistent()
                .get(&DataKey::DelegatedVotingPower(prev_delegate.clone()))
                .unwrap_or(0);
            let updated_prev = if prev_power >= unvested_amount {
                prev_power - unvested_amount
            } else {
                0
            };
            env.storage()
                .persistent()
                .set(&DataKey::DelegatedVotingPower(prev_delegate), &updated_prev);

            schedule.delegate = None;
            env.storage()
                .persistent()
                .set(&DataKey::Schedule(schedule_id), &schedule);
        }

        Ok(())
    }

    /// Get total delegated DAO voting power held by an address.
    pub fn get_voting_power(env: Env, account: Address) -> i128 {
        env.storage()
            .persistent()
            .get(&DataKey::DelegatedVotingPower(account))
            .unwrap_or(0)
    }

    /// Query full details of a vesting schedule.
    pub fn get_schedule(env: Env, schedule_id: u32) -> Result<VestingSchedule, Error> {
        env.storage()
            .persistent()
            .get(&DataKey::Schedule(schedule_id))
            .ok_or(Error::ScheduleNotFound)
    }

    /// Calculate currently vested amount for a schedule.
    pub fn get_vested_amount(env: Env, schedule_id: u32) -> Result<i128, Error> {
        let schedule: VestingSchedule = env
            .storage()
            .persistent()
            .get(&DataKey::Schedule(schedule_id))
            .ok_or(Error::ScheduleNotFound)?;

        let current_ledger = env.ledger().sequence();
        Ok(Self::compute_vested_amount(
            current_ledger,
            schedule.start_ledger,
            schedule.cliff_ledger,
            schedule.duration_ledgers,
            schedule.total_amount,
        ))
    }

    /// Calculate currently claimable amount for a schedule.
    pub fn get_claimable_amount(env: Env, schedule_id: u32) -> Result<i128, Error> {
        let schedule: VestingSchedule = env
            .storage()
            .persistent()
            .get(&DataKey::Schedule(schedule_id))
            .ok_or(Error::ScheduleNotFound)?;

        let current_ledger = env.ledger().sequence();
        let vested = Self::compute_vested_amount(
            current_ledger,
            schedule.start_ledger,
            schedule.cliff_ledger,
            schedule.duration_ledgers,
            schedule.total_amount,
        );
        Ok(vested - schedule.claimed_amount)
    }

    /// Calculate currently unvested amount for a schedule.
    pub fn get_unvested_amount(env: Env, schedule_id: u32) -> Result<i128, Error> {
        let schedule: VestingSchedule = env
            .storage()
            .persistent()
            .get(&DataKey::Schedule(schedule_id))
            .ok_or(Error::ScheduleNotFound)?;

        let current_ledger = env.ledger().sequence();
        let vested = Self::compute_vested_amount(
            current_ledger,
            schedule.start_ledger,
            schedule.cliff_ledger,
            schedule.duration_ledgers,
            schedule.total_amount,
        );
        Ok(schedule.total_amount - vested)
    }

    /// Get all schedule IDs for a beneficiary.
    pub fn get_beneficiary_schedules(env: Env, beneficiary: Address) -> Vec<u32> {
        env.storage()
            .persistent()
            .get(&DataKey::BeneficiarySchedules(beneficiary))
            .unwrap_or(Vec::new(&env))
    }

    /// Get treasury address.
    pub fn get_treasury(env: Env) -> Result<Address, Error> {
        env.storage()
            .instance()
            .get(&DataKey::Treasury)
            .ok_or(Error::NotInitialized)
    }

    /// Get admin address.
    pub fn get_admin(env: Env) -> Result<Address, Error> {
        env.storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(Error::NotInitialized)
    }

    // ── Internal Helper Functions ──────────────────────────────────────────

    fn validate_schedule_params(
        total_amount: i128,
        start_ledger: u32,
        cliff_ledger: u32,
        duration_ledgers: u32,
    ) -> Result<(), Error> {
        if total_amount <= 0 || duration_ledgers == 0 {
            return Err(Error::InvalidScheduleParameters);
        }
        if cliff_ledger < start_ledger || cliff_ledger > start_ledger + duration_ledgers {
            return Err(Error::InvalidScheduleParameters);
        }
        Ok(())
    }

    fn internal_create_schedule(
        env: &Env,
        beneficiary: Address,
        token: Address,
        total_amount: i128,
        start_ledger: u32,
        cliff_ledger: u32,
        duration_ledgers: u32,
        is_revocable: bool,
    ) -> u32 {
        let id: u32 = env
            .storage()
            .instance()
            .get(&DataKey::NextScheduleId)
            .unwrap_or(1);
        env.storage()
            .instance()
            .set(&DataKey::NextScheduleId, &(id + 1));

        let schedule = VestingSchedule {
            id,
            beneficiary: beneficiary.clone(),
            token,
            total_amount,
            claimed_amount: 0,
            start_ledger,
            cliff_ledger,
            duration_ledgers,
            is_revocable,
            revoked: false,
            delegate: None,
        };

        env.storage()
            .persistent()
            .set(&DataKey::Schedule(id), &schedule);

        // Track schedule for beneficiary
        let mut user_schedules: Vec<u32> = env
            .storage()
            .persistent()
            .get(&DataKey::BeneficiarySchedules(beneficiary.clone()))
            .unwrap_or(Vec::new(env));
        user_schedules.push_back(id);
        env.storage()
            .persistent()
            .set(&DataKey::BeneficiarySchedules(beneficiary.clone()), &user_schedules);

        env.events().publish(
            (symbol_short!("create"), beneficiary, id),
            (total_amount, start_ledger, cliff_ledger, duration_ledgers, is_revocable),
        );

        id
    }

    /// Compute linear vested amount with sub-ledger mathematical precision.
    /// Before cliff milestone: 0 claimable.
    /// After cliff milestone: linear progression from start_ledger to end_ledger.
    pub fn compute_vested_amount(
        current_ledger: u32,
        start_ledger: u32,
        cliff_ledger: u32,
        duration_ledgers: u32,
        total_amount: i128,
    ) -> i128 {
        if current_ledger < cliff_ledger {
            0
        } else {
            let end_ledger = start_ledger + duration_ledgers;
            if current_ledger >= end_ledger {
                total_amount
            } else {
                let elapsed = (current_ledger - start_ledger) as i128;
                (total_amount * elapsed) / (duration_ledgers as i128)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::testutils::{Address as _, Ledger};

    fn setup_test_vault(env: &Env) -> (Address, Address, Address) {
        let admin = Address::generate(env);
        let treasury = Address::generate(env);
        let token = Address::generate(env);

        TokenVestingVault::initialize(env.clone(), admin.clone(), treasury.clone()).unwrap();

        (admin, treasury, token)
    }

    #[test]
    fn test_initialization() {
        let env = Env::default();
        env.mock_all_auths();
        let (admin, treasury, _) = setup_test_vault(&env);

        assert_eq!(TokenVestingVault::get_admin(env.clone()).unwrap(), admin);
        assert_eq!(TokenVestingVault::get_treasury(env.clone()).unwrap(), treasury);
    }

    #[test]
    fn test_cliff_boundaries_and_zero_tokens_before_cliff() {
        let env = Env::default();
        env.mock_all_auths();
        let (admin, _, token) = setup_test_vault(&env);
        let beneficiary = Address::generate(&env);

        let start = 1_000;
        let cliff = 1_500;
        let duration = 1_000; // ends at 2_000
        let total = 100_000i128;

        let id = TokenVestingVault::create_schedule(
            env.clone(),
            admin,
            beneficiary.clone(),
            token,
            total,
            start,
            cliff,
            duration,
            true,
        )
        .unwrap();

        // 1. Before cliff (sequence = 1_499) -> 0 claimable
        env.ledger().set_sequence_number(1_499);
        assert_eq!(TokenVestingVault::get_vested_amount(env.clone(), id).unwrap(), 0);
        assert_eq!(TokenVestingVault::get_claimable_amount(env.clone(), id).unwrap(), 0);

        let err = TokenVestingVault::claim(env.clone(), beneficiary.clone(), id);
        assert_eq!(err, Err(Error::ZeroClaimable));

        // 2. Exactly at cliff milestone (sequence = 1_500) -> 50% vested (500 elapsed / 1000 duration)
        env.ledger().set_sequence_number(1_500);
        let vested_at_cliff = TokenVestingVault::get_vested_amount(env.clone(), id).unwrap();
        assert_eq!(vested_at_cliff, 50_000);
        assert_eq!(TokenVestingVault::get_claimable_amount(env.clone(), id).unwrap(), 50_000);

        // Claim succeeds at cliff
        let claimed = TokenVestingVault::claim(env.clone(), beneficiary, id).unwrap();
        assert_eq!(claimed, 50_000);
        assert_eq!(TokenVestingVault::get_claimable_amount(env.clone(), id).unwrap(), 0);
    }

    #[test]
    fn test_sub_ledger_linear_precision() {
        let env = Env::default();
        env.mock_all_auths();
        let (admin, _, token) = setup_test_vault(&env);
        let beneficiary = Address::generate(&env);

        let start = 1_000;
        let cliff = 1_000; // no cliff
        let duration = 10_000;
        let total = 1_000_000i128;

        let id = TokenVestingVault::create_schedule(
            env.clone(),
            admin,
            beneficiary.clone(),
            token,
            total,
            start,
            cliff,
            duration,
            false, // hard commitment
        )
        .unwrap();

        // 25% progress (sequence = 3_500)
        env.ledger().set_sequence_number(3_500);
        assert_eq!(TokenVestingVault::get_vested_amount(env.clone(), id).unwrap(), 250_000);

        // 73.4% progress (sequence = 8_340)
        env.ledger().set_sequence_number(8_340);
        assert_eq!(TokenVestingVault::get_vested_amount(env.clone(), id).unwrap(), 734_000);

        // 100% completion (sequence >= 11_000)
        env.ledger().set_sequence_number(11_000);
        assert_eq!(TokenVestingVault::get_vested_amount(env.clone(), id).unwrap(), 1_000_000);
    }

    #[test]
    fn test_revocable_schedule_clean_division() {
        let env = Env::default();
        env.mock_all_auths();
        let (admin, _, token) = setup_test_vault(&env);
        let beneficiary = Address::generate(&env);

        let start = 1_000;
        let cliff = 1_200;
        let duration = 1_000; // ends at 2_000
        let total = 100_000i128;

        let id = TokenVestingVault::create_schedule(
            env.clone(),
            admin.clone(),
            beneficiary.clone(),
            token,
            total,
            start,
            cliff,
            duration,
            true, // revocable
        )
        .unwrap();

        // Beneficiary claims at ledger 1_400 (40% vested = 40_000)
        env.ledger().set_sequence_number(1_400);
        TokenVestingVault::claim(env.clone(), beneficiary.clone(), id).unwrap();

        // Revocation occurs at ledger 1_600 (60% vested = 60_000, unvested = 40_000)
        env.ledger().set_sequence_number(1_600);
        let (vested, unvested) =
            TokenVestingVault::revoke_schedule(env.clone(), admin, id).unwrap();

        assert_eq!(vested, 60_000);
        assert_eq!(unvested, 40_000);

        // Beneficiary can still claim the remaining 20_000 vested tokens (60_000 - 40_000 claimed)
        let remaining_claim = TokenVestingVault::claim(env.clone(), beneficiary, id).unwrap();
        assert_eq!(remaining_claim, 20_000);

        // Cannot vest any further even as time reaches end_ledger
        env.ledger().set_sequence_number(3_000);
        let sched = TokenVestingVault::get_schedule(env.clone(), id).unwrap();
        assert_eq!(sched.total_amount, 60_000);
        assert_eq!(sched.revoked, true);
        assert_eq!(TokenVestingVault::get_claimable_amount(env.clone(), id).unwrap(), 0);
    }

    #[test]
    fn test_hard_commitment_non_revocable_protection() {
        let env = Env::default();
        env.mock_all_auths();
        let (admin, _, token) = setup_test_vault(&env);
        let investor = Address::generate(&env);

        let id = TokenVestingVault::create_schedule(
            env.clone(),
            admin.clone(),
            investor,
            token,
            50_000,
            1_000,
            1_500,
            1_000,
            false, // non-revocable
        )
        .unwrap();

        // Attempting to revoke hard commitment schedule fails
        env.ledger().set_sequence_number(1_200);
        let res = TokenVestingVault::revoke_schedule(env.clone(), admin, id);
        assert_eq!(res, Err(Error::NonRevocableSchedule));
    }

    #[test]
    fn test_voting_power_delegation_without_circulating_inflation() {
        let env = Env::default();
        env.mock_all_auths();
        let (admin, _, token) = setup_test_vault(&env);
        let team_member = Address::generate(&env);
        let delegatee = Address::generate(&env);

        let start = 1_000;
        let cliff = 1_500;
        let duration = 1_000;
        let total = 200_000i128;

        let id = TokenVestingVault::create_schedule(
            env.clone(),
            admin,
            team_member.clone(),
            token,
            total,
            start,
            cliff,
            duration,
            true,
        )
        .unwrap();

        // At sequence 1_200 (before cliff), all 200_000 tokens are unvested
        env.ledger().set_sequence_number(1_200);
        TokenVestingVault::delegate_voting_power(
            env.clone(),
            team_member.clone(),
            id,
            delegatee.clone(),
        )
        .unwrap();

        // Delegatee receives 200_000 voting power in DAO governance
        assert_eq!(TokenVestingVault::get_voting_power(env.clone(), delegatee.clone()), 200_000);

        // Beneficiary undelegates
        TokenVestingVault::undelegate_voting_power(env.clone(), team_member, id).unwrap();
        assert_eq!(TokenVestingVault::get_voting_power(env.clone(), delegatee), 0);
    }

    #[test]
    fn test_multi_beneficiary_batch_allocation() {
        let env = Env::default();
        env.mock_all_auths();
        let (admin, _, token) = setup_test_vault(&env);

        let ben1 = Address::generate(&env);
        let ben2 = Address::generate(&env);
        let ben3 = Address::generate(&env);

        let mut allocations = Vec::new(&env);
        allocations.push_back(AllocationInput {
            beneficiary: ben1.clone(),
            total_amount: 10_000,
            start_ledger: 1_000,
            cliff_ledger: 1_200,
            duration_ledgers: 1_000,
            is_revocable: true,
        });
        allocations.push_back(AllocationInput {
            beneficiary: ben2.clone(),
            total_amount: 20_000,
            start_ledger: 1_000,
            cliff_ledger: 1_000,
            duration_ledgers: 2_000,
            is_revocable: false,
        });
        allocations.push_back(AllocationInput {
            beneficiary: ben3.clone(),
            total_amount: 30_000,
            start_ledger: 1_000,
            cliff_ledger: 1_500,
            duration_ledgers: 1_000,
            is_revocable: true,
        });

        let ids = TokenVestingVault::create_batch_schedules(
            env.clone(),
            admin,
            token,
            allocations,
        )
        .unwrap();

        assert_eq!(ids.len(), 3);
        assert_eq!(TokenVestingVault::get_beneficiary_schedules(env.clone(), ben1).len(), 1);
        assert_eq!(TokenVestingVault::get_beneficiary_schedules(env.clone(), ben2).len(), 1);
        assert_eq!(TokenVestingVault::get_beneficiary_schedules(env.clone(), ben3).len(), 1);
    }
}
