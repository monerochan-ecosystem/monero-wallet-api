pub mod block_parsing;
pub mod transaction_building;
use block_parsing::convert_to_json;
use block_parsing::get_blocks_bin_response_meta;
use block_parsing::scan_blocks;
use cuprate_epee_encoding::{from_bytes, to_bytes};
use cuprate_rpc_types::bin::GetBlocksRequest;
use curve25519_dalek::scalar::Scalar;
use futures::executor::block_on;
use hex::FromHex;
use monero_wallet::address::Network;
use serde::Serialize;
use serde_json::json;

use monero_wallet::{Scanner, ViewPair};
use std::cell::RefCell;
use your_program::{input, input_string, output, output_string};
use zeroize::Zeroizing;

thread_local! {
    static GLOBAL_STATE: RefCell<GlobalState> = RefCell::new(GlobalState {
        viewpair: None,
        network: None,
        primary_address: None,
        scanner: None,
    });
}

struct GlobalState {
    viewpair: Option<ViewPair>,
    network: Option<Network>,
    primary_address: Option<String>,
    scanner: Option<Scanner>,
}

#[derive(Serialize)]
struct FunctionCallMeta {
    function: String,
    params: String,
}
mod your_program {
    use crate::FunctionCallMeta;

    /// implement input & output in your program to share arrays with the monero-wallet-api
    /// rust will take care of allocation and deallocation
    mod yours {
        extern "C" {
            pub fn input(ptr: *const u8, length: usize);
        }
        extern "C" {
            pub fn output(ptr: *const u8, length: usize);
        }
        extern "C" {
            pub fn functionCall(ptr: *const u8, length: usize) -> usize;
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
    pub fn function_call(function_name: &str, params: &str) -> String {
        let meta = FunctionCallMeta {
            function: function_name.to_string(),
            params: params.to_string(),
        };
        let value =
            serde_json::to_string(&meta).unwrap_or("cannot-serialize-function-call".to_string());
        unsafe {
            let output_len = yours::functionCall(value.as_ptr(), value.len());
            return input_string(output_len);
        };
    }
}
/// WASM / C ABI
#[no_mangle]
pub extern "C" fn init_viewpair(
    primary_address_string_len: usize,
    secret_view_key_string_len: usize,
) {
    let primary_address = input_string(primary_address_string_len);
    let secret_view_key = input_string(secret_view_key_string_len);
    let viewpair = make_viewpair(primary_address.as_str(), secret_view_key.as_str());
    GLOBAL_STATE.with(|state| {
        let mut global_state = state.borrow_mut();
        global_state.viewpair = Some(viewpair.clone());
        global_state.network = Some(
            monero_wallet::address::MoneroAddress::from_str_with_unchecked_network(
                primary_address.as_str(),
            )
            .map_err(|e| {
                eprintln!(
                    "There is an issue with the primary address that you provided: {}",
                    primary_address
                );
                eprintln!("{}", e);
            })
            .unwrap()
            .network(),
        );
        global_state.primary_address = Some(primary_address.clone());
        global_state.scanner = Some(Scanner::new(viewpair));
    });
}
#[no_mangle]
pub extern "C" fn make_integrated_address(payment_id: u64) {
    GLOBAL_STATE.with(|state| {
        let global_state = state.borrow();
        match (&global_state.viewpair, &global_state.network) {
            (Some(viewpair), Some(network)) => {
                let bytes_back: [u8; 8] = payment_id.to_le_bytes();
                output_string(
                    &viewpair
                        .legacy_integrated_address(*network, bytes_back)
                        .to_string(),
                );
            }
            _ => {
                let error_json = json!({
                    "error": "the scanner / viewpair was not initialized. integrated address did not get created."
                })
                .to_string();
                output_string(&error_json);
            }
        }
    });
}
#[no_mangle]
pub extern "C" fn make_inputs(outputs_json_len: usize) {
    let outputs_json = input_string(outputs_json_len);
    println!("{}", outputs_json);
    block_on(transaction_building::make_inputs(&outputs_json));
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
pub extern "C" fn scan_blocks_with_get_blocks_bin(response_len: usize) {
    let response = input(response_len);

    match from_bytes(&mut response.as_slice()) {
        Ok(blocks_response) => {
            GLOBAL_STATE.with(|state| {
                let global_state = state.borrow();
                match &global_state.scanner {
                    None => {
                        let error_json = json!({
                            "error": "the scanner / viewpair was not initialized. Blocks didn't get scanned."
                        })
                        .to_string();
                        output_string(&error_json);
                    }
                    Some(scanner) => {
                        output_string(&convert_to_json(&get_blocks_bin_response_meta(
                            &blocks_response,global_state.primary_address.as_deref().unwrap_or("error-address-not-set")
                        )));
                        output_string(&scan_blocks(
                            scanner.clone(),
                            global_state.primary_address.as_deref().unwrap_or("error-address-not-set"),
                            blocks_response,
                        ));
                    }
                }
            });
        }
        Err(error) => {
            let error_message = format!("Error parsing getBlocksBin response: {}", error);
            let error_json = json!({
                "error": error_message
            })
            .to_string();
            output_string(&error_json);
        }
    }
}
#[no_mangle]
pub extern "C" fn convert_get_blocks_bin_response_to_json(response_len: usize) {
    let response = input(response_len);

    match from_bytes(&mut response.as_slice()) {
        Ok(blocks_response) => {
            output_string(&convert_to_json(&get_blocks_bin_response_meta(
                &blocks_response,
                "parsing-monerod-response-without-wallet",
            )));
            output_string(&convert_to_json(&blocks_response));
        }
        Err(error) => {
            let error_message = format!("Error parsing getBlocksBin response: {}", error);
            let error_json = json!({
                "error": error_message
            })
            .to_string();
            output_string(&error_json);
        }
    }
}
///rust API
pub fn make_viewpair(primary_address: &str, secret_view_key: &str) -> ViewPair {
    let view_key_bytes = <[u8; 32]>::from_hex(secret_view_key).unwrap();
    monero_wallet::ViewPair::new(
        monero_wallet::address::MoneroAddress::from_str_with_unchecked_network(primary_address)
            .map_err(|e| {
                eprintln!(
                    "There is an issue with the primary address that you provided: {}",
                    primary_address.to_string()
                );
                eprintln!("{}", e.to_string());
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
