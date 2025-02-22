// This file was originally:

// Copyright (C) Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0

// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
// 	http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

// It has been forked into a crate distributed under the AGPL 3.0.
// Please check the current distribution for up-to-date copyright and licensing information.

//! Dex pallet benchmarking.

use super::*;
use frame_benchmarking::{benchmarks, whitelisted_caller};
use frame_support::{assert_ok, storage::bounded_vec::BoundedVec};
use frame_system::RawOrigin as SystemOrigin;

use sp_runtime::traits::StaticLookup;
use sp_std::{ops::Div, prelude::*};

use serai_primitives::{Amount, Balance};

use crate::Pallet as Dex;
use coins_pallet::Pallet as Coins;

const INITIAL_COIN_BALANCE: u64 = 1_000_000_000;
type AccountIdLookupOf<T> = <<T as frame_system::Config>::Lookup as StaticLookup>::Source;

type LiquidityTokens<T> = coins_pallet::Pallet<T, coins_pallet::Instance1>;

fn create_coin<T: Config>(coin: &ExternalCoin) -> (T::AccountId, AccountIdLookupOf<T>) {
  let caller: T::AccountId = whitelisted_caller();
  let caller_lookup = T::Lookup::unlookup(caller);
  assert_ok!(Coins::<T>::mint(
    caller,
    Balance { coin: Coin::native(), amount: Amount(SubstrateAmount::MAX.div(1000u64)) }
  ));
  assert_ok!(Coins::<T>::mint(
    caller,
    Balance { coin: (*coin).into(), amount: Amount(INITIAL_COIN_BALANCE) }
  ));
  (caller, caller_lookup)
}

fn create_coin_and_pool<T: Config>(
  coin: &ExternalCoin,
) -> (ExternalCoin, T::AccountId, AccountIdLookupOf<T>) {
  let (caller, caller_lookup) = create_coin::<T>(coin);
  assert_ok!(Dex::<T>::create_pool(*coin));

  (*coin, caller, caller_lookup)
}

benchmarks! {
  add_liquidity {
    let coin1 = Coin::native();
    let coin2 = ExternalCoin::Bitcoin;
    let (lp_token, caller, _) = create_coin_and_pool::<T>(&coin2);
    let add_amount: u64 = 1000;
  }: _(
    SystemOrigin::Signed(caller),
    coin2,
    1000u64,
    add_amount,
    0u64,
    0u64,
    caller
  )
  verify {
    let pool_id = Dex::<T>::get_pool_id(coin1, coin2.into()).unwrap();
    let lp_minted = Dex::<T>::calc_lp_amount_for_zero_supply(
      add_amount,
      1000u64,
    ).unwrap();
    assert_eq!(
      LiquidityTokens::<T>::balance(caller, lp_token.into()).0,
      lp_minted
    );
    assert_eq!(
      Coins::<T>::balance(Dex::<T>::get_pool_account(pool_id), Coin::native()).0,
      add_amount
    );
    assert_eq!(
      Coins::<T>::balance(
        Dex::<T>::get_pool_account(pool_id),
        ExternalCoin::Bitcoin.into(),
      ).0,
      1000
    );
  }

  remove_liquidity {
    let coin1 = Coin::native();
    let coin2 = ExternalCoin::Monero;
    let (lp_token, caller, _) = create_coin_and_pool::<T>(&coin2);
    let add_amount: u64 = 100;
    let lp_minted = Dex::<T>::calc_lp_amount_for_zero_supply(
      add_amount,
      1000u64
    ).unwrap();
    let remove_lp_amount: u64 = lp_minted.checked_div(10).unwrap();

    Dex::<T>::add_liquidity(
      SystemOrigin::Signed(caller).into(),
      coin2,
      1000u64,
      add_amount,
      0u64,
      0u64,
      caller,
    )?;
    let total_supply = LiquidityTokens::<T>::supply(Coin::from(lp_token));
  }: _(
    SystemOrigin::Signed(caller),
    coin2,
    remove_lp_amount,
    0u64,
    0u64,
    caller
  )
  verify {
    let new_total_supply =  LiquidityTokens::<T>::supply(Coin::from(lp_token));
    assert_eq!(
      new_total_supply,
      total_supply - remove_lp_amount
    );
  }

  swap_exact_tokens_for_tokens {
    let native = Coin::native();
    let coin1 = ExternalCoin::Bitcoin;
    let coin2 = ExternalCoin::Ether;
    let (_, caller, _) = create_coin_and_pool::<T>(&coin1);
    let (_, _) = create_coin::<T>(&coin2);

    Dex::<T>::add_liquidity(
      SystemOrigin::Signed(caller).into(),
      coin1,
      200u64,
      // TODO: this call otherwise fails with `InsufficientLiquidityMinted` if we don't multiply
      // with 3. Might be again related to their expectance on ed being > 1.
      100 * 3,
      0u64,
      0u64,
      caller,
    )?;

    let swap_amount = 100u64;

    // since we only allow the native-coin pools, then the worst case scenario would be to swap
    // coin1-native-coin2
    Dex::<T>::create_pool(coin2)?;
    Dex::<T>::add_liquidity(
      SystemOrigin::Signed(caller).into(),
      coin2,
      1000u64,
      500,
      0u64,
      0u64,
      caller,
    )?;

    let path = vec![Coin::from(coin1), native, Coin::from(coin2)];
    let path = BoundedVec::<_, T::MaxSwapPathLength>::try_from(path).unwrap();
    let native_balance = Coins::<T>::balance(caller, native).0;
    let coin1_balance = Coins::<T>::balance(caller, ExternalCoin::Bitcoin.into()).0;
  }: _(SystemOrigin::Signed(caller), path, swap_amount, 1u64, caller)
  verify {
    let ed_bump = 2u64;
    let new_coin1_balance = Coins::<T>::balance(caller, ExternalCoin::Bitcoin.into()).0;
    assert_eq!(new_coin1_balance, coin1_balance - 100u64);
  }

  swap_tokens_for_exact_tokens {
    let native = Coin::native();
    let coin1 = ExternalCoin::Bitcoin;
    let coin2 = ExternalCoin::Ether;
    let (_, caller, _) = create_coin_and_pool::<T>(&coin1);
    let (_, _) = create_coin::<T>(&coin2);

    Dex::<T>::add_liquidity(
      SystemOrigin::Signed(caller).into(),
      coin1,
      500u64,
      1000,
      0u64,
      0u64,
      caller,
    )?;

    // since we only allow the native-coin pools, then the worst case scenario would be to swap
    // coin1-native-coin2
    Dex::<T>::create_pool(coin2)?;
    Dex::<T>::add_liquidity(
      SystemOrigin::Signed(caller).into(),
      coin2,
      1000u64,
      500,
      0u64,
      0u64,
      caller,
    )?;
    let path = vec![Coin::from(coin1), native, Coin::from(coin2)];

    let path: BoundedVec<_, T::MaxSwapPathLength> = BoundedVec::try_from(path).unwrap();
    let coin2_balance = Coins::<T>::balance(caller, ExternalCoin::Ether.into()).0;
  }: _(
    SystemOrigin::Signed(caller),
    path.clone(),
    100u64,
    1000,
    caller
  )
  verify {
    let new_coin2_balance = Coins::<T>::balance(caller, ExternalCoin::Ether.into()).0;
    assert_eq!(new_coin2_balance, coin2_balance + 100u64);
  }

  impl_benchmark_test_suite!(Dex, crate::mock::new_test_ext(), crate::mock::Test);
}
