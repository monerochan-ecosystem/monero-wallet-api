pub mod block_parsing;

use block_parsing::convert_to_json;
use cuprate_epee_encoding::{from_bytes, to_bytes, EpeeObject, EpeeValue};
use cuprate_rpc_types::bin::{GetBlocksRequest, GetBlocksResponse};
use cuprate_types::{BlockCompleteEntry, TransactionBlobs};
use curve25519_dalek::scalar::Scalar;
use hex::FromHex;
use monero_serai::transaction::NotPruned;
use monero_wallet;
use monero_wallet::block::Block;
use monero_wallet::rpc::ScannableBlock;
use monero_wallet::transaction::Pruned;
use monero_wallet::transaction::Transaction;
use monero_wallet::{Scanner, ViewPair};
use std::cell::RefCell;
use your_program::{input, input_string, output, output_string};
use zeroize::Zeroizing;
thread_local! {
    static GLOBAL_SCANNER: RefCell<Option<Scanner>> = RefCell::new(None);
}
mod your_program {
    /// implement input & output in your program to share arrays with the monero-wallet-api
    /// rust will take care of allocation and deallocation
    mod yours {
        extern "C" {
            pub fn input(ptr: *const u8, length: usize);
        }
        extern "C" {
            pub fn output(ptr: *const u8, length: usize);
        }
    }
    /// internal wrappers to handle input and output of strings
    pub fn input(length: usize) -> Vec<u8> {
        let mut vec = Vec::with_capacity(length);

        unsafe {
            vec.set_len(length);
            yours::input(vec.as_mut_ptr(), length);
        }

        vec
    }
    pub fn output(value: &Vec<u8>) {
        unsafe { yours::output(value.as_ptr(), value.len()) };
    }
    pub fn input_string(length: usize) -> String {
        let mut vec = Vec::with_capacity(length);

        unsafe {
            vec.set_len(length);
            yours::input(vec.as_ptr(), length);
            return String::from_utf8_unchecked(vec);
        }
    }
    pub fn output_string(value: &str) {
        unsafe { yours::output(value.as_ptr(), value.len()) };
    }
}
/// WASM / C ABI
//TODO init view pair with name (hashmap of view pairs)
#[no_mangle]
pub extern "C" fn init_viewpair(
    primary_address_string_len: usize,
    secret_view_key_string_len: usize,
) {
    let primary_address = input_string(primary_address_string_len);
    let secret_view_key = input_string(secret_view_key_string_len);

    let viewpair = make_viewpair(primary_address, secret_view_key);
    GLOBAL_SCANNER.with(|old_scanner| {
        let mut global_scanner = old_scanner.borrow_mut();
        *global_scanner = Some(Scanner::new(viewpair))
    });
}

#[no_mangle]
pub extern "C" fn build_getblocksbin_request(
    requested_info: u8,
    start_height: u64,
    prune_num: u8,
    no_miner_tx_num: u8,
    pool_info_since: u64,
) {
    let mut req_params: GetBlocksRequest = GetBlocksRequest::default();
    req_params.requested_info = requested_info;
    req_params.start_height = start_height;
    if prune_num == 1 {
        req_params.prune = true;
    }
    if no_miner_tx_num == 1 {
        req_params.no_miner_tx = true;
    }
    req_params.pool_info_since = pool_info_since;

    output(to_bytes(req_params).unwrap().to_vec().as_ref());
}

#[no_mangle]
pub extern "C" fn parse_response(response_len: usize) {
    let response = input(response_len);
    // if the daemon is not fully synced this will panic with:
    // called `Result::unwrap()` on an `Err` value: Error { value: "Invalid utf8 str" }
    let blocks_response: GetBlocksResponse = from_bytes(&mut response.as_slice()).unwrap();

    GLOBAL_SCANNER.with(|old_scanner| {
        match old_scanner.borrow().clone() {
            None => {
                output_string(&convert_to_json(&blocks_response));
            }
            Some(mut scanner) => {
                // println!(
                //     "Processing normal response: {:?}",
                //     blocks_response.output_indices[0].indices[0].indices[0]
                // );
                // println!(
                //     "Processing normal response: {:?}",
                //     blocks_response.output_indices[1].indices[0]
                // );
                // println!(
                //     "Processing normal response: {:?}",
                //     blocks_response.output_indices[3].indices[0]
                // );
                //  println!("Processing normal response: {:?}", response);
                for (index, block_entry) in blocks_response.blocks.iter().enumerate() {
                    let output_index_for_first_ringct_output =
                        Some(blocks_response.output_indices[index].indices[0].indices[0]);
                    // Process each block here
                    let blockhihi = Block::read::<&[u8]>(&mut block_entry.block.as_ref()).unwrap();
                    // println!("Processing block: {:?}", blockhihi.miner_transaction);
                    //  output_index_for_first_ringct_output +=
                    //  u64::try_from(tx.prefix().outputs.len()).unwrap();
                    let mut transactions = Vec::new();

                    match &block_entry.txs {
                        TransactionBlobs::Normal(txs) => {
                            println!("Processing normal transaction: {:?}", txs);
                            for tx_bytes in txs {
                                let tx = Transaction::<NotPruned>::read(&mut tx_bytes.as_ref());
                                // transactions.push(tx);
                                // let tx =
                                //     Transaction::<Pruned>::read(tx_bytes).map_err(
                                //         |_| match hash_hex(&res.tx_hash) {
                                //             Ok(hex_hash) => Error::InvalidTransaction(format!(
                                //                 "Failed to parse transaction: {}",
                                //                 hex_hash
                                //             )),
                                //             Err(_) => Error::InvalidTransaction(
                                //                 "Failed to generate transaction hash".to_string(),
                                //             ),
                                //         },
                                //     );

                                // if let Ok(parsed_tx) = tx {
                                //     parsed_transactions.push(parsed_tx);
                                // } else {
                                //     // Handle error case, possibly skip this transaction
                                //     println!("Warning: Skipping invalid transaction");
                                // }
                                println!("Processing normal transaction: {:?}", tx);
                                // println!("Processing block: {:?}", blockhihi);
                            }
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
                                    Transaction::<Pruned>::read::<&[u8]>(&mut entry.blob.as_ref())
                                        .unwrap();
                                transactions.push(tx);
                                //println!("Processing pruned transaction: {:?}", tx);
                                // Add parsing logic for pruned transactions if needed
                            }
                        }
                        TransactionBlobs::None => {
                            //     println!("No transactions in this block");
                        }
                    }

                    let scanBlock = ScannableBlock {
                        block: blockhihi,
                        transactions,
                        output_index_for_first_ringct_output,
                    };
                    let res = scanner.scan(scanBlock).unwrap().not_additionally_locked();
                    println!("weijokfjiweioewioewioeweeeeeeeeeeee {:?}", res.len());
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
        }
        //  scanner.scan(block)
    });
}
///rust API
pub fn make_viewpair(primary_address: String, secret_view_key: String) -> ViewPair {
    let view_key_bytes = <[u8; 32]>::from_hex(secret_view_key).unwrap();
    monero_wallet::ViewPair::new(
        monero_wallet::address::MoneroAddress::from_str_with_unchecked_network(
            primary_address.as_str(),
        )
        .map_err(|e| {
            eprintln!(
                "There is an issue with the primary address that you provided: {}",
                primary_address.to_string()
            );
            eprintln!("{}", e.to_string());
            std::process::exit(1);
        })
        .unwrap()
        .spend(),
        Zeroizing::new(Scalar::from_canonical_bytes(view_key_bytes).unwrap()),
    )
    .unwrap()
}
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_monero_serai() {
        let result = 4;
        assert_eq!(result, 4);
    }
}
