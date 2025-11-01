pub mod block_parsing;
pub mod transaction_building;
use block_parsing::convert_to_json;
use block_parsing::get_blocks_bin_response_meta;
use block_parsing::scan_blocks;
use cuprate_epee_encoding::{from_bytes, to_bytes};
use cuprate_rpc_types::bin::{GetBlocksRequest, GetOutsRequest, GetOutsResponse};
use cuprate_rpc_types::misc::GetOutputsOut;
use curve25519_dalek::scalar::Scalar;
use hex::FromHex;
use monero_wallet::address::Network;
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
pub extern "C" fn sample_decoys(sample_json_str_len: usize) {
  let sample_json_str = input_string(sample_json_str_len);
  match transaction_building::inputs::sample_candidates(&sample_json_str) {
    Ok(candidates) => {
      let candidates_json = json!({ "candidates": candidates });
      output_string(&candidates_json.to_string());
    }
    Err(e) => {
      println!("Error sampling decoys: {}", e);
      return; // error handling becomes easier on the ts side if we just return nothing print the error
    }
  }
}
/// turns output into and input with decoys, so a new transaction can be built
#[no_mangle]
pub extern "C" fn make_input(output_json_len: usize, getouts_response_len: usize) {
  let outputs_json = input_string(output_json_len);
  let getouts_response = input(getouts_response_len);
  println!("{}", outputs_json);
  match from_bytes(&mut getouts_response.as_slice()) {
    Ok(blocks_response) => {
      match transaction_building::inputs::make_input_sync(&outputs_json, blocks_response) {
        Ok(input) => {
          let inputs_json = json!({ "input": input.serialize() });
          output_string(&inputs_json.to_string());
        }
        Err(e) => {
          let error_json = json!({
              "error": format!("Error making input: {}", e)
          })
          .to_string();
          output_string(&error_json);
        }
      }
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
pub extern "C" fn build_getoutsbin_request(outputs_array_len: usize) {
  let output_indices_array = input_string(outputs_array_len);
  let output_indices: Vec<u64> = match serde_json::from_str(&output_indices_array) {
    Ok(v) => v,
    Err(e) => {
      println!(
        "build_getoutsbin_request: Failed to parse outputs array as JSON array of u64: {}",
        e
      );
      return; // we don't output anything in this error case
    }
  };

  let mut req_params: GetOutsRequest = GetOutsRequest::default();
  let outputs_vec =
    output_indices.into_iter().map(|idx| GetOutputsOut { amount: 0, index: idx }).collect();
  req_params.outputs = outputs_vec;
  req_params.get_txid = true;
  output(to_bytes(req_params).unwrap().to_vec().as_ref()); // in the success case we output the request
}

#[no_mangle]
pub extern "C" fn convert_get_outs_bin_response_to_json(response_len: usize) {
  let response = input(response_len);

  match from_bytes::<GetOutsResponse, _>(&mut response.as_slice()) {
    Ok(outs_response) => {
      output_string(&convert_to_json(&outs_response));
    }
    Err(error) => {
      let error_message = format!("Error parsing getouts.bin response: {}", error);
      let error_json = json!({
          "error": error_message
      })
      .to_string();
      output_string(&error_json);
    }
  }
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
              &blocks_response,
              global_state.primary_address.as_deref().unwrap_or("error-address-not-set"),
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
