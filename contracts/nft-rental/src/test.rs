// Copyright (c) 2026 StellarDevTools
// SPDX-License-Identifier: MIT

#![cfg(test)]

use super::*;
use soroban_sdk::{testutils::Address as _, testutils::Ledger as _, Env};

fn setup() -> (Env, NFTRentalClient<'static>, Address, Address, Address) {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register_contract(None, NFTRental);
    let client = NFTRentalClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    let owner = Address::generate(&env);
    let renter = Address::generate(&env);

    client.initialize(&admin);
    (env, client, admin, owner, renter)
}

#[test]
fn test_role_separation_and_delegation() {
    let (env, client, _admin, owner, renter) = setup();
    let token_id = 1u64;

    client.mint_nft(&owner, &token_id);
    assert_eq!(client.owner_of(&token_id), owner);
    assert_eq!(client.user_of(&token_id), owner); // Defaults to owner

    // Owner delegates user rights to renter for 100 ledgers
    let cur_ledger = env.ledger().sequence();
    let expire_ledger = cur_ledger + 100;
    client.set_user(&owner, &token_id, &renter, &expire_ledger);

    // Roles are cleanly separated: owner is still owner, user is renter
    assert_eq!(client.owner_of(&token_id), owner);
    assert_eq!(client.user_of(&token_id), renter);
    assert_eq!(client.user_expires(&token_id), expire_ledger);
}

#[test]
fn test_renter_cannot_transfer_or_sublease() {
    let (env, client, _admin, owner, renter) = setup();
    let token_id = 2u64;
    let malicious_third_party = Address::generate(&env);

    client.mint_nft(&owner, &token_id);
    let expire_ledger = env.ledger().sequence() + 100;
    client.set_user(&owner, &token_id, &renter, &expire_ledger);

    // Renter attempts to transfer legal ownership of NFT -> must fail
    assert!(client
        .try_transfer_ownership(&renter, &malicious_third_party, &token_id)
        .is_err());

    // Renter attempts to sub-lease or delegate user role to someone else -> must fail
    assert!(client
        .try_set_user(
            &renter,
            &token_id,
            &malicious_third_party,
            &(expire_ledger + 50)
        )
        .is_err());

    // Legal owner is still intact
    assert_eq!(client.owner_of(&token_id), owner);
}

#[test]
fn test_automated_expiration_without_transaction() {
    let (env, client, _admin, owner, renter) = setup();
    let token_id = 3u64;

    client.mint_nft(&owner, &token_id);
    let cur_ledger = env.ledger().sequence();
    let expire_ledger = cur_ledger + 50;
    client.set_user(&owner, &token_id, &renter, &expire_ledger);

    assert_eq!(client.user_of(&token_id), renter);

    // Advance ledger past expiration: no transactions submitted by owner
    env.ledger().set_sequence_number(expire_ledger + 1);

    // User rights automatically reverted back to owner on-chain with zero gas from owner!
    assert_eq!(client.user_of(&token_id), owner);
    assert_eq!(client.user_expires(&token_id), 0);
}

#[test]
fn test_listing_and_instant_cancellation() {
    let (_env, client, _admin, owner, _renter) = setup();
    let token_id = 4u64;

    client.mint_nft(&owner, &token_id);

    // List for rent: 100 per ledger, min duration 10, max duration 100
    client.list_rental(&owner, &token_id, &100, &10, &100);
    let listing = client.get_listing(&token_id);
    assert!(listing.is_active);
    assert_eq!(listing.price_per_ledger, 100);

    // Owner cancels listing before anyone rents it
    client.cancel_listing(&owner, &token_id);
    assert!(client.try_get_listing(&token_id).is_err());
}

#[test]
fn test_escrow_deposit_and_lease_initiation_payment() {
    let (env, client, _admin, owner, renter) = setup();
    let token_id = 5u64;

    client.mint_nft(&owner, &token_id);
    client.list_rental(&owner, &token_id, &10, &5, &50); // 10 per ledger

    // Fund renter with simulated stablecoin
    client.deposit_balance(&renter, &1_000);
    assert_eq!(client.get_balance(&renter), 1_000);
    assert_eq!(client.get_balance(&owner), 0);

    // Renter rents for 20 ledgers -> 20 * 10 = 200 fee
    client.rent_nft(&renter, &token_id, &20, &200);

    // Renter balance deducted, owner balance accurately credited upon lease initiation
    assert_eq!(client.get_balance(&renter), 800);
    assert_eq!(client.get_balance(&owner), 200);

    // User role delegated
    assert_eq!(client.user_of(&token_id), renter);
    assert_eq!(client.user_expires(&token_id), env.ledger().sequence() + 20);
}
