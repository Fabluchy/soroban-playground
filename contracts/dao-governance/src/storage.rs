#![no_std]
use soroban_sdk::{contracttype, Address, Env};

use crate::types::{DelegationRecord, Proposal, VoteRecord};

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Admin,
    TokenContract,
    MinDeposit,
    VotingPeriod,
    TimelockDelay,
    ProposalCount,
    Proposal(u32),
    VoteRecord(u32, Address),
    Delegation(Address),
    SoulboundBadge(Address),
    Paused,
}

pub fn get_proposal(env: &Env, id: u32) -> Option<Proposal> {
    env.storage().persistent().get(&DataKey::Proposal(id))
}

pub fn set_proposal(env: &Env, proposal: &Proposal) {
    let key = DataKey::Proposal(proposal.id);
    env.storage().persistent().set(&key, proposal);
    env.storage()
        .persistent()
        .extend_ttl(&key, 100_000, 200_000);
}

pub fn get_vote(env: &Env, proposal_id: u32, voter: &Address) -> Option<VoteRecord> {
    env.storage()
        .persistent()
        .get(&DataKey::VoteRecord(proposal_id, voter.clone()))
}

pub fn set_vote(env: &Env, proposal_id: u32, voter: &Address, record: &VoteRecord) {
    let key = DataKey::VoteRecord(proposal_id, voter.clone());
    env.storage().persistent().set(&key, record);
    env.storage()
        .persistent()
        .extend_ttl(&key, 100_000, 200_000);
}

pub fn get_delegation(env: &Env, voter: &Address) -> Option<DelegationRecord> {
    env.storage()
        .temporary()
        .get(&DataKey::Delegation(voter.clone()))
}

pub fn set_delegation(env: &Env, voter: &Address, record: &DelegationRecord) {
    let key = DataKey::Delegation(voter.clone());
    env.storage().temporary().set(&key, record);
    env.storage()
        .temporary()
        .extend_ttl(&key, 100_000, 200_000);
}

pub fn remove_delegation(env: &Env, voter: &Address) {
    env.storage()
        .temporary()
        .remove(&DataKey::Delegation(voter.clone()));
}

pub fn has_soulbound_badge(env: &Env, addr: &Address) -> bool {
    env.storage()
        .persistent()
        .get::<_, bool>(&DataKey::SoulboundBadge(addr.clone()))
        .unwrap_or(false)
}

pub fn grant_badge(env: &Env, addr: &Address) {
    let key = DataKey::SoulboundBadge(addr.clone());
    env.storage().persistent().set(&key, &true);
    env.storage()
        .persistent()
        .extend_ttl(&key, 100_000, 200_000);
}

pub fn revoke_badge(env: &Env, addr: &Address) {
    env.storage()
        .persistent()
        .remove(&DataKey::SoulboundBadge(addr.clone()));
}

pub fn is_paused(env: &Env) -> bool {
    env.storage()
        .instance()
        .get::<_, bool>(&DataKey::Paused)
        .unwrap_or(false)
}
