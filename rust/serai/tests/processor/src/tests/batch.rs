use std::{
  collections::HashMap,
  time::{SystemTime, Duration},
};

use dkg::{Participant, tests::clone_without};

use messages::{coordinator::*, SubstrateContext};

use serai_client::{
  in_instructions::primitives::{
    batch_message, Batch, InInstruction, InInstructionWithBalance, SignedBatch,
  },
  primitives::{
    crypto::RuntimePublic, Amount, BlockHash, ExternalBalance, ExternalNetworkId, PublicKey,
    SeraiAddress, EXTERNAL_NETWORKS,
  },
  validator_sets::primitives::Session,
};

use serai_db::MemDb;
use processor::networks::{Network, Bitcoin, Ethereum, Monero};

use crate::{*, tests::*};

pub(crate) async fn recv_batch_preprocesses(
  coordinators: &mut [Coordinator],
  session: Session,
  batch: &Batch,
  attempt: u32,
) -> (SubstrateSignId, HashMap<Participant, [u8; 64]>) {
  let id = SubstrateSignId { session, id: SubstrateSignableId::Batch(batch.id), attempt };

  let mut block = None;
  let mut preprocesses = HashMap::new();
  for (i, coordinator) in coordinators.iter_mut().enumerate() {
    let i = Participant::new(u16::try_from(i).unwrap() + 1).unwrap();

    if attempt == 0 {
      match coordinator.recv_message().await {
        messages::ProcessorMessage::Substrate(messages::substrate::ProcessorMessage::Batch {
          batch: sent_batch,
        }) => {
          assert_eq!(&sent_batch, batch);
        }
        _ => panic!("processor didn't send batch"),
      }
    }

    match coordinator.recv_message().await {
      messages::ProcessorMessage::Coordinator(
        messages::coordinator::ProcessorMessage::BatchPreprocess {
          id: this_id,
          block: this_block,
          preprocesses: mut these_preprocesses,
        },
      ) => {
        assert_eq!(this_id, id);
        if block.is_none() {
          block = Some(this_block);
        }
        assert_eq!(&this_block, block.as_ref().unwrap());

        assert_eq!(these_preprocesses.len(), 1);
        preprocesses.insert(i, these_preprocesses.swap_remove(0));
      }
      _ => panic!("processor didn't send batch preprocess"),
    }
  }

  // Reduce the preprocesses down to the threshold
  while preprocesses.len() > THRESHOLD {
    preprocesses.remove(
      &Participant::new(
        u16::try_from(OsRng.next_u64() % u64::try_from(COORDINATORS).unwrap()).unwrap() + 1,
      )
      .unwrap(),
    );
  }

  (id, preprocesses)
}

pub(crate) async fn sign_batch(
  coordinators: &mut [Coordinator],
  key: [u8; 32],
  id: SubstrateSignId,
  preprocesses: HashMap<Participant, [u8; 64]>,
) -> SignedBatch {
  assert_eq!(preprocesses.len(), THRESHOLD);

  for (i, coordinator) in coordinators.iter_mut().enumerate() {
    let i = Participant::new(u16::try_from(i).unwrap() + 1).unwrap();

    if preprocesses.contains_key(&i) {
      coordinator
        .send_message(messages::coordinator::CoordinatorMessage::SubstratePreprocesses {
          id: id.clone(),
          preprocesses: clone_without(&preprocesses, &i),
        })
        .await;
    }
  }

  let mut shares = HashMap::new();
  for (i, coordinator) in coordinators.iter_mut().enumerate() {
    let i = Participant::new(u16::try_from(i).unwrap() + 1).unwrap();

    if preprocesses.contains_key(&i) {
      match coordinator.recv_message().await {
        messages::ProcessorMessage::Coordinator(
          messages::coordinator::ProcessorMessage::SubstrateShare {
            id: this_id,
            shares: mut these_shares,
          },
        ) => {
          assert_eq!(&this_id, &id);
          assert_eq!(these_shares.len(), 1);
          shares.insert(i, these_shares.swap_remove(0));
        }
        _ => panic!("processor didn't send batch share"),
      }
    }
  }

  for (i, coordinator) in coordinators.iter_mut().enumerate() {
    let i = Participant::new(u16::try_from(i).unwrap() + 1).unwrap();

    if preprocesses.contains_key(&i) {
      coordinator
        .send_message(messages::coordinator::CoordinatorMessage::SubstrateShares {
          id: id.clone(),
          shares: clone_without(&shares, &i),
        })
        .await;
    }
  }

  // The selected processors should yield the batch
  let mut batch = None;
  for (i, coordinator) in coordinators.iter_mut().enumerate() {
    let i = Participant::new(u16::try_from(i).unwrap() + 1).unwrap();

    if preprocesses.contains_key(&i) {
      match coordinator.recv_message().await {
        messages::ProcessorMessage::Substrate(
          messages::substrate::ProcessorMessage::SignedBatch { batch: this_batch },
        ) => {
          if batch.is_none() {
            assert!(PublicKey::from_raw(key)
              .verify(&batch_message(&this_batch.batch), &this_batch.signature));

            batch = Some(this_batch.clone());
          }

          assert_eq!(batch.as_ref().unwrap(), &this_batch);
        }
        _ => panic!("processor didn't send batch"),
      }
    }
  }
  batch.unwrap()
}

pub(crate) async fn substrate_block(
  coordinator: &mut Coordinator,
  block: messages::substrate::CoordinatorMessage,
) -> Vec<PlanMeta> {
  match block.clone() {
    messages::substrate::CoordinatorMessage::SubstrateBlock {
      context: _,
      block: sent_block,
      burns: _,
      batches: _,
    } => {
      coordinator.send_message(block).await;
      match coordinator.recv_message().await {
        messages::ProcessorMessage::Coordinator(
          messages::coordinator::ProcessorMessage::SubstrateBlockAck { block: recvd_block, plans },
        ) => {
          assert_eq!(recvd_block, sent_block);
          plans
        }
        _ => panic!("coordinator didn't respond to SubstrateBlock with SubstrateBlockAck"),
      }
    }
    _ => panic!("substrate_block message wasn't a SubstrateBlock"),
  }
}

#[test]
fn batch_test() {
  for network in EXTERNAL_NETWORKS {
    let (coordinators, test) = new_test(network);

    test.run(|ops| async move {
      tokio::time::sleep(Duration::from_secs(1)).await;

      let mut coordinators = coordinators
        .into_iter()
        .map(|(handles, key)| Coordinator::new(network, &ops, handles, key))
        .collect::<Vec<_>>();

      // Create a wallet before we start generating keys
      let mut wallet = Wallet::new(network, &ops, coordinators[0].network_handle.clone()).await;
      coordinators[0].sync(&ops, &coordinators[1 ..]).await;

      // Generate keys
      let key_pair = key_gen(&mut coordinators).await;

      // Now we we have to mine blocks to activate the key
      // (the first key is activated when the network's time as of a block exceeds the Serai time
      // it was confirmed at)
      // Mine multiple sets of medians to ensure the median is sufficiently advanced
      for _ in 0 .. (10 * confirmations(network)) {
        coordinators[0].add_block(&ops).await;
        tokio::time::sleep(Duration::from_secs(1)).await;
      }
      coordinators[0].sync(&ops, &coordinators[1 ..]).await;

      // Run twice, once with an instruction and once without
      let substrate_block_num = (OsRng.next_u64() % 4_000_000_000u64) + 1;
      for i in 0 .. 2 {
        let mut serai_address = [0; 32];
        OsRng.fill_bytes(&mut serai_address);
        let instruction =
          if i == 0 { Some(InInstruction::Transfer(SeraiAddress(serai_address))) } else { None };

        // Send into the processor's wallet
        let (tx, balance_sent) =
          wallet.send_to_address(&ops, &key_pair.1, instruction.clone()).await;
        for coordinator in &mut coordinators {
          coordinator.publish_transaction(&ops, &tx).await;
        }

        // Put the TX past the confirmation depth
        let mut block_with_tx = None;
        for _ in 0 .. confirmations(network) {
          let (hash, _) = coordinators[0].add_block(&ops).await;
          if block_with_tx.is_none() {
            block_with_tx = Some(hash);
          }
        }
        coordinators[0].sync(&ops, &coordinators[1 ..]).await;

        // Sleep for 10s
        // The scanner works on a 5s interval, so this leaves a few s for any processing/latency
        tokio::time::sleep(Duration::from_secs(10)).await;

        println!("sent in transaction. with in instruction: {}", instruction.is_some());

        let expected_batch = Batch {
          network,
          id: i,
          block: BlockHash(block_with_tx.unwrap()),
          instructions: if let Some(instruction) = &instruction {
            vec![InInstructionWithBalance {
              instruction: instruction.clone(),
              balance: ExternalBalance {
                coin: balance_sent.coin,
                amount: Amount(
                  balance_sent.amount.0 -
                    (2 * match network {
                      ExternalNetworkId::Bitcoin => Bitcoin::COST_TO_AGGREGATE,
                      ExternalNetworkId::Ethereum => Ethereum::<MemDb>::COST_TO_AGGREGATE,
                      ExternalNetworkId::Monero => Monero::COST_TO_AGGREGATE,
                    }),
                ),
              },
            }]
          } else {
            // This shouldn't have an instruction as we didn't add any data into the TX we sent
            // Empty batches remain valuable as they let us achieve consensus on the block and spend
            // contained outputs
            vec![]
          },
        };

        println!("receiving batch preprocesses...");

        // Make sure the processors picked it up by checking they're trying to sign a batch for it
        let (mut id, mut preprocesses) =
          recv_batch_preprocesses(&mut coordinators, Session(0), &expected_batch, 0).await;
        // Trigger a random amount of re-attempts
        for attempt in 1 ..= u32::try_from(OsRng.next_u64() % 4).unwrap() {
          // TODO: Double check how the processor handles this ID field
          // It should be able to assert its perfectly sequential
          id.attempt = attempt;
          for coordinator in &mut coordinators {
            coordinator
              .send_message(messages::coordinator::CoordinatorMessage::BatchReattempt {
                id: id.clone(),
              })
              .await;
          }
          (id, preprocesses) =
            recv_batch_preprocesses(&mut coordinators, Session(0), &expected_batch, attempt).await;
        }

        println!("signing batch...");

        // Continue with signing the batch
        let batch = sign_batch(&mut coordinators, key_pair.0 .0, id, preprocesses).await;

        // Check it
        assert_eq!(batch.batch, expected_batch);

        // Fire a SubstrateBlock
        let serai_time =
          SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).unwrap().as_secs();
        for coordinator in &mut coordinators {
          let plans = substrate_block(
            coordinator,
            messages::substrate::CoordinatorMessage::SubstrateBlock {
              context: SubstrateContext {
                serai_time,
                network_latest_finalized_block: batch.batch.block,
              },
              block: substrate_block_num + u64::from(i),
              burns: vec![],
              batches: vec![batch.batch.id],
            },
          )
          .await;
          if instruction.is_some() ||
            (instruction.is_none() && (network == ExternalNetworkId::Monero))
          {
            assert!(plans.is_empty());
          } else {
            // If no instruction was used, and the processor csn presume the origin, it'd have
            // created a refund Plan
            assert_eq!(plans.len(), 1);
          }
        }
      }

      // With the latter InInstruction not existing, we should've triggered a refund if the origin
      // was detectable
      // Check this is trying to sign a Plan
      if network != ExternalNetworkId::Monero {
        let mut refund_id = None;
        for coordinator in &mut coordinators {
          match coordinator.recv_message().await {
            messages::ProcessorMessage::Sign(messages::sign::ProcessorMessage::Preprocess {
              id,
              ..
            }) => {
              if refund_id.is_none() {
                refund_id = Some(id.clone());
              }
              assert_eq!(refund_id.as_ref().unwrap(), &id);
            }
            _ => panic!("processor didn't send preprocess for expected refund transaction"),
          }
        }
      }
    });
  }
}
