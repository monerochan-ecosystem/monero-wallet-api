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
pub extern "C" fn init_view_pair() {
    GLOBAL_VIEWPAIR.with(|old_viewpair| {
        //TODO let library consumer pass in a function to handle input
            // let mut result = String::with_capacity(len_str.len());
            // result.as_ptr()
            // String::from_utf8_unchecked(bytes)
// println!("Result string: {}", unsafe { str::from_utf8_unchecked(&input(1)[..]) });  
//         let result_str = unsafe { str::from_utf8_unchecked(input(100).as_slice()) };
//         input(1);
//             let mut buf = vec![0; 100];
//         io::stdin().read(&mut buf);
        //io::stdin().read_to_string(&mut buf);
        init_view_pair2();
        let prim = input_string(10);
        output_string(prim.as_str());
        let mut viewpair = old_viewpair.borrow_mut();
        let primary_address = "55Py9fSwyEeQX1CydtFfPk96uHEFxSxvD9AYBy7dwnYt9cXqKDjix9rS9AWZ5GnH4B1Z7yHr3B2UH2updNw5ZNJEEnv87H1";
        let secret_view_key = "1195868d30373aa9d92c1a21514de97670bcd360c209a409ea3234174892770e";
        let view_key_bytes = <[u8; 32]>::from_hex(secret_view_key.to_string()).unwrap();
         *viewpair = Some(monero_wallet::ViewPair::new(
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
            Zeroizing::new(Scalar::from_canonical_bytes(view_key_bytes).unwrap()), // monero::PrivateKey::from_str(secret_view_key).map_err(|e| {
                                                                                   //     eprintln!("There is an issue with the view key that you provided: {}",
                                                                                   //       secret_view_key.to_string());
                                                                                   //     eprintln!("{}", e.to_string());
                                                                                   //     std::process::exit(1);
                                                                                   // }).unwrap(),
        )
        .unwrap());

        //TODO let library consumer pass in a function to handle output
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
pub fn init_view_pair2() {}
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_monero_serai() {
        let result = 4;
        assert_eq!(result, 4);
    }
}
