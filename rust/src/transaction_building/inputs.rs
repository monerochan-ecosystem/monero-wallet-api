use core::{fmt::Debug, ops::Deref};
use cuprate_rpc_types::{bin::GetOutsResponse, misc::OutKeyBin};
use monero_io::CompressedPoint;
use rand_core::OsRng;
use zeroize::Zeroizing;
use std::{io::Cursor};

use curve25519_dalek::{Scalar, edwards::CompressedEdwardsY, constants::ED25519_BASEPOINT_TABLE};
use monero_wallet::{rpc::OutputInformation, OutputWithDecoys, WalletOutput};
use serde::Deserialize;
use hex::FromHex;

#[derive(Debug, Deserialize)]
struct SampleCandidatesJson {
  output_being_spent_index: u64,
  distribution: Vec<u64>,
  candidates_len: usize,
}

pub fn sample_candidates(sample_json_str: &str) -> Result<Vec<u64>, monero_wallet::rpc::RpcError> {
  let sample_json: SampleCandidatesJson = serde_json::from_str(sample_json_str).unwrap();
  let mut rng = OsRng;
  OutputWithDecoys::sample_candidates(
    &mut rng,
    sample_json.output_being_spent_index,
    &sample_json.distribution,
    sample_json.candidates_len,
  )
}
/// convert outkeys from GetOutsResponse ( cuprate rpc type) to OutputInformation from monero oxide
pub fn convert_outkey_to_output_information(
  outkey: OutKeyBin,
) -> Result<OutputInformation, String> {
  // legacy name of the rpc for commitment is mask(as in, masks the amount)
  Ok(OutputInformation {
    height: outkey.height as usize,
    unlocked: outkey.unlocked,
    key: CompressedEdwardsY(outkey.key),
    commitment: CompressedPoint(outkey.mask).decompress().ok_or("invalid point")?,
    transaction: outkey.txid,
  })
}
pub fn read_output_from_string(output_hex_string: &str) -> Result<WalletOutput, String> {
  let output_bytes: Vec<u8> = hex::decode(output_hex_string).unwrap();
  let mut reader = Cursor::new(output_bytes);
  WalletOutput::read(&mut reader).map_err(|e| format!("failed to read  serialized output: {:?}", e))
}
#[derive(Debug, Deserialize)]
struct InputJson {
  serialized_input: String,
  candidates: Vec<u64>,
}
pub fn make_input_sync(
  input_sts: &str,
  outs_resonse: GetOutsResponse,
) -> Result<OutputWithDecoys, String> {
  match outs_resonse
    .outs
    .into_iter()
    .map(|outkey| convert_outkey_to_output_information(outkey))
    .collect()
  {
    Ok(outs) => {
      let input_json: InputJson = serde_json::from_str(input_sts)
        .map_err(|e| format!("failed to parse arguments JSON (missing or invalid field): {}", e))?;
      let output = read_output_from_string(&input_json.serialized_input)?;
      let mut rng = OsRng;
      let output = OutputWithDecoys::new_sync(&mut rng, 16, output, outs, input_json.candidates);
      output.map_err(|e| e.to_string())
    }
    Err(e) => Err(e),
  }
}

pub fn compute_key_image(
  output_hex_string: String,
  sender_spend_key: String,
) -> Result<String, String> {
  let output = read_output_from_string(&output_hex_string)?;

  let spend_bytes = <[u8; 32]>::from_hex(sender_spend_key).unwrap();
  let spend_scalar = Zeroizing::new(Scalar::from_canonical_bytes(spend_bytes).unwrap()); // okay to panic if spend_key is invalid

  let input_key = Zeroizing::new(spend_scalar.deref() + output.key_offset());
  if (input_key.deref() * ED25519_BASEPOINT_TABLE) != output.key() {
    Err("Wrong private key to compute key image for this output.")?;
  }
  let key_image = input_key.deref()
    * monero_wallet::generators::biased_hash_to_point(output.key().compress().to_bytes());
  Ok(hex::encode(key_image.compress().to_bytes()))
}
