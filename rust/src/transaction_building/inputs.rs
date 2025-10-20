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
    key: CompressedEdwardsY(
      hex::decode(&outkey.key)
        .map_err(|e| e.to_string())?
        .try_into()
        .map_err(|_| "output key wasn't 32 bytes".to_string())?,
    ),
    commitment: CompressedPoint(
      hex::decode(&outkey.mask)
        .map_err(|e| e.to_string())?
        .try_into()
        .map_err(|_| "output mask wasn't 32 bytes".to_string())?,
    )
    .decompress()
    .ok_or("invalid point")?,
    transaction: hex::decode(&outkey.txid)
      .map_err(|e| e.to_string())?
      .try_into()
      .map_err(|_| "output txid wasn't 32 bytes".to_string())?,
  })
}
#[derive(Debug, Deserialize)]
struct InputJson {
  ring_len: u8,
  serialized_input: Vec<u8>,
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
    .collect::<Result<Vec<_>, String>>()
  {
    Ok(outs) => {
      let input_json: InputJson = serde_json::from_str(input_sts).unwrap();
      let mut reader = Cursor::new(input_json.serialized_input);
      let output = WalletOutput::read(&mut reader).unwrap();
      println!("{:?}", output);
      let mut rng = OsRng;
      let output = OutputWithDecoys::new_sync(
        &mut rng,
        input_json.ring_len,
        output,
        outs,
        input_json.candidates,
      );
      output.map_err(|e| e.to_string())
    }
    Err(e) => Err(e),
  }
}
