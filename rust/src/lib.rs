pub mod block_parsing;

use block_parsing::convert_to_json;
use block_parsing::get_blocks_bin_response_meta;
use block_parsing::scan_blocks;
use cuprate_epee_encoding::{from_bytes, to_bytes, EpeeObject, EpeeValue};
use cuprate_rpc_types::bin::{GetBlocksRequest, GetBlocksResponse};
use curve25519_dalek::scalar::Scalar;
use hex::FromHex;
use monero_wallet;
use serde_json::json;

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

    match from_bytes(&mut response.as_slice()) {
        Ok(blocks_response) => {
            GLOBAL_SCANNER.with(|old_scanner| match old_scanner.borrow().clone() {
                None => {
                    output_string(&convert_to_json(&get_blocks_bin_response_meta(
                        &blocks_response,
                    )));
                    output_string(&convert_to_json(&blocks_response));
                }
                Some(scanner) => {
                    output_string(&convert_to_json(&get_blocks_bin_response_meta(
                        &blocks_response,
                    )));
                    scan_blocks(scanner, blocks_response);
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
