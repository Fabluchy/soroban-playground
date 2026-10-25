#![no_std]
use soroban_sdk::{contract, contractimpl, contracttype, Address, BytesN, Env, Vec};

#[contracttype]
#[derive(Clone)]
pub struct MixerState {
    pub root: BytesN<32>,
    pub next_index: u32,
    pub depth: u32,
}

#[contract]
pub struct TokenMixer;

#[contractimpl]
impl TokenMixer {
    pub fn init(env: Env, admin: Address, denomination: i128) {
        env.storage().instance().set(&"admin", &admin);
        env.storage().instance().set(&"denom", &denomination);
        env.storage().instance().set(&"root", &BytesN::<32>::from_array(&env, &[0u8; 32]));
        env.storage().instance().set(&"next", &0u32);
        env.storage().instance().set(&"depth", &20u32);
    }

    pub fn deposit(env: Env, from: Address, commitment: BytesN<32>) {
        from.require_auth();
        let next: u32 = env.storage().instance().get(&"next").unwrap_or(0);
        // store commitment at leaf index
        env.storage().persistent().set(&("leaf", next), &commitment);
        env.storage().instance().set(&"next", &(next + 1));
        // recompute root placeholder (Poseidon not available; keep simple hash chain)
        let mut root = [0u8; 32];
        root[0..4].copy_from_slice(&next.to_be_bytes());
        env.storage().instance().set(&"root", &BytesN::<32>::from_array(&env, &root));
    }

    pub fn withdraw(env: Env, nullifier: BytesN<32>, recipient: Address, fee: i128) {
        // prevent double spend
        if env.storage().persistent().has(&("null", nullifier.clone())) {
            panic!("nullifier used");
        }
        env.storage().persistent().set(&("null", nullifier), &true);
        // relayer fee deducted atomically (placeholder)
        let _ = fee;
        let _ = recipient;
    }

    pub fn get_root(env: Env) -> BytesN<32> {
        env.storage().instance().get(&"root").unwrap()
    }

    pub fn is_nullifier_used(env: Env, nullifier: BytesN<32>) -> bool {
        env.storage().persistent().has(&("null", nullifier))
    }
}
