use core::{time::Duration, pin::Pin, future::Future};
use std::collections::HashMap;

use rand_core::OsRng;

use ciphersuite::group::GroupEncoding;
use frost::{Participant, dkg::tests::key_gen};

use tokio::time::timeout;

use serai_db::{DbTxn, Db, MemDb};

use serai_client::{
  primitives::{ExternalNetworkId, ExternalCoin, Amount, ExternalBalance},
  validator_sets::primitives::Session,
};

use crate::{
  Payment, Plan,
  networks::{Output, Transaction, Eventuality, Block, Network},
  key_gen::NetworkKeyDb,
  multisigs::{
    scanner::{ScannerEvent, Scanner},
    scheduler::{self, Scheduler},
  },
  tests::sign,
};

// Tests the Scanner, Scheduler, and Signer together
pub async fn test_wallet<N: Network>(
  new_network: impl Fn(MemDb) -> Pin<Box<dyn Send + Future<Output = N>>>,
) {
  let mut keys = key_gen(&mut OsRng);
  for keys in keys.values_mut() {
    N::tweak_keys(keys);
  }
  let key = keys[&Participant::new(1).unwrap()].group_key();

  let mut db = MemDb::new();
  {
    let mut txn = db.txn();
    NetworkKeyDb::set(&mut txn, Session(0), &key.to_bytes().as_ref().to_vec());
    txn.commit();
  }
  let network = new_network(db.clone()).await;

  // Mine blocks so there's a confirmed block
  for _ in 0 .. N::CONFIRMATIONS {
    network.mine_block().await;
  }

  let (mut scanner, current_keys) = Scanner::new(network.clone(), db.clone());
  assert!(current_keys.is_empty());
  let (block_id, outputs) = {
    let mut txn = db.txn();
    scanner.register_key(&mut txn, network.get_latest_block_number().await.unwrap(), key).await;
    txn.commit();
    for _ in 0 .. N::CONFIRMATIONS {
      network.mine_block().await;
    }

    let block = network.test_send(N::external_address(&network, key).await).await;
    let block_id = block.id();

    match timeout(Duration::from_secs(30), scanner.events.recv()).await.unwrap().unwrap() {
      ScannerEvent::Block { is_retirement_block, block, outputs } => {
        scanner.multisig_completed.send(false).unwrap();
        assert!(!is_retirement_block);
        assert_eq!(block, block_id);
        assert_eq!(outputs.len(), 1);
        (block_id, outputs)
      }
      ScannerEvent::Completed(_, _, _, _, _) => {
        panic!("unexpectedly got eventuality completion");
      }
    }
  };
  let mut txn = db.txn();
  assert_eq!(scanner.ack_block(&mut txn, block_id.clone()).await.1, outputs);
  scanner.release_lock().await;
  txn.commit();

  let mut txn = db.txn();
  let mut scheduler = N::Scheduler::new::<MemDb>(&mut txn, key, N::NETWORK);
  let amount = 2 * N::DUST;
  let plans = scheduler.schedule::<MemDb>(
    &mut txn,
    outputs.clone(),
    vec![Payment {
      address: N::external_address(&network, key).await,
      data: None,
      balance: ExternalBalance {
        coin: match N::NETWORK {
          ExternalNetworkId::Bitcoin => ExternalCoin::Bitcoin,
          ExternalNetworkId::Ethereum => ExternalCoin::Ether,
          ExternalNetworkId::Monero => ExternalCoin::Monero,
        },
        amount: Amount(amount),
      },
    }],
    key,
    false,
  );
  txn.commit();
  assert_eq!(plans.len(), 1);
  assert_eq!(plans[0].key, key);
  if std::any::TypeId::of::<N::Scheduler>() ==
    std::any::TypeId::of::<scheduler::smart_contract::Scheduler<N>>()
  {
    assert_eq!(plans[0].inputs, vec![]);
  } else {
    assert_eq!(plans[0].inputs, outputs);
  }
  assert_eq!(
    plans[0].payments,
    vec![Payment {
      address: N::external_address(&network, key).await,
      data: None,
      balance: ExternalBalance {
        coin: match N::NETWORK {
          ExternalNetworkId::Bitcoin => ExternalCoin::Bitcoin,
          ExternalNetworkId::Ethereum => ExternalCoin::Ether,
          ExternalNetworkId::Monero => ExternalCoin::Monero,
        },
        amount: Amount(amount),
      }
    }]
  );
  assert_eq!(plans[0].change, N::change_address(key));

  {
    let mut buf = vec![];
    plans[0].write(&mut buf).unwrap();
    assert_eq!(plans[0], Plan::<N>::read::<&[u8]>(&mut buf.as_ref()).unwrap());
  }

  // Execute the plan
  let mut keys_txs = HashMap::new();
  let mut eventualities = vec![];
  for (i, keys) in keys.drain() {
    let (signable, eventuality) = network
      .prepare_send(network.get_block_number(&block_id).await, plans[0].clone(), 0)
      .await
      .unwrap()
      .tx
      .unwrap();

    eventualities.push(eventuality.clone());
    keys_txs.insert(i, (keys, (signable, eventuality)));
  }

  let claim = sign(network.clone(), Session(0), keys_txs).await;
  network.mine_block().await;
  let block_number = network.get_latest_block_number().await.unwrap();
  let tx = network.get_transaction_by_eventuality(block_number, &eventualities[0]).await;
  let block = network.get_block(block_number).await.unwrap();
  let outputs = network.get_outputs(&block, key).await;

  // Don't run if Ethereum as the received output will revert by the contract
  // (and therefore not actually exist)
  if N::NETWORK != ExternalNetworkId::Ethereum {
    assert_eq!(outputs.len(), 1 + usize::from(u8::from(plans[0].change.is_some())));
    // Adjust the amount for the fees
    let amount = amount - tx.fee(&network).await;
    if plans[0].change.is_some() {
      // Check either output since Monero will randomize its output order
      assert!(
        (outputs[0].balance().amount.0 == amount) || (outputs[1].balance().amount.0 == amount)
      );
    } else {
      assert!(outputs[0].balance().amount.0 == amount);
    }
  }

  for eventuality in eventualities {
    let completion = network.confirm_completion(&eventuality, &claim).await.unwrap().unwrap();
    assert_eq!(N::Eventuality::claim(&completion), claim);
  }

  for _ in 1 .. N::CONFIRMATIONS {
    network.mine_block().await;
  }

  if N::NETWORK != ExternalNetworkId::Ethereum {
    match timeout(Duration::from_secs(30), scanner.events.recv()).await.unwrap().unwrap() {
      ScannerEvent::Block { is_retirement_block, block: block_id, outputs: these_outputs } => {
        scanner.multisig_completed.send(false).unwrap();
        assert!(!is_retirement_block);
        assert_eq!(block_id, block.id());
        assert_eq!(these_outputs, outputs);
      }
      ScannerEvent::Completed(_, _, _, _, _) => {
        panic!("unexpectedly got eventuality completion");
      }
    }

    // Check the Scanner DB can reload the outputs
    let mut txn = db.txn();
    assert_eq!(scanner.ack_block(&mut txn, block.id()).await.1, outputs);
    scanner.release_lock().await;
    txn.commit();
  }
}
