#![no_std]

//! Quadratic Funding Grant Matching Protocol (issue #1837).
//!
//! A Gitcoin-style round: community micro-donations are matched against an
//! institutional matching pool, with projects supported by the *broadest*
//! base of individual donors receiving the most — the quadratic funding
//! principle.
//!
//! ## Quadratic matching math
//!
//! For a project with donor contributions `c_i`:
//!
//! ```text
//! MatchWeight = (sum(sqrt(c_i)))^2
//! MatchAmount = MatchWeight - sum(c_i)      (clamped at zero)
//! ```
//!
//! Square roots are evaluated in fixed point with a scale of `SCALE = 10^6`
//! (`sqrt_fp(c) = isqrt(c * 10^12)`), and every division floors, so no
//! rounding can inflate a match. Contributions are bounded by
//! `MAX_CONTRIBUTION` and the pool by `MAX_POOL` so the `u128` intermediate
//! products cannot overflow.
//!
//! ## Sybil resistance
//!
//! Only addresses holding the admin-issued credential (`set_verified`) can
//! donate. Splitting a donation across puppet accounts is therefore
//! useless: puppets cannot donate at all, and repeated donations from one
//! verified donor aggregate into a single contribution entry — one donor,
//! one `sqrt` term, no matter how many transactions they send.
//!
//! ## Escrow and milestones
//!
//! Donations and matching funds sit in this contract as milestone escrow.
//! A project owner releases funds milestone by milestone only after the
//! admin approves; donors can therefore stop funding an abandoned project
//! before its escrow drains.
//!
//! ## Disputes
//!
//! Verified community members can flag a proposal. When the admin resolves
//! a flag as fraudulent, the unspent escrow is split: the donated portion
//! is refunded to donors pro rata, and the unmatched institutional portion
//! returns to the round's funder.

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, symbol_short, token, Address, Env, Map,
    String, Vec,
};

/// Fixed-point scale for integer square roots (10^6).
pub const SCALE: i128 = 1_000_000;
/// `SCALE^2`, the divisor that removes the double scaling of `sqrt_fp^2`.
pub const SCALE_SQ: u128 = 1_000_000_000_000;
/// Largest single-donor contribution accepted per project.
pub const MAX_CONTRIBUTION: i128 = 1_000_000_000_000_000; // 10^15
/// Largest institutional matching pool per round.
pub const MAX_POOL: i128 = 1_000_000_000_000_000_000; // 10^18
/// Maximum donors tracked per project (bounds the close/refund loops).
pub const MAX_DONORS: u32 = 256;
/// Maximum projects per round.
pub const MAX_PROJECTS: u32 = 64;
/// Maximum milestones per project.
pub const MAX_MILESTONES: u32 = 16;
/// Maximum distinct flags per project.
pub const MAX_FLAGS: u32 = 32;
/// Maximum project name length.
pub const MAX_NAME_LEN: u32 = 64;
/// Maximum milestone description length.
pub const MAX_DESCRIPTION_LEN: u32 = 64;

/// One release checkpoint of a project's escrow.
#[contracttype]
#[derive(Clone)]
pub struct Milestone {
    pub description: String,
    pub amount: i128,
    pub approved: bool,
}

/// A registered grant proposal.
#[contracttype]
#[derive(Clone)]
pub struct Project {
    pub id: u32,
    pub round_id: u32,
    pub owner: Address,
    pub name: String,
    /// Donor -> cumulative contribution. Re-donations aggregate.
    pub contributions: Map<Address, i128>,
    /// Deterministic donor iteration order for close and refund.
    pub donor_order: Vec<Address>,
    pub total_contributed: i128,
    pub match_awarded: i128,
    pub released: i128,
    pub refunded: bool,
    pub flagged: bool,
    pub flags: Vec<Address>,
    pub milestones: Vec<Milestone>,
}

/// A funding round funded by an institution.
#[contracttype]
#[derive(Clone)]
pub struct Round {
    pub id: u32,
    pub funder: Address,
    pub deadline_ledger: u64,
    pub matching_pool: i128,
    pub closed: bool,
    pub projects: Vec<u32>,
}

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Admin,
    Token,
    NextRound,
    NextProject,
    Round(u32),
    Project(u32),
    Verified(Address),
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    AlreadyInitialized = 1,
    NotAuthorized = 2,
    RoundNotFound = 3,
    RoundClosed = 4,
    /// The round's contribution deadline has passed.
    RoundOver = 5,
    ProjectNotFound = 6,
    ProjectNotInRound = 7,
    /// The donor lacks the admin-issued credential.
    NotVerified = 8,
    SelfContribution = 9,
    ZeroAmount = 10,
    ContributionTooLarge = 11,
    PoolTooLarge = 12,
    TooManyDonors = 13,
    TooManyProjects = 14,
    TooManyMilestones = 15,
    TooManyFlags = 16,
    AlreadyFlagged = 17,
    NotFlagged = 18,
    AlreadyResolved = 19,
    MilestoneNotFound = 20,
    MilestoneAlreadyApproved = 21,
    /// Releasing a milestone would exceed the project's escrow.
    InsufficientEscrow = 22,
    AlreadyRefunded = 23,
    ArithmeticError = 24,
    InvalidDeadline = 25,
    InvalidName = 26,
    InvalidDescription = 27,
    InvalidMilestoneAmount = 28,
}

#[contract]
pub struct QuadraticGrants;

#[contractimpl]
impl QuadraticGrants {
    /// Initialise the protocol with an admin and the single grant token that
    /// every round, donation and refund is denominated in.
    pub fn initialize(env: Env, admin: Address, token: Address) -> Result<(), Error> {
        if env.storage().instance().has(&DataKey::Admin) {
            return Err(Error::AlreadyInitialized);
        }
        admin.require_auth();
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::Token, &token);
        env.storage().instance().set(&DataKey::NextRound, &0u32);
        env.storage().instance().set(&DataKey::NextProject, &0u32);
        env.events()
            .publish((symbol_short!("grants"), symbol_short!("init")), admin);
        Ok(())
    }

    // ── Sybil-resistance credentials ────────────────────────────────────────

    /// Issue the donation credential to `donor`. Admin only.
    pub fn set_verified(env: Env, caller: Address, donor: Address) -> Result<(), Error> {
        Self::require_admin(&env, &caller)?;
        env.storage()
            .persistent()
            .set(&DataKey::Verified(donor.clone()), &true);
        env.events()
            .publish((symbol_short!("grants"), symbol_short!("verify")), donor);
        Ok(())
    }

    /// Revoke the donation credential. Admin only.
    pub fn revoke_verified(env: Env, caller: Address, donor: Address) -> Result<(), Error> {
        Self::require_admin(&env, &caller)?;
        env.storage()
            .persistent()
            .set(&DataKey::Verified(donor.clone()), &false);
        env.events()
            .publish((symbol_short!("grants"), symbol_short!("unverify")), donor);
        Ok(())
    }

    /// Whether `donor` currently holds the donation credential.
    pub fn is_verified(env: Env, donor: Address) -> bool {
        env.storage()
            .persistent()
            .get(&DataKey::Verified(donor))
            .unwrap_or(false)
    }

    // ── Rounds ──────────────────────────────────────────────────────────────

    /// Open a round with an institutional matching pool of `matching_pool`
    /// tokens, pulled from the funder (which must have approved this
    /// contract as a spender), accepting donations until `deadline_ledger`.
    pub fn create_round(
        env: Env,
        funder: Address,
        deadline_ledger: u64,
        matching_pool: i128,
    ) -> Result<u32, Error> {
        if matching_pool <= 0 {
            return Err(Error::ZeroAmount);
        }
        if matching_pool > MAX_POOL {
            return Err(Error::PoolTooLarge);
        }
        if deadline_ledger <= u64::from(env.ledger().sequence()) {
            return Err(Error::InvalidDeadline);
        }
        funder.require_auth();

        let mut next: u32 = env
            .storage()
            .instance()
            .get(&DataKey::NextRound)
            .unwrap_or(0);
        let id = next;
        next = next.checked_add(1).ok_or(Error::ArithmeticError)?;
        env.storage().instance().set(&DataKey::NextRound, &next);

        let round = Round {
            id,
            funder: funder.clone(),
            deadline_ledger,
            matching_pool,
            closed: false,
            projects: Vec::new(&env),
        };
        env.storage().persistent().set(&DataKey::Round(id), &round);

        token::Client::new(&env, &Self::token(&env)?).transfer_from(
            &env.current_contract_address(),
            &funder,
            &env.current_contract_address(),
            &matching_pool,
        );

        env.events().publish(
            (symbol_short!("grants"), symbol_short!("round")),
            (id, deadline_ledger, matching_pool),
        );
        Ok(id)
    }

    /// Register `owner`'s project in `round_id` under `name`.
    pub fn register_project(
        env: Env,
        owner: Address,
        round_id: u32,
        name: String,
    ) -> Result<u32, Error> {
        if name.is_empty() || name.len() > MAX_NAME_LEN {
            return Err(Error::InvalidName);
        }
        owner.require_auth();

        let mut round: Round = env
            .storage()
            .persistent()
            .get(&DataKey::Round(round_id))
            .ok_or(Error::RoundNotFound)?;
        if round.closed {
            return Err(Error::RoundClosed);
        }
        if round.projects.len() >= MAX_PROJECTS {
            return Err(Error::TooManyProjects);
        }

        let mut next: u32 = env
            .storage()
            .instance()
            .get(&DataKey::NextProject)
            .unwrap_or(0);
        let id = next;
        next = next.checked_add(1).ok_or(Error::ArithmeticError)?;
        env.storage().instance().set(&DataKey::NextProject, &next);

        let project = Project {
            id,
            round_id,
            owner: owner.clone(),
            name,
            contributions: Map::new(&env),
            donor_order: Vec::new(&env),
            total_contributed: 0,
            match_awarded: 0,
            released: 0,
            refunded: false,
            flagged: false,
            flags: Vec::new(&env),
            milestones: Vec::new(&env),
        };
        env.storage()
            .persistent()
            .set(&DataKey::Project(id), &project);
        round.projects.push_back(id);
        env.storage()
            .persistent()
            .set(&DataKey::Round(round_id), &round);

        env.events().publish(
            (symbol_short!("grants"), symbol_short!("project")),
            (id, round_id),
        );
        Ok(id)
    }

    /// Donate `amount` to `project_id` from a credential-holding `donor`.
    /// Re-donations from the same donor aggregate into one contribution
    /// entry, so one donor counts once in the quadratic formula.
    pub fn contribute(
        env: Env,
        donor: Address,
        project_id: u32,
        amount: i128,
    ) -> Result<(), Error> {
        if amount <= 0 {
            return Err(Error::ZeroAmount);
        }
        if amount > MAX_CONTRIBUTION {
            return Err(Error::ContributionTooLarge);
        }
        donor.require_auth();

        if !Self::is_verified(env.clone(), donor.clone()) {
            return Err(Error::NotVerified);
        }

        let mut project: Project = env
            .storage()
            .persistent()
            .get(&DataKey::Project(project_id))
            .ok_or(Error::ProjectNotFound)?;
        let round: Round = env
            .storage()
            .persistent()
            .get(&DataKey::Round(project.round_id))
            .ok_or(Error::RoundNotFound)?;
        if round.closed {
            return Err(Error::RoundClosed);
        }
        if u64::from(env.ledger().sequence()) > round.deadline_ledger {
            return Err(Error::RoundOver);
        }
        if donor == project.owner {
            return Err(Error::SelfContribution);
        }

        let prior: i128 = project.contributions.get(donor.clone()).unwrap_or(0);
        let total = prior.checked_add(amount).ok_or(Error::ArithmeticError)?;
        if total > MAX_CONTRIBUTION {
            return Err(Error::ContributionTooLarge);
        }
        if prior == 0 {
            if project.donor_order.len() >= MAX_DONORS {
                return Err(Error::TooManyDonors);
            }
            project.donor_order.push_back(donor.clone());
        }
        project.contributions.set(donor.clone(), total);
        project.total_contributed = project
            .total_contributed
            .checked_add(amount)
            .ok_or(Error::ArithmeticError)?;
        env.storage()
            .persistent()
            .set(&DataKey::Project(project_id), &project);

        token::Client::new(&env, &Self::token(&env)?).transfer_from(
            &env.current_contract_address(),
            &donor,
            &env.current_contract_address(),
            &amount,
        );

        env.events().publish(
            (symbol_short!("grants"), symbol_short!("donate")),
            (project_id, amount),
        );
        Ok(())
    }

    /// Close `round_id` and distribute the matching pool proportionally to
    /// each project's quadratic weight. Anyone may close after the deadline;
    /// the admin may close at any time.
    pub fn close_round(env: Env, caller: Address, round_id: u32) -> Result<(), Error> {
        let mut round: Round = env
            .storage()
            .persistent()
            .get(&DataKey::Round(round_id))
            .ok_or(Error::RoundNotFound)?;
        if round.closed {
            return Err(Error::RoundClosed);
        }
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(Error::NotAuthorized)?;
        if caller != admin && u64::from(env.ledger().sequence()) <= round.deadline_ledger {
            return Err(Error::RoundOver);
        }
        caller.require_auth();

        // Quadratic weight of every project, in deterministic round order.
        let mut weights: Vec<i128> = Vec::new(&env);
        let mut total_weight: i128 = 0;
        for project_id in round.projects.iter() {
            let project: Project = env
                .storage()
                .persistent()
                .get(&DataKey::Project(project_id))
                .ok_or(Error::ProjectNotFound)?;
            let mut contributions: Vec<i128> = Vec::new(&env);
            for donor in project.donor_order.iter() {
                contributions.push_back(project.contributions.get(donor).unwrap_or(0));
            }
            let weight = Self::quadratic_match(&env, &contributions)?;
            weights.push_back(weight);
            total_weight = total_weight
                .checked_add(weight)
                .ok_or(Error::ArithmeticError)?;
        }

        if total_weight <= 0 {
            // Nobody donated: return the institutional pool to its funder
            // instead of stranding it in the contract.
            token::Client::new(&env, &Self::token(&env)?).transfer(
                &env.current_contract_address(),
                &round.funder,
                &round.matching_pool,
            );
        } else {
            let awards = Self::allocate(&env, round.matching_pool, &weights, total_weight)?;
            for (i, project_id) in round.projects.iter().enumerate() {
                let award = awards.get(i as u32).unwrap();
                if award > 0 {
                    let mut project: Project = env
                        .storage()
                        .persistent()
                        .get(&DataKey::Project(project_id))
                        .ok_or(Error::ProjectNotFound)?;
                    project.match_awarded = project
                        .match_awarded
                        .checked_add(award)
                        .ok_or(Error::ArithmeticError)?;
                    env.storage()
                        .persistent()
                        .set(&DataKey::Project(project_id), &project);
                }
            }
        }

        round.closed = true;
        env.storage()
            .persistent()
            .set(&DataKey::Round(round_id), &round);

        env.events()
            .publish((symbol_short!("grants"), symbol_short!("closed")), round_id);
        Ok(())
    }

    // ── Milestone escrow ────────────────────────────────────────────────────

    /// Add a release milestone to `project_id`. Project owner only.
    pub fn add_milestone(
        env: Env,
        caller: Address,
        project_id: u32,
        description: String,
        amount: i128,
    ) -> Result<(), Error> {
        if description.is_empty() || description.len() > MAX_DESCRIPTION_LEN {
            return Err(Error::InvalidDescription);
        }
        if amount <= 0 {
            return Err(Error::InvalidMilestoneAmount);
        }
        caller.require_auth();

        let mut project: Project = env
            .storage()
            .persistent()
            .get(&DataKey::Project(project_id))
            .ok_or(Error::ProjectNotFound)?;
        if caller != project.owner {
            return Err(Error::NotAuthorized);
        }
        if project.milestones.len() >= MAX_MILESTONES {
            return Err(Error::TooManyMilestones);
        }

        project.milestones.push_back(Milestone {
            description,
            amount,
            approved: false,
        });
        env.storage()
            .persistent()
            .set(&DataKey::Project(project_id), &project);

        env.events().publish(
            (symbol_short!("grants"), symbol_short!("milestone")),
            (project_id, amount),
        );
        Ok(())
    }

    /// Release milestone `index` of `project_id` to its owner. Admin only.
    /// Releasing beyond the project's escrow fails as `InsufficientEscrow`,
    /// protecting donor capital from a project out-promising its funding.
    pub fn approve_milestone(
        env: Env,
        caller: Address,
        project_id: u32,
        index: u32,
    ) -> Result<(), Error> {
        Self::require_admin(&env, &caller)?;

        let mut project: Project = env
            .storage()
            .persistent()
            .get(&DataKey::Project(project_id))
            .ok_or(Error::ProjectNotFound)?;
        if project.refunded {
            return Err(Error::AlreadyResolved);
        }
        let mut milestone: Milestone = project
            .milestones
            .get(index)
            .ok_or(Error::MilestoneNotFound)?;
        if milestone.approved {
            return Err(Error::MilestoneAlreadyApproved);
        }

        let escrow = project
            .total_contributed
            .checked_add(project.match_awarded)
            .ok_or(Error::ArithmeticError)?;
        let released_next = project
            .released
            .checked_add(milestone.amount)
            .ok_or(Error::ArithmeticError)?;
        if released_next > escrow {
            return Err(Error::InsufficientEscrow);
        }

        milestone.approved = true;
        project.milestones.set(index, milestone.clone());
        project.released = released_next;
        env.storage()
            .persistent()
            .set(&DataKey::Project(project_id), &project);

        token::Client::new(&env, &Self::token(&env)?).transfer(
            &env.current_contract_address(),
            &project.owner,
            &milestone.amount,
        );

        env.events().publish(
            (symbol_short!("grants"), symbol_short!("released")),
            (project_id, milestone.amount),
        );
        Ok(())
    }

    // ── Flagging and disputes ───────────────────────────────────────────────

    /// Flag `project_id` as potentially fraudulent. Verified flaggers only,
    /// one flag each, never the project's own owner.
    pub fn flag_project(env: Env, flagger: Address, project_id: u32) -> Result<(), Error> {
        flagger.require_auth();
        if !Self::is_verified(env.clone(), flagger.clone()) {
            return Err(Error::NotVerified);
        }

        let mut project: Project = env
            .storage()
            .persistent()
            .get(&DataKey::Project(project_id))
            .ok_or(Error::ProjectNotFound)?;
        if flagger == project.owner {
            return Err(Error::SelfContribution);
        }
        if project.refunded {
            return Err(Error::AlreadyResolved);
        }
        if project.flags.contains(&flagger) {
            return Err(Error::AlreadyFlagged);
        }
        if project.flags.len() >= MAX_FLAGS {
            return Err(Error::TooManyFlags);
        }

        project.flags.push_back(flagger.clone());
        project.flagged = true;
        env.storage()
            .persistent()
            .set(&DataKey::Project(project_id), &project);

        env.events().publish(
            (symbol_short!("grants"), symbol_short!("flag")),
            (project_id, flagger),
        );
        Ok(())
    }

    /// Resolve a flag on `project_id`. Admin only. A non-fraudulent ruling
    /// simply clears the flag. A fraudulent ruling freezes the project: the
    /// donated share of unspent escrow is refunded to donors pro rata and
    /// the institutional share returns to the round's funder.
    pub fn resolve_dispute(
        env: Env,
        caller: Address,
        project_id: u32,
        fraudulent: bool,
    ) -> Result<(), Error> {
        Self::require_admin(&env, &caller)?;

        let mut project: Project = env
            .storage()
            .persistent()
            .get(&DataKey::Project(project_id))
            .ok_or(Error::ProjectNotFound)?;
        if !project.flagged {
            return Err(Error::NotFlagged);
        }
        if project.refunded {
            return Err(Error::AlreadyResolved);
        }

        if !fraudulent {
            project.flagged = false;
            env.storage()
                .persistent()
                .set(&DataKey::Project(project_id), &project);
            env.events().publish(
                (symbol_short!("grants"), symbol_short!("dispute")),
                (project_id, 0u32),
            );
            return Ok(());
        }

        let escrow = project
            .total_contributed
            .checked_add(project.match_awarded)
            .ok_or(Error::ArithmeticError)?;
        let remaining = escrow
            .checked_sub(project.released)
            .ok_or(Error::ArithmeticError)?;

        // Split the unspent escrow: donations back to donors, the matched
        // institutional portion back to the round funder.
        let donation_share = if escrow > 0 {
            remaining
                .checked_mul(project.total_contributed)
                .ok_or(Error::ArithmeticError)?
                / escrow
        } else {
            0
        };
        let funder_share = remaining
            .checked_sub(donation_share)
            .ok_or(Error::ArithmeticError)?;

        let refunds = Self::pro_rata(&env, &project, donation_share)?;
        let token_client = token::Client::new(&env, &Self::token(&env)?);
        for (i, donor) in project.donor_order.iter().enumerate() {
            let refund = refunds.get(i as u32).unwrap();
            if refund > 0 {
                token_client.transfer(&env.current_contract_address(), &donor, &refund);
            }
        }
        if funder_share > 0 {
            let round: Round = env
                .storage()
                .persistent()
                .get(&DataKey::Round(project.round_id))
                .ok_or(Error::RoundNotFound)?;
            token_client.transfer(
                &env.current_contract_address(),
                &round.funder,
                &funder_share,
            );
        }

        project.refunded = true;
        project.flagged = false;
        env.storage()
            .persistent()
            .set(&DataKey::Project(project_id), &project);

        env.events().publish(
            (symbol_short!("grants"), symbol_short!("fraud")),
            (project_id, remaining),
        );
        Ok(())
    }

    // ── Internals ───────────────────────────────────────────────────────────

    fn token(env: &Env) -> Result<Address, Error> {
        env.storage()
            .instance()
            .get(&DataKey::Token)
            .ok_or(Error::ArithmeticError)
    }

    fn require_admin(env: &Env, caller: &Address) -> Result<(), Error> {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(Error::NotAuthorized)?;
        if caller != &admin {
            return Err(Error::NotAuthorized);
        }
        caller.require_auth();
        Ok(())
    }

    /// Integer square root of `n` via Newton's method.
    fn isqrt(n: u128) -> u128 {
        if n == 0 {
            return 0;
        }
        let mut x = n;
        let mut y = (x + 1) / 2;
        while y < x {
            x = y;
            y = (x + n / x) / 2;
        }
        x
    }

    /// Quadratic weight of a project: `(sum sqrt(c_i))^2` in token units.
    /// Contributions re-aggregate per donor, so one donor contributes exactly
    /// one `sqrt` term — puppet accounts cannot inflate a project's weight.
    fn quadratic_match(env: &Env, contributions: &Vec<i128>) -> Result<i128, Error> {
        if contributions.is_empty() {
            return Ok(0);
        }
        let mut sum_sq: u128 = 0;
        let mut sum_c: u128 = 0;
        for c in contributions.iter() {
            if c <= 0 {
                return Err(Error::ZeroAmount);
            }
            if c > MAX_CONTRIBUTION {
                return Err(Error::ContributionTooLarge);
            }
            let cu = c as u128;
            sum_c = sum_c.checked_add(cu).ok_or(Error::ArithmeticError)?;
            let scaled = cu.checked_mul(SCALE_SQ).ok_or(Error::ArithmeticError)?;
            sum_sq = sum_sq
                .checked_add(Self::isqrt(scaled))
                .ok_or(Error::ArithmeticError)?;
        }
        // W = (sum sqrt(c_i))^2  ≈  sum_sq^2 / SCALE_SQ  (floored, never over-matches)
        let weight = sum_sq
            .checked_mul(sum_sq)
            .ok_or(Error::ArithmeticError)?
            .checked_div(SCALE_SQ)
            .ok_or(Error::ArithmeticError)?;
        // Match contribution baseline so a lone donor weights zero:
        // match weight in excess of the raw donations.
        let match_weight = if weight > sum_c { weight - sum_c } else { 0 };
        match_weight.try_into().map_err(|_| Error::ArithmeticError)
    }

    /// Allocate `pool` proportionally to `weights` (floor division plus
    /// largest-remainder distribution), so every pool token is distributed
    /// exactly and in deterministic order.
    fn allocate(
        env: &Env,
        pool: i128,
        weights: &Vec<i128>,
        total_weight: i128,
    ) -> Result<Vec<i128>, Error> {
        if total_weight <= 0 {
            let mut zeroes = Vec::new(env);
            for _ in 0..weights.len() {
                zeroes.push_back(0i128);
            }
            return Ok(zeroes);
        }
        let pool_u = pool as u128;
        let tw_u = total_weight as u128;
        let mut awards: Vec<i128> = Vec::new(env);
        let mut remainders: Vec<u128> = Vec::new(env);
        let mut allocated: u128 = 0;
        for w in weights.iter() {
            let award_u = pool_u
                .checked_mul(w as u128)
                .ok_or(Error::ArithmeticError)?
                .checked_div(tw_u)
                .ok_or(Error::ArithmeticError)?;
            let rem_u = pool_u
                .checked_mul(w as u128)
                .ok_or(Error::ArithmeticError)?
                .checked_rem(tw_u)
                .ok_or(Error::ArithmeticError)?;
            awards.push_back(award_u as i128);
            remainders.push_back(rem_u);
            allocated = allocated
                .checked_add(award_u)
                .ok_or(Error::ArithmeticError)?;
        }
        // Largest-remainder correction: distribute leftover pool tokens to the
        // projects with the largest remainders, in declaration order for ties.
        let mut leftover = pool_u
            .checked_sub(allocated)
            .ok_or(Error::ArithmeticError)?;
        let mut order: Vec<u32> = Vec::new(env);
        for i in 0..weights.len() as u32 {
            order.push_back(i);
        }
        // Sort indices by remainder descending (stable via original order).
        for i in 0..order.len() {
            for j in (i + 1)..order.len() {
                let a = order.get(i).unwrap();
                let b = order.get(j).unwrap();
                if remainders.get(b).unwrap() > remainders.get(a).unwrap() {
                    order.set(i, b);
                    order.set(j, a);
                }
            }
        }
        let mut idx = 0;
        while leftover > 0 && idx < order.len() {
            let p = order.get(idx).unwrap();
            let mut award = awards.get(p).unwrap();
            award = award.checked_add(1).ok_or(Error::ArithmeticError)?;
            awards.set(p, award);
            leftover -= 1;
            idx += 1;
        }
        Ok(awards)
    }

    /// Refund `total` to donors pro rata to their contributions, floored per
    /// donor with largest-remainder correction so the full `total` is paid out.
    fn pro_rata(env: &Env, project: &Project, total: i128) -> Result<Vec<i128>, Error> {
        let n = project.donor_order.len();
        if n == 0 {
            return Ok(Vec::new(env));
        }
        let total_u = total as u128;
        let tc_u = project.total_contributed as u128;
        let mut refunds: Vec<i128> = Vec::new(env);
        let mut remainders: Vec<u128> = Vec::new(env);
        let mut allocated: u128 = 0;
        for donor in project.donor_order.iter() {
            let c = project.contributions.get(donor.clone()).unwrap_or(0) as u128;
            let refund_u = total_u
                .checked_mul(c)
                .ok_or(Error::ArithmeticError)?
                .checked_div(tc_u)
                .ok_or(Error::ArithmeticError)?;
            let rem_u = total_u
                .checked_mul(c)
                .ok_or(Error::ArithmeticError)?
                .checked_rem(tc_u)
                .ok_or(Error::ArithmeticError)?;
            refunds.push_back(refund_u as i128);
            remainders.push_back(rem_u);
            allocated = allocated
                .checked_add(refund_u)
                .ok_or(Error::ArithmeticError)?;
        }
        let mut leftover = total_u
            .checked_sub(allocated)
            .ok_or(Error::ArithmeticError)?;
        let mut idx = 0;
        while leftover > 0 && idx < n {
            let mut refund = refunds.get(idx as u32).unwrap();
            refund = refund.checked_add(1).ok_or(Error::ArithmeticError)?;
            refunds.set(idx as u32, refund);
            leftover -= 1;
            idx += 1;
        }
        Ok(refunds)
    }

    pub fn get_round(env: Env, round_id: u32) -> Option<Round> {
        env.storage().persistent().get(&DataKey::Round(round_id))
    }

    pub fn get_project(env: Env, project_id: u32) -> Option<Project> {
        env.storage()
            .persistent()
            .get(&DataKey::Project(project_id))
    }
}

#[cfg(test)]
mod test;
