use cuprate_rpc_types::{bin::GetBlocksResponse, misc::Status};
use cuprate_types::TransactionBlobs;
use monero_wallet::{
  NotTimelocked, Scanner, WalletOutput,
  block::Block,
  extra::PaymentId,
  rpc::ScannableBlock,
  transaction::{Pruned, Transaction},
};
use serde::Serialize;
use serde_json::{Value, json};

pub fn convert_to_json<T>(data: &T) -> String
where
  T: Serialize,
{
  match serde_json::to_string(data) {
    Ok(json_string) => json_string,
    Err(e) => {
      let error_message = format!("Error serializing data to JSON: {}", e);
      let error_json = json!({
          "error": error_message
      })
      .to_string();
      error_json
    }
  }
}
#[derive(serde::Serialize)]
pub struct BlockInfo {
  block_height: u64,
  block_timestamp: u64,
  block_hash: String,
}
#[derive(serde::Serialize)]
pub struct GetBlocksResult {
  new_height: u64,
  daemon_height: u64,
  status: Status,
  primary_address: String,
  block_infos: Vec<BlockInfo>,
}
pub fn get_blocks_bin_response_meta(
  get_blocks_bin: &GetBlocksResponse,
  primary_address: &str,
) -> GetBlocksResult {
  let new_height = get_blocks_bin.start_height + (get_blocks_bin.blocks.len() as u64);
  let daemon_height = get_blocks_bin.current_height;
  let mut block_infos: Vec<BlockInfo> = vec![];
  for (index, block_entry) in get_blocks_bin.blocks.iter().enumerate() {
    let block = match Block::read::<&[u8]>(&mut block_entry.block.as_ref()) {
      Ok(block) => block,
      Err(_) => {
        println!("Error reading block");
        continue;
      }
    };
    block_infos.push(BlockInfo {
      block_timestamp: block.header.timestamp,
      block_height: get_blocks_bin.start_height + (index as u64),
      block_hash: hex::encode(block.hash()),
    });
  }
  GetBlocksResult {
    new_height,
    daemon_height,
    status: get_blocks_bin.base.response_base.status.clone(),
    primary_address: primary_address.to_string(),
    block_infos,
  }
}
#[derive(serde::Serialize, Debug)]
struct InputImage {
  key_image_hex: String,
  relative_index: usize,
  tx_hash: String, // Assuming tx has a method like tx.hash() returning [u8; 32]
  block_height: u64,
  block_timestamp: u64,
  block_hash: String,
}
pub fn scan_blocks(
  scanner: Scanner,
  primary_address: &str,
  get_blocks_bin: GetBlocksResponse,
) -> String {
  let mut output_jsons = Vec::new();
  let mut input_images_jsons: Vec<InputImage> = Vec::new();

  for (index, block_entry) in get_blocks_bin.blocks.iter().enumerate() {
    let output_index_for_first_ringct_output = get_blocks_bin
      .output_indices
      .get(index)
      .and_then(|outer| outer.indices.get(0))
      .and_then(|inner| inner.indices.get(0))
      .map(|&value| value);

    let block = match Block::read::<&[u8]>(&mut block_entry.block.as_ref()) {
      Ok(block) => block,
      Err(_) => {
        println!("Error reading block");
        continue;
      }
    };

    let mut transactions = Vec::new();

    match &block_entry.txs {
      TransactionBlobs::Normal(_) => {
        // we don't handle non pruned transactions
      }
      TransactionBlobs::Pruned(pruned_txs) => {
        for entry in pruned_txs {
          match Transaction::<Pruned>::read::<&[u8]>(&mut entry.blob.as_ref()) {
            Ok(tx) => {
              transactions.push(tx);
            }
            Err(_) => {
              println!("Error reading pruned transaction");
            }
          }
        }
      }
      TransactionBlobs::None => {
        // No transactions in this block
      }
    }

    let mut txs_with_hashes = vec![(
      block.miner_transaction().hash(),
      Transaction::<Pruned>::from(block.miner_transaction().clone()),
    )];
    for (hash, tx) in block.transactions.iter().zip(transactions.clone()) {
      txs_with_hashes.push((*hash, tx));
    }
    let input_images = txs_with_hashes.iter().fold(Vec::new(), |mut acc, (hash_bytes, tx)| {
      let tx_hash = hex::encode(hash_bytes); // hash_bytes is [u8; 32]
      tx.prefix().inputs.iter().enumerate().for_each(|(i, input)| match input {
        monero_wallet::transaction::Input::Gen(_) => {}
        monero_oxide::transaction::Input::ToKey { amount: _, key_offsets: _, key_image } => {
          let key_image_hex = hex::encode(key_image.to_bytes());
          acc.push(InputImage {
            key_image_hex,
            relative_index: i,
            tx_hash: tx_hash.clone(),
            block_timestamp: block.header.timestamp,
            block_height: get_blocks_bin.start_height + (index as u64),
            block_hash: hex::encode(block.hash()),
          });
        }
      });
      acc
    });
    input_images_jsons.extend(input_images);

    // Scan the miner transaction
    match scanner.scan_transaction(
      output_index_for_first_ringct_output,
      block.miner_transaction().hash(),
      &Transaction::<Pruned>::from(block.miner_transaction().clone()),
    ) {
      Ok(res) => {
        let block_height = get_blocks_bin.start_height + (index as u64);
        if let NotTimelocked::OnChain(unlocked) =
          &res.additional_timelock_satisfied_by((block_height + 60) as usize, u64::MAX)
        {
          for wallet_output in unlocked {
            output_jsons.push(wallet_output_to_json(
              wallet_output,
              block_height,
              primary_address,
              true,
            ));
          }
        }
      }
      Err(error) => {
        let error_message = format!("Error scanning miner transaction: {}", error);
        let error_json = json!({
            "error": error_message
        })
        .to_string();
        return error_json;
      }
    };

    let scan_block = ScannableBlock { block, transactions, output_index_for_first_ringct_output };
    match scanner.scan(scan_block) {
      Ok(res) => {
        let unlocked = res.not_additionally_locked();
        let block_height = get_blocks_bin.start_height + (index as u64);

        for wallet_output in unlocked {
          output_jsons.push(wallet_output_to_json(
            &wallet_output,
            block_height,
            primary_address,
            false,
          ));
        }
      }
      Err(error) => {
        let error_message = format!("Error scanning block: {}", error);
        let error_json = json!({
            "error": error_message
        })
        .to_string();
        return error_json;
      }
    }
  }
  let final_output_json: serde_json::Value =
    json!({"outputs":output_jsons, "all_key_images": input_images_jsons});
  return final_output_json.to_string();
}

fn wallet_output_to_json(
  wallet_output: &WalletOutput,
  block_height: u64,
  primary_address: &str,
  is_miner_tx: bool,
) -> Value {
  let id = wallet_output.key().compress().to_bytes();
  let payment_id = match wallet_output.payment_id() {
    Some(PaymentId::Encrypted(id)) => id,
    Some(PaymentId::Unencrypted(_)) => [0, 0, 0, 0, 0, 0, 0, 0],
    _ => [0, 0, 0, 0, 0, 0, 0, 0],
  };
  json!({
      "amount": wallet_output.commitment().amount,
      "stealth_address": hex::encode(id),
      "tx_hash": hex::encode(wallet_output.transaction()),
      "index_in_transaction":wallet_output.index_in_transaction(),
      "index_on_blockchain": wallet_output.index_on_blockchain(),
      "payment_id": u64::from_le_bytes(payment_id),
      "is_miner_tx": is_miner_tx,
      "block_height": block_height,
      "primary_address": primary_address,
      "serialized": hex::encode(wallet_output.serialize()),
  })
}
