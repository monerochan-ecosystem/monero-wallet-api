use std::io::Bytes;

use core::str;
use cuprate_epee_encoding::{from_bytes, to_bytes, EpeeObject, EpeeValue};
use cuprate_rpc_types::bin::{GetBlocksRequest, GetBlocksResponse};
use curve25519_dalek::scalar::Scalar;
use hex::FromHex;
use monero_wallet;
use monero_wallet::block::Block;
use monero_wallet::rpc::ScannableBlock;
use monero_wallet::{Scanner, ViewPair};
use serde_json::Value;
use std::cell::RefCell;
use std::io::{self, Read};
use std::ops::Deref;
use your_program::{input, input_string, output, output_string};

use zeroize::Zeroizing;
thread_local! {
    static GLOBAL_SCANNER: RefCell<Option<Scanner>> = RefCell::new(None);
}
mod your_program {
    use std::io::Bytes;

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
    // pub fn output_bytes(bytes: Bytes) {
    //     // Ensure the Bytes instance remains alive
    //     let bytes_ref = bytes.as_ref();

    //     unsafe { yours::output(bytes_ref.as_ptr(), bytes_ref.len()) }
    // }
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
    let mut expected = GetBlocksRequest::default();
    expected.start_height = 398;
    match serde_json::to_string(&expected) {
        Ok(json_string) => println!("{}", json_string),
        Err(e) => eprintln!("Serialization error: {}", e),
    }
    let data = to_bytes(expected).unwrap();
    output(data.to_vec().as_ref());
    let lossy_string: String = String::from_utf8_lossy(data.as_ref()).into_owned();
    println!("Lossy UTF-8 interpretation: {}", lossy_string);
}
#[no_mangle]
pub extern "C" fn parse_response(response_len: usize) {
    let response = input(response_len);
    let blocks_response: GetBlocksResponse = from_bytes(&mut response.as_slice()).unwrap();
    // match serde_json::to_string(&val) {
    //     Ok(json_string) => println!("{}", json_string),
    //     Err(e) => eprintln!("Serialization error: {}", e),
    // }
    // GLOBAL_VIEWPAIR.with(|old_viewpair| {
    //     let viewpair_ref = old_viewpair.borrow();
    //     let viewpair = viewpair_ref.as_ref().unwrap();
    // })
    // Now you can use view_pair_ref
    GLOBAL_SCANNER.with(|old_scanner| {
        let global_scanner = old_scanner.borrow();
        let scanner = global_scanner.as_ref().unwrap();
        match blocks_response {
            GetBlocksResponse::PoolInfoNone(response) => {
                for block_entry in &response.blocks {
                    // Process each block here
                    let blockhihi = Block::read::<&[u8]>(&mut block_entry.block.as_ref()).unwrap();
                    println!("Processing block: {:?}", blockhihi);
                }
            }
            _ => println!("Unexpected response variant"),
        }

        // ScannableBlock
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
