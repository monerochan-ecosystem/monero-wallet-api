use zeroize::Zeroizing;
use crate::your_program::{input_string, output_string, output_error_string};

/// Input JSON: {"spend_public_key":"hex32","view_secret_key":"hex32"}
///
/// Output:
///{"view_key":"hex32",
/// "mainnet_primary":"...",
/// "stagenet_primary":"...",
/// "testnet_primary":"..."
///}
///
/// spend_public_key is the group_key hex from dkg_verify output
#[no_mangle]
pub extern "C" fn dkg_get_monero_address(json_len: usize) {
  use monero_wallet::{ed25519::CompressedPoint, address::Network, ViewPair};

  let json_str = input_string(json_len);
  let v: serde_json::Value = match serde_json::from_str(&json_str) {
    Ok(v) => v,
    Err(e) => {
      output_error_string(
        serde_json::json!({"message": format!("invalid JSON:{e}")}).to_string().as_str(),
      );
      return;
    }
  };

  let spend_key = match read_spend_public_key(&v) {
    Ok(k) => k,
    Err(e) => {
      output_error_string(&e);
      return;
    }
  };
  let view_secret = match read_view_secret_key(&v) {
    Ok(k) => k,
    Err(e) => {
      output_error_string(&e);
      return;
    }
  };

  let compressed = CompressedPoint::from(spend_key);
  let spend_pub = match compressed.decompress() {
    Some(p) => p,
    None => {
      output_error_string(
        serde_json::json!({"message": "invalid spend_public_key point"}).to_string().as_str(),
      );
      return;
    }
  };

  let viewpair = match ViewPair::new(spend_pub, Zeroizing::new(*view_secret)) {
    Ok(v) => v,
    Err(e) => {
      output_error_string(
        serde_json::json!({"message": format!("failed to create ViewPair: {e}")})
          .to_string()
          .as_str(),
      );
      return;
    }
  };

  output_string(
    serde_json::json!({
    "view_key": hex::encode(<[u8; 32]>::from(*view_secret)),
           "mainnet_primary": viewpair.legacy_address(Network::Mainnet).to_string(),
           "stagenet_primary": viewpair.legacy_address(Network::Stagenet).to_string(),
           "testnet_primary": viewpair.legacy_address(Network::Testnet).to_string(),
       })
    .to_string()
    .as_str(),
  );
}

fn read_spend_public_key(v: &serde_json::Value) -> Result<[u8; 32], String> {
  let hex = v["spend_public_key"]
    .as_str()
    .ok_or_else(|| serde_json::json!({"message": "missing spend_public_key"}).to_string())?;
  let bytes = hex::decode(hex).map_err(|e| {
    serde_json::json!({"message": format!("invalid spend_public_key hex: {e}")}).to_string()
  })?;
  bytes.try_into().map_err(|_| {
    serde_json::json!({"message": "spend_public_key must be 32 bytes(the group_key hex from dkg_verify output)"})
    .to_string()
  })
}

fn read_view_secret_key(
  v: &serde_json::Value,
) -> Result<Zeroizing<monero_wallet::ed25519::Scalar>, String> {
  use monero_wallet::ed25519::Scalar;
  use std::io::Cursor;

  let hex = v["view_secret_key"]
    .as_str()
    .ok_or_else(|| serde_json::json!({"message": "missing view_secret_key"}).to_string())?;
  let bytes = hex::decode(hex).map_err(|e| {
    serde_json::json!({"message": format!("invalid view_secret_key hex: {e}")}).to_string()
  })?;
  if bytes.len() != 32 {
    return Err(serde_json::json!({"message": "view_secret_key must be 32 bytes"}).to_string());
  }
  let scalar = Scalar::read(&mut Cursor::new(&bytes))
    .map_err(|_| serde_json::json!({"message": "invalid view_secret_key scalar"}).to_string())?;
  Ok(Zeroizing::new(scalar))
}
