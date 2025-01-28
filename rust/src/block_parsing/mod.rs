use cuprate_rpc_types::bin::GetBlocksResponse;
use cuprate_types::TransactionBlobs;
use monero_wallet::{
    block::Block,
    rpc::ScannableBlock,
    transaction::{NotPruned, Pruned, Transaction},
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
pub struct ScanResult {}
#[derive(serde::Serialize)]
pub struct GetBlocksResult {
    new_height: u64,
    daemon_height: u64,
}
pub fn get_blocks_bin_response_meta(get_blocks_bin: &GetBlocksResponse) -> GetBlocksResult {
    let new_height = get_blocks_bin.start_height + (get_blocks_bin.blocks.len() as u64);
    let daemon_height = get_blocks_bin.current_height;

    GetBlocksResult {
        new_height,
        daemon_height,
    }
}

pub fn scan_blocks(mut scanner: Scanner, get_blocks_bin: GetBlocksResponse) {
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
        // println!("Processing block: {:?}", blockhihi.miner_transaction);
        //  output_index_for_first_ringct_output +=
        //  u64::try_from(tx.prefix().outputs.len()).unwrap();
        let mut transactions = Vec::new();

        match &block_entry.txs {
            TransactionBlobs::Normal(txs) => {
                // we don't handle non pruned transactions for now
            }
            TransactionBlobs::Pruned(pruned_txs) => {
                // Handle pruned transactions separately
                //println!("Processing pruned transaction: {:?}", pruned_txs[0]);
                // let blockhihi =
                //     Block::read::<&[u8]>(&mut block_entry.block.as_ref()).unwrap();
                //  println!("Processing block: {:?}", blockhihi);
                for entry in pruned_txs {
                    // Process PrunedTxBlobEntry here
                    let tx =
                        Transaction::<Pruned>::read::<&[u8]>(&mut entry.blob.as_ref()).unwrap();
                    transactions.push(tx);
                    //println!("Processing pruned transaction: {:?}", tx);
                    // Add parsing logic for pruned transactions if needed
                }
            }
            TransactionBlobs::None => {
                // println!("No transactions in this block");
            }
        }

        let scanBlock = ScannableBlock {
            block,
            transactions,
            output_index_for_first_ringct_output,
        };
        let res = scanner.scan(scanBlock).unwrap().not_additionally_locked();
        println!("weijokfjiweioewioewioeweeeeeeeeeeee {:?}", res.len());
        println!(
            "{} , {}",
            get_blocks_bin.start_height + (get_blocks_bin.blocks.len() as u64),
            get_blocks_bin.current_height
        );
        // res.
        for x in res {
            println!("hi there {:?}", x.commitment());
            // match serde_json::to_string(&x.) {
            //     Ok(json_string) => println!("{}", json_string),
            //     Err(e) => eprintln!("Serialization error: {}", e),
            // }
        }
    }
}
