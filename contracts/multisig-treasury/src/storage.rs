#![no_std]

use soroban_sdk::{Address, Bytes, Env, Vec};
use crate::types::{DataKey, Error, InstanceKey, Proposal, ProposalStatus};

// ── Initialisation guards ─────────────────────────────────────────────────────

pub fn is_initialized(env: &Env) -> bool {
    env.storage().instance().has(&InstanceKey::Initialized)
}

pub fn set_initialized(env: &Env) {
    env.storage().instance().set(&InstanceKey::Initialized, &true);
}

// ── Config ────────────────────────────────────────────────────────────────────

pub fn get_threshold(env: &Env) -> u32 {
    env.storage()
        .instance()
        .get(&InstanceKey::Threshold)
        .unwrap_or(1)
}

pub fn set_threshold(env: &Env, m: u32) {
    env.storage().instance().set(&InstanceKey::Threshold, &m);
}

pub fn get_time_lock(env: &Env) -> u64 {
    env.storage()
        .instance()
        .get(&InstanceKey::TimeLock)
        .unwrap_or(0)
}

pub fn set_time_lock(env: &Env, seconds: u64) {
    env.storage().instance().set(&InstanceKey::TimeLock, &seconds);
}

pub fn get_high_value_threshold(env: &Env) -> i128 {
    env.storage()
        .instance()
        .get(&InstanceKey::HighValueThreshold)
        .unwrap_or(0)
}

pub fn set_high_value_threshold(env: &Env, amount: i128) {
    env.storage()
        .instance()
        .set(&InstanceKey::HighValueThreshold, &amount);
}

// ── Pause ─────────────────────────────────────────────────────────────────────

pub fn get_guardian(env: &Env) -> Result<Address, Error> {
    env.storage()
        .instance()
        .get(&InstanceKey::Guardian)
        .ok_or(Error::NotInitialized)
}

pub fn set_guardian(env: &Env, guardian: &Address) {
    env.storage().instance().set(&InstanceKey::Guardian, guardian);
}

pub fn is_paused(env: &Env) -> bool {
    env.storage()
        .instance()
        .get(&InstanceKey::Paused)
        .unwrap_or(false)
}

pub fn set_paused(env: &Env, paused: bool) {
    env.storage().instance().set(&InstanceKey::Paused, &paused);
}

// ── Signers ───────────────────────────────────────────────────────────────────

pub fn get_signer_count(env: &Env) -> u32 {
    env.storage()
        .instance()
        .get(&InstanceKey::SignerCount)
        .unwrap_or(0)
}

fn set_signer_count(env: &Env, count: u32) {
    env.storage().instance().set(&InstanceKey::SignerCount, &count);
}

pub fn is_signer(env: &Env, addr: &Address) -> bool {
    env.storage()
        .persistent()
        .get(&DataKey::IsSigner(addr.clone()))
        .unwrap_or(false)
}

pub fn add_signer(env: &Env, addr: &Address, pubkey: &Bytes) {
    let count = get_signer_count(env);
    env.storage()
        .persistent()
        .set(&DataKey::SignerAt(count), addr);
    env.storage()
        .persistent()
        .set(&DataKey::IsSigner(addr.clone()), &true);
    env.storage()
        .persistent()
        .set(&DataKey::SignerPubkey(addr.clone()), pubkey);
    env.storage()
        .persistent()
        .set(&DataKey::SignerNonce(addr.clone()), &0u64);
    set_signer_count(env, count + 1);
}

pub fn get_signer_pubkey(env: &Env, addr: &Address) -> Result<Bytes, Error> {
    env.storage()
        .persistent()
        .get(&DataKey::SignerPubkey(addr.clone()))
        .ok_or(Error::MissingPubkey)
}

pub fn get_signer_nonce(env: &Env, addr: &Address) -> u64 {
    env.storage()
        .persistent()
        .get(&DataKey::SignerNonce(addr.clone()))
        .unwrap_or(0)
}

pub fn increment_signer_nonce(env: &Env, addr: &Address) {
    let nonce = get_signer_nonce(env, addr);
    env.storage()
        .persistent()
        .set(&DataKey::SignerNonce(addr.clone()), &(nonce + 1));
}

// ── Proposals ─────────────────────────────────────────────────────────────────

pub fn get_proposal_count(env: &Env) -> u32 {
    env.storage()
        .instance()
        .get(&InstanceKey::ProposalCount)
        .unwrap_or(0)
}

pub fn increment_proposal_count(env: &Env) -> u32 {
    let count = get_proposal_count(env);
    env.storage()
        .instance()
        .set(&InstanceKey::ProposalCount, &(count + 1));
    count
}

pub fn save_proposal(env: &Env, proposal: &Proposal) {
    env.storage()
        .persistent()
        .set(&DataKey::Proposal(proposal.id), proposal);
}

pub fn get_proposal(env: &Env, id: u32) -> Result<Proposal, Error> {
    env.storage()
        .persistent()
        .get(&DataKey::Proposal(id))
        .ok_or(Error::ProposalNotFound)
}

pub fn has_signed(env: &Env, proposal_id: u32, signer: &Address) -> bool {
    env.storage()
        .persistent()
        .get(&DataKey::HasSigned(proposal_id, signer.clone()))
        .unwrap_or(false)
}

pub fn mark_signed(env: &Env, proposal_id: u32, signer: &Address) {
    env.storage()
        .persistent()
        .set(&DataKey::HasSigned(proposal_id, signer.clone()), &true);
}
