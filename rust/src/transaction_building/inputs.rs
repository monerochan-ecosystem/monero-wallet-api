use core::{fmt::Debug};
use cuprate_rpc_types::{bin::GetOutsResponse, misc::OutKeyBin};
use monero_io::CompressedPoint;
use rand_core::OsRng;
use std::{io::Cursor};

use curve25519_dalek::{
  edwards::{CompressedEdwardsY},
};
use monero_wallet::{rpc::OutputInformation, OutputWithDecoys, WalletOutput};
use serde::Deserialize;

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
      let serialized_input: Vec<u8> = hex::decode(input_json.serialized_input).unwrap();
      let mut reader = Cursor::new(serialized_input);
      let output = WalletOutput::read(&mut reader)
        .map_err(|e| format!("failed to read WalletOutput from serialized input: {:?}", e))?;
      let mut rng = OsRng;
      let output = OutputWithDecoys::new_sync(&mut rng, 16, output, outs, input_json.candidates);
      output.map_err(|e| e.to_string())
    }
    Err(e) => Err(e),
  }
}
