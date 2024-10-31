use core::str;
use std::cell::RefCell;

use curve25519_dalek::scalar::Scalar;
use hex::FromHex;
use monero_wallet;
use monero_wallet::ViewPair;
use serde_json::Value;
use std::io::{self, Read};
use your_program::{input, input_string, output_string};
use zeroize::Zeroizing;
thread_local! {
    static GLOBAL_VIEWPAIR: RefCell<Option<ViewPair>> = RefCell::new(None);
}
mod your_program {
    /// implement input & output in your program to share arrays with the monero-wallet-api
    /// rust will take care of allocation and deallocation
    mod yours {
        extern "C" {
            pub fn input(ptr: *mut u8, length: usize);
        }
        extern "C" {
            pub fn output(ptr: *const u8, length: usize);
        }
    }
    /// internal wrappers to handle input and output of strings
    pub fn input(length: usize) -> Vec<u8> {
        let mut vec = Vec::with_capacity(length);

        unsafe {
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
            yours::input(vec.as_mut_ptr(), length);
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
    let primary_address = &input_string(primary_address_string_len);
    let secret_view_key = &input_string(secret_view_key_string_len);

    GLOBAL_VIEWPAIR.with(|old_viewpair| {
        let mut viewpair = old_viewpair.borrow_mut();
        *viewpair = Some(make_viewpair(primary_address, secret_view_key));

        // Check if ViewPair is present and print its legacy address
        if let Some(vp) = &*viewpair {
            println!(
                "HI {:#?}",
                vp.legacy_address(monero_wallet::address::Network::Stagenet)
            );
        } else {
            eprintln!("ViewPair has not been initialized");
        }
    });
}
///rust API
pub fn make_viewpair(primary_address: &str, secret_view_key: &str) -> ViewPair {
    let view_key_bytes = <[u8; 32]>::from_hex(secret_view_key.to_string()).unwrap();
    monero_wallet::ViewPair::new(
        monero_wallet::address::MoneroAddress::from_str_with_unchecked_network(primary_address)
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
