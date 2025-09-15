use std_shims::{collections::HashSet, io, string::ToString, vec::Vec};

use zeroize::{Zeroize, ZeroizeOnDrop};

use rand_core::{CryptoRng, RngCore};
#[cfg(not(feature = "std"))]
use rand_distr::num_traits::Float;
use rand_distr::{Distribution, Gamma};

use curve25519_dalek::{EdwardsPoint, Scalar};

use monero_oxide::{
    primitives::{Commitment, Decoys},
    BLOCK_TIME, COINBASE_LOCK_WINDOW, DEFAULT_LOCK_WINDOW,
};
use monero_wallet::{
    rpc::{DecoyRpc, RpcError},
    WalletOutput,
};

const RECENT_WINDOW: u64 = 15;
const BLOCKS_PER_YEAR: usize = (365 * 24 * 60 * 60) / BLOCK_TIME;
#[allow(clippy::cast_precision_loss)]
const TIP_APPLICATION: f64 = (DEFAULT_LOCK_WINDOW * BLOCK_TIME) as f64;

async fn select_n(
    rng: &mut (impl RngCore + CryptoRng),
    distribution: Vec<u64>,
    height: usize,
    real_output: u64,
    ring_len: u8,
    fingerprintable_deterministic: bool,
) -> Result<Vec<(u64, [EdwardsPoint; 2])>, RpcError> {
    // if height < DEFAULT_LOCK_WINDOW {
    //     Err(RpcError::InternalError(
    //         "not enough blocks to select decoys".to_string(),
    //     ))?;
    // }
    // if height > rpc.get_output_distribution_end_height().await? {
    //     Err(RpcError::InternalError(
    //         "decoys being requested from blocks this node doesn't have".to_string(),
    //     ))?;
    // }

    // // Get the distribution
    // let distribution = rpc.get_output_distribution(..height).await?;
    if distribution.len() < DEFAULT_LOCK_WINDOW {
        Err(RpcError::InternalError(
            "not enough blocks to select decoys".to_string(),
        ))?;
    }
    let highest_output_exclusive_bound = distribution[distribution.len() - DEFAULT_LOCK_WINDOW];
    // This assumes that each miner TX had one output (as sane) and checks we have sufficient
    // outputs even when excluding them (due to their own timelock requirements)
    // Considering this a temporal error for very new chains, it's sufficiently sane to have
    if highest_output_exclusive_bound.saturating_sub(
        u64::try_from(COINBASE_LOCK_WINDOW).expect("coinbase lock window exceeds 2^{64}"),
    ) < u64::from(ring_len)
    {
        Err(RpcError::InternalError(
            "not enough decoy candidates".to_string(),
        ))?;
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
    do_not_select.insert(real_output);

    let decoy_count = usize::from(ring_len - 1);
    let mut res = Vec::with_capacity(decoy_count);

    let mut iters = 0;
    // Iterates until we have enough decoys
    // If an iteration only returns a partial set of decoys, the remainder will be obvious as decoys
    // to the RPC
    // The length of that remainder is expected to be minimal
    while res.len() != decoy_count {
        iters += 1;
        #[cfg(not(test))]
        const MAX_ITERS: usize = 10;
        // When testing on fresh chains, increased iterations can be useful and we don't necessitate
        // reasonable performance
        #[cfg(test)]
        const MAX_ITERS: usize = 100;
        // Ensure this isn't infinitely looping
        // We check both that we aren't at the maximum amount of iterations and that the not-yet
        // selected candidates exceed the amount of candidates necessary to trigger the next iteration
        if (iters == MAX_ITERS)
            || ((highest_output_exclusive_bound
                - u64::try_from(do_not_select.len())
                    .expect("amount of ignored decoys exceeds 2^{64}"))
                < u64::from(ring_len))
        {
            Err(RpcError::InternalError(
                "hit decoy selection round limit".to_string(),
            ))?;
        }

        let remaining = decoy_count - res.len();
        let mut candidates = Vec::with_capacity(remaining);
        while candidates.len() != remaining {
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
                    % (RECENT_WINDOW
                        * u64::try_from(BLOCK_TIME).expect("BLOCK_TIME exceeded u64::MAX")))
                    as f64;
            }

            #[allow(clippy::cast_sign_loss, clippy::cast_possible_truncation)]
            let o = (age * per_second) as u64;
            if o < highest_output_exclusive_bound {
                // Find which block this points to
                let i =
                    distribution.partition_point(|s| *s < (highest_output_exclusive_bound - 1 - o));
                let prev = i.saturating_sub(1);
                let n = distribution[i]
                    .checked_sub(distribution[prev])
                    .ok_or_else(|| {
                        RpcError::InternalError(
                            "RPC returned non-monotonic distribution".to_string(),
                        )
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

        // If this is the first time we're requesting these outputs, include the real one as well
        // Prevents the node we're connected to from having a list of known decoys and then seeing a
        // TX which uses all of them, with one additional output (the true spend)
        let real_index = if iters == 0 {
            candidates.push(real_output);
            // Sort candidates so the real spends aren't the ones at the end
            candidates.sort();
            Some(
                candidates
                    .binary_search(&real_output)
                    .expect("selected a ring which didn't include the real spend"),
            )
        } else {
            None
        };

        for (i, output) in rpc
            .get_unlocked_outputs(&candidates, height, fingerprintable_deterministic)
            .await?
            .iter_mut()
            .enumerate()
        {
            // We could check the returned info is equivalent to our expectations, yet that'd allow the
            // node to malleate the returned info to see if they can cause this error (allowing them to
            // figure out the output being spent)
            //
            // Some degree of this attack (forcing resampling/trying to observe errors) is likely
            // always possible
            if real_index == Some(i) {
                continue;
            }

            // If this is an unlocked output, push it to the result
            if let Some(output) = output.take() {
                // Unless torsion is present
                // https://github.com/monero-project/monero/blob/893916ad091a92e765ce3241b94e706ad012b62a
                //   /src/wallet/wallet2.cpp#L9050-L9060
                {
                    let [key, commitment] = output;
                    if !(key.is_torsion_free() && commitment.is_torsion_free()) {
                        continue;
                    }
                }
                res.push((candidates[i], output));
            }
        }
    }

    Ok(res)
}

async fn select_decoys<R: RngCore + CryptoRng>(
    rng: &mut R,
    rpc: &impl DecoyRpc,
    ring_len: u8,
    height: usize,
    input: &WalletOutput,
    fingerprintable_deterministic: bool,
) -> Result<Decoys, RpcError> {
    if ring_len == 0 {
        Err(RpcError::InternalError(
            "requesting a ring of length 0".to_string(),
        ))?;
    }

    // Select all decoys for this transaction, assuming we generate a sane transaction
    // We should almost never naturally generate an insane transaction, hence why this doesn't
    // bother with an overage
    let decoys = select_n(
        rng,
        rpc,
        height,
        input.index_on_blockchain(),
        ring_len,
        fingerprintable_deterministic,
    )
    .await?;

    // Form the complete ring
    let mut ring = decoys;
    ring.push((
        input.index_on_blockchain(),
        [input.key(), input.commitment().calculate()],
    ));
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

    Ok(Decoys::new(
        offsets,
        // Binary searches for the real spend since we don't know where it sorted to
        // TODO: Define our own collection whose `len` function returns `u8` to ensure this bound
        // with types
        u8::try_from(ring.partition_point(|x| x.0 < input.index_on_blockchain()))
            .expect("ring of size <= u8::MAX had an index exceeding u8::MAX"),
        ring.into_iter().map(|output| output.1).collect(),
    )
    .expect("selected a syntactically-invalid set of Decoys"))
}
