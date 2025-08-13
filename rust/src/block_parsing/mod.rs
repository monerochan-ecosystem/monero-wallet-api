use cuprate_rpc_types::{bin::GetBlocksResponse, misc::Status};
use cuprate_types::TransactionBlobs;
use monero_wallet::{
    block::Block,
    extra::PaymentId,
    rpc::ScannableBlock,
    transaction::{Pruned, Transaction},
    Scanner,
};
use serde::Serialize;
use serde_json::json;

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
pub struct GetBlocksResult {
    new_height: u64,
    daemon_height: u64,
    status: Status,
    primary_address: String,
}
pub fn get_blocks_bin_response_meta(
    get_blocks_bin: &GetBlocksResponse,
    primary_address: &str,
) -> GetBlocksResult {
    let new_height = get_blocks_bin.start_height + (get_blocks_bin.blocks.len() as u64);
    let daemon_height = get_blocks_bin.current_height;
    GetBlocksResult {
        new_height,
        daemon_height,
        status: get_blocks_bin.base.response_base.status.clone(),
        primary_address: primary_address.to_string(),
    }
}

pub fn scan_blocks(
    mut scanner: Scanner,
    primary_address: &str,
    get_blocks_bin: GetBlocksResponse,
) -> String {
    let mut output_jsons = Vec::new();

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
                // we don't handle non pruned transactions for now
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
                // println!("No transactions in this block");
            }
        }

        let scan_block = ScannableBlock {
            block,
            transactions,
            output_index_for_first_ringct_output,
        };
        match scanner.scan(scan_block) {
            Ok(res) => {
                let unlocked = res.not_additionally_locked();
                for x in unlocked {
                    let id = x.key().compress().to_bytes();
                    let payment_id = match x.payment_id() {
                        Some(PaymentId::Encrypted(id)) => id,
                        Some(PaymentId::Unencrypted(_)) => [0, 0, 0, 0, 0, 0, 0, 0],
                        _ => [0, 0, 0, 0, 0, 0, 0, 0],
                    };

                    let output_json = json!({
                        "amount": x.commitment().amount,
                        "stealth_address": hex::encode(id),
                        "tx_hash": hex::encode(x.transaction()),
                        "index_in_transaction":x.index_in_transaction(),
                        "index_on_blockchain": x.index_on_blockchain(),
                        "payment_id": u64::from_le_bytes(payment_id),
                        "block_height": get_blocks_bin.start_height + (index as u64),
                        "primary_address": primary_address,
                        "serialized": x.serialize(),
                    });

                    output_jsons.push(output_json);
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
    let final_output_json: serde_json::Value = json!({"outputs":output_jsons});
    return final_output_json.to_string();
}
