#![cfg(test)]

//! Tests for the quadratic funding grant protocol (issue #1837).

use crate::{Error, QuadraticGrants, QuadraticGrantsClient};
use soroban_sdk::{
    testutils::Address as _,
    token::{Client as TokenClient, StellarAssetClient},
    Address, Env, String,
};

// ── Harness ─────────────────────────────────────────────────────────────────

struct Harness {
    env: Env,
    admin: Address,
    funder: Address,
    token_id: Address,
    client: QuadraticGrantsClient<'static>,
    token: TokenClient<'static>,
}

impl Harness {
    fn new() -> Self {
        let env = Env::default();
        env.mock_all_auths();

        let admin = Address::generate(&env);
        let funder = Address::generate(&env);
        let token_admin = Address::generate(&env);
        let token_id = env
            .register_stellar_asset_contract_v2(token_admin.clone())
            .address();
        let token = TokenClient::new(&env, &token_id);

        let contract_id = env.register_contract(None, QuadraticGrants);
        let client = QuadraticGrantsClient::new(&env, &contract_id);
        client.initialize(&admin, &token_id);

        StellarAssetClient::new(&env, &token_id).mint(&funder, &i128::MAX);
        token.approve(&funder, &contract_id, &i128::MAX, &0);

        Self {
            env,
            admin,
            funder,
            token_id,
            client,
            token,
        }
    }

    fn verified(&self, who: &Address) {
        self.client.set_verified(&self.admin, &who);
    }

    fn create_round(&self, matching_pool: i128, deadline: u64) -> u32 {
        self.client
            .create_round(&self.funder, &deadline, &matching_pool)
    }

    fn register_project(&self, owner: &Address, round_id: u32, name: &str) -> u32 {
        self.client
            .register_project(owner, &round_id, &String::from_str(&self.env, name))
    }

    fn contribute(&self, donor: &Address, project_id: u32, amount: i128) {
        StellarAssetClient::new(&self.env, &self.token_id).mint(donor, &amount);
        self.token.approve(donor, &self.client.address, &amount, &0);
        self.client.contribute(donor, &project_id, &amount);
    }

    fn close_round(&self, round_id: u32, caller: &Address) {
        self.client.close_round(caller, &round_id);
    }

    fn match_awarded(&self, project_id: u32) -> i128 {
        self.client.get_project(&project_id).unwrap().match_awarded
    }

    fn balance(&self, who: &Address) -> i128 {
        self.token.balance(who)
    }

    fn escrow_balance(&self) -> i128 {
        self.token.balance(&self.client.address)
    }
}
// ── Initialization & credentials ────────────────────────────────────────────

#[test]
fn initializes_once() {
    let h = Harness::new();
    assert_eq!(
        h.client.try_initialize(&h.admin, &h.token_id),
        Err(Ok(Error::AlreadyInitialized))
    );
}

#[test]
fn credential_gates_donations() {
    let h = Harness::new();
    let owner = Address::generate(&h.env);
    let donor = Address::generate(&h.env);
    let round_id = h.create_round(1_000, 1000);
    let project_id = h.register_project(&owner, round_id, "Green");

    assert_eq!(
        h.client.try_contribute(&donor, &project_id, &100),
        Err(Ok(Error::NotVerified))
    );

    h.verified(&donor);
    h.contribute(&donor, project_id, 100);
    assert_eq!(
        h.client.get_project(&project_id).unwrap().total_contributed,
        100
    );
}

// ── Quadratic matching formula ──────────────────────────────────────────────

#[test]
fn single_donor_receives_no_match() {
    let h = Harness::new();
    let owner = Address::generate(&h.env);
    let donor = Address::generate(&h.env);
    h.verified(&donor);
    let round_id = h.create_round(10_000, 1000);
    let project_id = h.register_project(&owner, round_id, "Solo");
    h.contribute(&donor, project_id, 400);

    h.close_round(round_id, &h.admin);
    assert_eq!(h.match_awarded(project_id), 0);
}

#[test]
fn broad_support_wins_more_match() {
    let h = Harness::new();
    let owner = Address::generate(&h.env);

    let d1 = Address::generate(&h.env);
    let d2 = Address::generate(&h.env);
    h.verified(&d1);
    h.verified(&d2);
    let d3 = Address::generate(&h.env);
    h.verified(&d3);

    let round_id = h.create_round(1_000, 1000);
    let pa = h.register_project(&owner, round_id, "A");
    let pb = h.register_project(&owner, round_id, "B");

    h.contribute(&d1, pa, 100);
    h.contribute(&d2, pa, 100);
    h.contribute(&d3, pb, 400);

    h.close_round(round_id, &h.admin);

    assert_eq!(h.match_awarded(pa), 1_000);
    assert_eq!(h.match_awarded(pb), 0);
}

// ── Close round distributes the full pool ───────────────────────────────────

#[test]
fn close_round_allocates_entire_pool() {
    let h = Harness::new();
    let owner = Address::generate(&h.env);
    let d1 = Address::generate(&h.env);
    let d2 = Address::generate(&h.env);
    let d3 = Address::generate(&h.env);
    let d4 = Address::generate(&h.env);
    h.verified(&d1);
    h.verified(&d2);
    h.verified(&d3);
    h.verified(&d4);

    let round_id = h.create_round(1_000, 1000);
    let pa = h.register_project(&owner, round_id, "A");
    let pb = h.register_project(&owner, round_id, "B");

    h.contribute(&d1, pa, 100);
    h.contribute(&d2, pa, 100);
    h.contribute(&d3, pb, 100);
    h.contribute(&d4, pb, 100);

    h.close_round(round_id, &h.admin);

    assert_eq!(h.match_awarded(pa), 500);
    assert_eq!(h.match_awarded(pb), 500);
    // Donations and the matching award stay escrowed until milestones release.
    assert_eq!(h.escrow_balance(), 1_400);
}

#[test]
fn nobody_donated_pool_returned_escrow_zero() {
    let h = Harness::new();
    let owner = Address::generate(&h.env);
    let round_id = h.create_round(1_000, 1000);
    h.register_project(&owner, round_id, "Empty");

    h.close_round(round_id, &h.admin);
    assert_eq!(h.escrow_balance(), 0);
    assert_eq!(h.client.get_round(&round_id).unwrap().closed, true);
    // The unallocated pool is refunded, so the funder is made whole.
    assert_eq!(h.balance(&h.funder), i128::MAX);
}

// ── Access control & round lifecycle ────────────────────────────────────────

#[test]
fn only_verified_can_verify_others() {
    let h = Harness::new();
    let stranger = Address::generate(&h.env);
    assert_eq!(
        h.client.try_set_verified(&stranger, &stranger),
        Err(Ok(Error::NotAuthorized))
    );
}

#[test]
fn cannot_contribute_to_closed_round() {
    let h = Harness::new();
    let owner = Address::generate(&h.env);
    let donor = Address::generate(&h.env);
    h.verified(&donor);
    let round_id = h.create_round(1_000, 1000);
    let project_id = h.register_project(&owner, round_id, "X");
    h.contribute(&donor, project_id, 100);

    h.close_round(round_id, &h.admin);

    assert_eq!(
        h.client.try_contribute(&donor, &project_id, &100),
        Err(Ok(Error::RoundClosed))
    );
}

#[test]
fn self_contribution_rejected() {
    let h = Harness::new();
    let owner = Address::generate(&h.env);
    h.verified(&owner);
    let round_id = h.create_round(1_000, 1000);
    let project_id = h.register_project(&owner, round_id, "X");
    assert_eq!(
        h.client.try_contribute(&owner, &project_id, &100),
        Err(Ok(Error::SelfContribution))
    );
}

// ── Milestone escrow ────────────────────────────────────────────────────────

#[test]
fn milestone_release_limited_to_escrow() {
    let h = Harness::new();
    let owner = Address::generate(&h.env);
    let donor = Address::generate(&h.env);
    h.verified(&donor);
    let round_id = h.create_round(10_000, 1000);
    let project_id = h.register_project(&owner, round_id, "M");
    h.contribute(&donor, project_id, 100);

    // No matching awarded yet (single donor -> weight 0), escrow = 100.
    h.close_round(round_id, &h.admin);

    // Two milestones of 60 each -> escrow 100 covers both.
    h.client
        .add_milestone(&owner, &project_id, &String::from_str(&h.env, "m1"), &60);
    h.client.approve_milestone(&h.admin, &project_id, &0);
    assert_eq!(h.balance(&owner), 60);

    h.client
        .add_milestone(&owner, &project_id, &String::from_str(&h.env, "m2"), &60);
    // Escrow remaining = 40, requesting 60 -> InsufficientEscrow.
    assert_eq!(
        h.client
            .try_add_milestone(&owner, &project_id, &String::from_str(&h.env, "m2"), &60),
        Ok(Ok(()))
    );
    assert_eq!(
        h.client.try_approve_milestone(&h.admin, &project_id, &1),
        Err(Ok(Error::InsufficientEscrow))
    );
}

// ── Flagging & disputes ─────────────────────────────────────────────────────

#[test]
fn fraud_refunds_donors_pro_rata_and_funder_share() {
    let h = Harness::new();
    let owner = Address::generate(&h.env);
    let d1 = Address::generate(&h.env);
    let d2 = Address::generate(&h.env);
    h.verified(&d1);
    h.verified(&d2);

    let round_id = h.create_round(1_000, 1000);
    let project_id = h.register_project(&owner, round_id, "Fraud");

    // d1 gives 100, d2 gives 300 -> total_contributed 400.
    h.contribute(&d1, project_id, 100);
    h.contribute(&d2, project_id, 300);
    h.close_round(round_id, &h.admin);

    // Escrow = 400 (donations) + match award. Flag + resolve as fraudulent.
    h.client.flag_project(&d1, &project_id);
    h.client.resolve_dispute(&h.admin, &project_id, &true);

    // Nothing released, so remaining escrow = 400. Donation share = all 400.
    // Pro rata: d1 -> 100, d2 -> 300.
    assert_eq!(h.balance(&d1), 100);
    assert_eq!(h.balance(&d2), 300);
    assert_eq!(h.escrow_balance(), 0);
    assert!(h.client.get_project(&project_id).unwrap().refunded);
}

#[test]
fn non_fraudulent_ruling_clears_flag_without_refund() {
    let h = Harness::new();
    let owner = Address::generate(&h.env);
    let donor = Address::generate(&h.env);
    h.verified(&donor);
    let round_id = h.create_round(1_000, 1000);
    let project_id = h.register_project(&owner, round_id, "Ok");

    h.contribute(&donor, project_id, 100);
    h.close_round(round_id, &h.admin);

    h.client.flag_project(&donor, &project_id);
    h.client.resolve_dispute(&h.admin, &project_id, &false);

    assert!(!h.client.get_project(&project_id).unwrap().flagged);
    assert!(!h.client.get_project(&project_id).unwrap().refunded);
    assert_eq!(h.escrow_balance(), 100);
}
