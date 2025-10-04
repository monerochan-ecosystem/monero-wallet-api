use std_shims::{collections::HashSet, string::ToString, vec::Vec};

use rand_core::{CryptoRng, RngCore};
use rand::seq::IteratorRandom;

use rand_distr::{Distribution, Gamma};

use curve25519_dalek::{EdwardsPoint};

use monero_oxide::{
  primitives::{Decoys},
  transaction::Transaction,
  BLOCK_TIME, COINBASE_LOCK_WINDOW, DEFAULT_LOCK_WINDOW,
};
use monero_wallet::{
  rpc::{OutputInformation, RpcError},
  transaction::Timelock,
  OutputWithDecoys, WalletOutput,
};

const RECENT_WINDOW: u64 = 15;
const BLOCKS_PER_YEAR: usize = (365 * 24 * 60 * 60) / BLOCK_TIME;
#[allow(clippy::cast_precision_loss)]
const TIP_APPLICATION: f64 = (DEFAULT_LOCK_WINDOW * BLOCK_TIME) as f64;
/// Samples candidates for decoys for an output being spent.
/// This is a lower-level function which expects the distribution to be provided by the node.
/// Sampling will stop if it cannot find enough candidates in 1000 iterations.
/// (There is no need to sample significantly more than the 15 decoys required for a ring)
fn sample_candidates(
  rng: &mut (impl RngCore + CryptoRng),
  output_being_spent_index: u64,
  distribution: &[u64],
  candidates_len: usize,
) -> Result<Vec<u64>, RpcError> {
  let mut candidates = Vec::with_capacity(candidates_len);
  if distribution.len() < DEFAULT_LOCK_WINDOW {
    Err(RpcError::InternalError("not enough blocks to select decoys".to_string()))?;
  }
  let highest_output_exclusive_bound = distribution[distribution.len() - DEFAULT_LOCK_WINDOW];
  // This assumes that each miner TX had one output (as sane) and checks we have sufficient
  // outputs even when excluding them (due to their own timelock requirements)
  // Considering this a temporal error for very new chains, it's sufficiently sane to have
  if highest_output_exclusive_bound.saturating_sub(
    u64::try_from(COINBASE_LOCK_WINDOW).expect("coinbase lock window exceeds 2^{64}"),
  ) < candidates_len as u64
  {
    Err(RpcError::InternalError("not enough decoy candidates".to_string()))?;
  }

  // Determine the outputs per second
  #[allow(clippy::cast_precision_loss)]
  let per_second = {
    let blocks = distribution.len().min(BLOCKS_PER_YEAR);
    let initial = distribution[distribution.len().saturating_sub(blocks + 1)];
    let outputs = distribution[distribution.len() - 1].saturating_sub(initial);
    (outputs as f64) / ((blocks * BLOCK_TIME) as f64)
  };

  // Don't select the real output
  let mut do_not_select = HashSet::new();
  do_not_select.insert(output_being_spent_index);
  let mut iters = 0;

  while candidates.len() <= candidates_len {
    {
      iters += 1;
      #[cfg(not(test))]
      const MAX_ITERS: usize = 1000;
      // When testing on fresh chains, increased iterations can be useful and we don't necessitate
      // reasonable performance
      #[cfg(test)]
      const MAX_ITERS: usize = 10000;
      // Ensure this isn't infinitely looping
      // We check both that we aren't at the maximum amount of iterations and that the not-yet
      // selected candidates exceed the amount of candidates necessary to trigger the next iteration
      if (iters == MAX_ITERS)
        || ((highest_output_exclusive_bound
          - u64::try_from(do_not_select.len()).expect("amount of ignored decoys exceeds 2^{64}"))
          < candidates_len as u64)
      {
        Err(RpcError::InternalError("hit decoy selection round limit".to_string()))?;
      }
    }
    // Use a gamma distribution, as Monero does
    // https://github.com/monero-project/monero/blob/cc73fe71162d564ffda8e549b79a350bca53c45
    //   /src/wallet/wallet2.cpp#L142-L143
    let mut age = Gamma::<f64>::new(19.28, 1.0 / 1.61)
      .expect("constant Gamma distribution could no longer be created")
      .sample(rng)
      .exp();
    #[allow(clippy::cast_precision_loss)]
    if age > TIP_APPLICATION {
      age -= TIP_APPLICATION;
    } else {
      // f64 does not have try_from available, which is why these are written with `as`
      age = (rng.next_u64()
        % (RECENT_WINDOW * u64::try_from(BLOCK_TIME).expect("BLOCK_TIME exceeded u64::MAX")))
        as f64;
    }

    #[allow(clippy::cast_sign_loss, clippy::cast_possible_truncation)]
    let o: u64 = (age * per_second) as u64;
    if o < highest_output_exclusive_bound {
      // Find which block this points to
      let i = distribution.partition_point(|s| *s < (highest_output_exclusive_bound - 1 - o));
      let prev = i.saturating_sub(1);
      let n = distribution[i].checked_sub(distribution[prev]).ok_or_else(|| {
        RpcError::InternalError("RPC returned non-monotonic distribution".to_string())
      })?;
      if n != 0 {
        // Select an output from within this block
        let o = distribution[prev] + (rng.next_u64() % n);
        if !do_not_select.contains(&o) {
          candidates.push(o);
          // This output will either be used or is unusable
          // In either case, we should not try it again
          do_not_select.insert(o);
        }
      }
    }
  }
  candidates.push(output_being_spent_index);
  // Sort candidates so the real spends aren't the ones at the end
  candidates.sort();

  Ok(candidates)
}
/// Filters the outputs returned by the RPC to only those which are usable as decoys.
/// This includes checking that the output is unlocked, that it matches the key and commitment
/// of the output being spent (for the real spend), to ensure the node is responding honestly
fn filter_outputs(
  output_being_spent: &WalletOutput,
  candidates: Vec<u64>,
  outs: Vec<OutputInformation>,
) -> Result<Vec<(u64, [EdwardsPoint; 2])>, RpcError> {
  if candidates.len() != outs.len() {
    Err(RpcError::InvalidNode("get_outs response omitted requested outputs".to_string()))?;
  }
  let spend_position = candidates
    .binary_search(&output_being_spent.index_on_blockchain())
    .expect("selected a ring which didn't include the real spend");
  let mut res = Vec::new();
  for (i, out) in outs.into_iter().enumerate() {
    if !out.unlocked {
      continue;
    }
    let key = match out.key.decompress() {
      Some(k) => k,
      None => continue,
    };
    let commitment = out.commitment;
    if i == spend_position {
      // Check it's actually the real spend
      if (output_being_spent.key() != key)
        || (output_being_spent.commitment().calculate() != commitment)
      {
        Err(RpcError::InvalidNode(
          "node presented different view of output we're trying to spend".to_string(),
        ))?;
      }

      continue;
    }
    // Unless torsion is present
    // https://github.com/monero-project/monero/blob/893916ad091a92e765ce3241b94e706ad012b62a
    //   /src/wallet/wallet2.cpp#L9050-L9060
    {
      if !(key.is_torsion_free() && commitment.is_torsion_free()) {
        continue;
      }
    }
    res.push((candidates[i], [key, commitment]));
  }
  Ok(res)
}
/// Filters the outputs returned by the RPC to only those which are usable as decoys.
/// This includes checking that the output is unlocked, that it matches the key and commitment
/// of the output being spent (for the real spend), to ensure the node is responding honestly
/// the output is checked to be unlocked based on the current height and transaction data.
/// (instead of relying on the node to tell us if it's unlocked)
fn filter_outputs_deterministic(
  output_being_spent: &WalletOutput,
  candidates: Vec<u64>,
  outs: Vec<OutputInformation>,
  transactions: Vec<Transaction>,
  height: usize,
) -> Result<Vec<(u64, [EdwardsPoint; 2])>, RpcError> {
  if candidates.len() != outs.len() {
    Err(RpcError::InvalidNode("get_outs response omitted requested outputs".to_string()))?;
  }
  let spend_position = candidates
    .binary_search(&output_being_spent.index_on_blockchain())
    .expect("selected a ring which didn't include the real spend");
  let mut res = Vec::new();
  for (i, out) in outs.into_iter().enumerate() {
    // https://github.com/monero-project/monero/blob
    //   /cc73fe71162d564ffda8e549b79a350bca53c454/src/cryptonote_core
    //   /blockchain.cpp#L90
    const ACCEPTED_TIMELOCK_DELTA: usize = 1;

    // https://github.com/monero-project/monero/blob
    //   /cc73fe71162d564ffda8e549b79a350bca53c454/src/cryptonote_core
    //   /blockchain.cpp#L3836
    if !(out.height.checked_add(DEFAULT_LOCK_WINDOW).is_some_and(|locked| locked <= height)
      && (Timelock::Block(height.wrapping_add(ACCEPTED_TIMELOCK_DELTA - 1))
        >= transactions[i].prefix().additional_timelock))
    {
      continue;
    }

    let key = match out.key.decompress() {
      Some(k) => k,
      None => continue,
    };
    let commitment = out.commitment;
    if i == spend_position {
      // Check it's actually the real spend
      if (output_being_spent.key() != key)
        || (output_being_spent.commitment().calculate() != commitment)
      {
        Err(RpcError::InvalidNode(
          "node presented different view of output we're trying to spend".to_string(),
        ))?;
      }

      continue;
    }
    // Unless torsion is present
    // https://github.com/monero-project/monero/blob/893916ad091a92e765ce3241b94e706ad012b62a
    //   /src/wallet/wallet2.cpp#L9050-L9060
    {
      if !(key.is_torsion_free() && commitment.is_torsion_free()) {
        continue;
      }
    }
    res.push((candidates[i], [key, commitment]));
  }
  Ok(res)
}
/// Turns potential decoys into a ring with the real spend included.
/// (If there are enough potential decoys, otherwise, returns an error)
fn make_ring(
  rng: &mut (impl RngCore + CryptoRng),
  ring_len: u8,
  input: &WalletOutput,
  potential_decoys: Vec<(u64, [EdwardsPoint; 2])>,
) -> Result<OutputWithDecoys, RpcError> {
  if ring_len == 0 {
    Err(RpcError::InternalError("requesting a ring of length 0".to_string()))?;
  }
  if potential_decoys.len() < (ring_len - 1) as usize {
    Err(RpcError::InternalError("potential decoy list too short to form ring".to_string()))?;
  }

  // Select all decoys for this transaction, assuming we generate a sane transaction
  // We should almost never naturally generate an insane transaction, hence why this doesn't
  // bother with an overage

  // Form the complete ring
  let mut ring =
    potential_decoys.choose_multiple(rng, ring_len as usize - 1).cloned().collect::<Vec<_>>();
  ring.push((input.index_on_blockchain(), [input.key(), input.commitment().calculate()]));
  ring.sort_by(|a, b| a.0.cmp(&b.0));

  /*
    Monero does have sanity checks which it applies to the selected ring.

    They're statistically unlikely to be hit and only occur when the transaction is published over
    the RPC (so they are not a relay rule). The RPC allows disabling them, which monero-rpc does to
    ensure they don't pose a problem.

    They aren't worth the complexity to implement here, especially since they're non-deterministic.
  */

  // We need to convert our positional indexes to offset indexes
  let mut offsets = Vec::with_capacity(ring.len());
  {
    offsets.push(ring[0].0);
    for m in 1..ring.len() {
      offsets.push(ring[m].0 - ring[m - 1].0);
    }
  }

  let decoys = Decoys::new(
    offsets,
    // Binary searches for the real spend since we don't know where it sorted to
    // TODO: Define our own collection whose `len` function returns `u8` to ensure this bound
    // with types
    u8::try_from(ring.partition_point(|x| x.0 < input.index_on_blockchain()))
      .expect("ring of size <= u8::MAX had an index exceeding u8::MAX"),
    ring.into_iter().map(|output| output.1).collect(),
  )
  .expect("selected a syntactically-invalid set of Decoys");

  Ok(OutputWithDecoys { output: input.data.clone(), decoys })
}
/// Use sample_candiates to select canidates, then fetch them as potential decoys from the RPC,
/// pass the result into this function to prepare the input with decoys for a transaction.
fn make_output_with_decoys_sync(
  rng: &mut (impl RngCore + CryptoRng),
  ring_len: u8,
  input: &WalletOutput,
  output_response: Vec<OutputInformation>,
  candidates: Vec<u64>,
) -> Result<OutputWithDecoys, RpcError> {
  let potential_decoys = filter_outputs(input, candidates, output_response)?;
  make_ring(rng, ring_len, input, potential_decoys)
}
/// Use sample_candiates to select canidates, then fetch them as potential decoys from the RPC,
/// fetch the transactions containing these decoys to determine if outputs are unlocked locally,
/// pass the result into this function to prepare the input with decoys for a transaction.
fn make_output_with_decoys_deterministic_sync(
  rng: &mut (impl RngCore + CryptoRng),
  ring_len: u8,
  input: &WalletOutput,
  output_response: Vec<OutputInformation>,
  candidates: Vec<u64>,
  transactions: Vec<Transaction>,
  height: usize,
) -> Result<OutputWithDecoys, RpcError> {
  let potential_decoys =
    filter_outputs_deterministic(input, candidates, output_response, transactions, height)?;
  make_ring(rng, ring_len, input, potential_decoys)
}
