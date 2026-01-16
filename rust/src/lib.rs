pub mod block_parsing;
pub mod transaction_building;
pub mod keypairs;
use block_parsing::convert_to_json;
use block_parsing::get_blocks_bin_response_meta;
use block_parsing::scan_blocks;
use cuprate_epee_encoding::{from_bytes, to_bytes};
use cuprate_rpc_types::bin::{GetBlocksRequest, GetOutsRequest, GetOutsResponse};
use cuprate_rpc_types::misc::GetOutputsOut;
use cuprate_fixed_bytes::ByteArrayVec;

use curve25519_dalek::scalar::Scalar;
use hex::FromHex;
use monero_wallet::address::{Network, SubaddressIndex};
use serde::Deserialize;
use serde_json::json;

use monero_wallet::{Scanner, ViewPair};
use std::cell::RefCell;
use your_program::{input, input_string, output, output_string, output_error_string};
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
    extern "C" {
      pub fn output_error(ptr: *const u8, length: usize);
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
  pub fn output_error_string(value: &str) {
    unsafe { yours::output_error(value.as_ptr(), value.len()) };
  }
}
/// WASM / C ABI
#[no_mangle]
pub extern "C" fn make_spendkey() {
  output_string(hex::encode(keypairs::make_spendkey().to_bytes()).as_str());
}
#[no_mangle]
pub extern "C" fn make_viewkey(spend_key_string_len: usize) {
  let spend_key_string = input_string(spend_key_string_len);
  output_string(&convert_to_json(
    &keypairs::viewpair_from_spendkey(<[u8; 32]>::from_hex(spend_key_string.as_str()).unwrap())
      .unwrap(),
  ));
}
#[no_mangle]
pub extern "C" fn init_viewpair(
  primary_address_string_len: usize,
  secret_view_key_string_len: usize,
  last_subaddress_index: u32,
) {
  let primary_address = input_string(primary_address_string_len);
  let secret_view_key = input_string(secret_view_key_string_len);
  let viewpair =
    init_viewpair_from_viewpk_primary(primary_address.as_str(), secret_view_key.as_str());
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
    match global_state.network {
      Some(Network::Mainnet) => output_string(&json!({"network": "mainnet"}).to_string()),
      Some(Network::Stagenet) => output_string(&json!({"network": "stagenet"}).to_string()),
      _ => output_string(&json!({"network": "testnet"}).to_string()),
    }
    global_state.primary_address = Some(primary_address.clone());
    let mut scanner = Scanner::new(viewpair);
    let mut minor = 1;
    while minor <= last_subaddress_index {
      // we set minor to 1 so this will never return None
      let subaddress = SubaddressIndex::new(0, minor).unwrap();
      scanner.register_subaddress(subaddress);
      minor += 1;
    }

    global_state.scanner = Some(scanner);
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
pub extern "C" fn make_subaddress(major: u32, minor: u32) {
  GLOBAL_STATE.with(|state| {
    let global_state = state.borrow();
    let mut global_state_mut = state.borrow_mut();
    if let (Some(viewpair), Some(network), Some(scanner)) =
      (&global_state.viewpair, &global_state.network, &mut global_state_mut.scanner)
    {
      let subaddress_index = SubaddressIndex::new(major, minor).expect("Invalid indices");
      let subaddress = viewpair.subaddress(*network, subaddress_index);
      scanner.register_subaddress(subaddress_index.clone());

      output_string(&subaddress.to_string());
    } else {
      let error_json = json!({
          "error": "viewpair or network or scanner not initialized"
      })
      .to_string();
      output_error_string(&error_json);
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

  match from_bytes(&mut getouts_response.as_slice()) {
    Ok(blocks_response) => {
      match transaction_building::inputs::make_input_sync(&outputs_json, blocks_response) {
        Ok(input) => {
          let inputs_json = json!({ "input": hex::encode(input.serialize()) });
          // input.serialize opposite is input.read
          output_string(&inputs_json.to_string());
        }
        Err(e) => {
          println!("Error making input: {}", e);
          return; // error handling becomes easier on the ts side if we just return nothing print the error
        }
      }
    }
    Err(e) => {
      println!("Error parsing getBlocksBin response: IO error: {}", e);
      return; // error handling becomes easier on the ts side if we just return nothing print the error
    }
  }
}

#[no_mangle]
pub extern "C" fn make_transaction(json_params_len: usize) {
  let json_params = input_string(json_params_len);
  GLOBAL_STATE.with(|state| {
    let global_state = state.borrow();
    match &global_state.viewpair {
      Some(viewpair) => {
        match transaction_building::transaction::make_transaction(&json_params, viewpair.clone()) {
          Ok(signable_tx) => {
            let tx_json = json!({ "signable_transaction": hex::encode(signable_tx.serialize()) });
            output_string(&tx_json.to_string());
          }
          Err(e) => {
            output_error_string(&e);
            return;
          }
        }
      }
      None => {
        println!("The viewpair was not initialized. Transaction did not get created.");
        return;
      }
    }
  });
}

#[no_mangle]
pub extern "C" fn sign_transaction(tx_len: usize, secret_spend_key_len: usize) {
  let tx_string = input_string(tx_len);
  let secret_spend_key_string = input_string(secret_spend_key_len);
  match transaction_building::transaction::sign_transaction(tx_string, secret_spend_key_string) {
    Ok(signed_tx) => {
      let tx_json = json!({ "signed_transaction": signed_tx });
      output_string(&tx_json.to_string());
    }
    Err(e) => {
      println!("Error signing transaction: {}", e);
      return;
    }
  }
}

#[no_mangle]
pub extern "C" fn compute_key_image(output_hex_string_len: usize, sender_spend_key_len: usize) {
  let output_hex_string = input_string(output_hex_string_len);
  let sender_spend_key = input_string(sender_spend_key_len);
  match transaction_building::inputs::compute_key_image(output_hex_string, sender_spend_key) {
    Ok(key_image) => {
      let key_image_json = json!({ "key_image": key_image });
      output_string(&key_image_json.to_string());
    }
    Err(e) => {
      println!("Error computing key image: {}", e);
      return;
    }
  }
}

#[derive(Deserialize)]
struct GetBlocksBinParams {
  requested_info: Option<u8>,
  start_height: Option<u64>,
  prune: Option<bool>,
  no_miner_tx: Option<bool>,
  pool_info_since: Option<u64>,
  block_ids: Option<Vec<String>>,
}

#[no_mangle]
pub extern "C" fn build_getblocksbin_request(json_params_len: usize) {
  let json_params = input_string(json_params_len);
  let params: GetBlocksBinParams = match serde_json::from_str(&json_params) {
    Ok(p) => p,
    Err(e) => {
      output_error_string(
        json!({"message":"failed to parse getblocksbinrequest params","error":e.to_string()})
          .to_string()
          .as_str(),
      );
      return;
    }
  };
  let mut req_params: GetBlocksRequest = GetBlocksRequest::default();
  if let Some(val) = params.requested_info {
    req_params.requested_info = val;
  }

  if let Some(val) = params.start_height {
    req_params.start_height = val;
  }
  if let Some(val) = params.prune {
    req_params.prune = val;
  }
  if let Some(val) = params.no_miner_tx {
    req_params.no_miner_tx = val;
  }
  if let Some(val) = params.pool_info_since {
    req_params.pool_info_since = val;
  }
  if let Some(val) = params.block_ids {
    let ids: Vec<[u8; 32]> = val
      .iter()
      .map(|hex| hex::decode(hex).ok().and_then(|bytes| bytes.try_into().ok()).unwrap())
      .collect();
    req_params.block_ids = ByteArrayVec::from(ids);
  }
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
pub fn init_viewpair_from_viewpk_primary(primary_address: &str, secret_view_key: &str) -> ViewPair {
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
