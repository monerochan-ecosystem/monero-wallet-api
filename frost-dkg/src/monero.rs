use std::cell::RefCell;

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
// signing and preprocessing

fn write_unsigned_tx(tx: &monero_wallet::send::SignableTransaction) -> String {
  let mut buf = vec![];
  tx.write(&mut buf).unwrap();
  hex::encode(&buf)
}

fn write_signed_tx(tx: &monero_wallet::transaction::Transaction) -> String {
  let mut buf = vec![];
  tx.write(&mut buf).unwrap();
  hex::encode(&buf)
}

fn read_unsigned_tx(hex_str: &str) -> Result<monero_wallet::send::SignableTransaction, String> {
  use std::io::Cursor;
  let bytes = hex::decode(hex_str).map_err(|e| {
    serde_json::json!({"message": format!("invalid unsigned_tx hex: {e}")}).to_string()
  })?;
  monero_wallet::send::SignableTransaction::read(&mut Cursor::new(&bytes)).map_err(|e| {
    serde_json::json!({"message": format!("failed to read unsigned_tx: {e:?}")}).to_string()
  })
}

fn read_threshold_key(
  hex_str: &str,
) -> Result<modular_frost::dkg::ThresholdKeys<dalek_ff_group::Ed25519>, String> {
  use std::io::Cursor;
  let bytes = hex::decode(hex_str).map_err(|e| {
    serde_json::json!({"message": format!("invalid threshold_key hex: {e}")}).to_string()
  })?;
  modular_frost::dkg::ThresholdKeys::<dalek_ff_group::Ed25519>::read(&mut Cursor::new(&bytes))
    .map_err(|_| serde_json::json!({"message": "invalid threshold_key data"}).to_string())
}

thread_local! {
  static GLOBAL_SIGN_MACHINE: RefCell<Option<monero_wallet::send::TransactionSignMachine>> = RefCell::new(None);
  static GLOBAL_SIG_MACHINE: RefCell<Option<monero_wallet::send::TransactionSignatureMachine>> = RefCell::new(None);
}

/// Input: {"threshold_key":"hex","unsigned_tx":"hex"}
/// Output: {"preprocess":"hex"}
/// Stores the SignMachine in GLOBAL_SIGN_MACHINE for the next call.
#[no_mangle]
pub extern "C" fn monero_preprocess(json_len: usize) {
  use modular_frost::sign::{PreprocessMachine, Writable as _};

  let json_str = input_string(json_len);
  let v: serde_json::Value = match serde_json::from_str(&json_str) {
    Ok(v) => v,
    Err(e) => {
      output_error_string(
        serde_json::json!({"message": format!("invalid JSON: {e}")}).to_string().as_str(),
      );
      return;
    }
  };

  let threshold_key_hex = match v["threshold_key"].as_str() {
    Some(h) => h,
    None => {
      output_error_string(
        serde_json::json!({"message": "missing threshold_key"}).to_string().as_str(),
      );
      return;
    }
  };
  let keys = match read_threshold_key(threshold_key_hex) {
    Ok(k) => k,
    Err(e) => {
      output_error_string(&e);
      return;
    }
  };

  let unsigned_tx_hex = match v["unsigned_tx"].as_str() {
    Some(h) => h,
    None => {
      output_error_string(
        serde_json::json!({"message": "missing unsigned_tx"}).to_string().as_str(),
      );
      return;
    }
  };
  let msignable = match read_unsigned_tx(unsigned_tx_hex) {
    Ok(tx) => tx,
    Err(e) => {
      output_error_string(&e);
      return;
    }
  };

  let machine = match msignable.multisig(keys) {
    Ok(m) => m,
    Err(e) => {
      output_error_string(
        serde_json::json!({"message": format!("multisig failed: {e:?}")}).to_string().as_str(),
      );
      return;
    }
  };

  let (sign_machine, preprocess) = machine.preprocess(&mut rand_core::OsRng);

  GLOBAL_SIGN_MACHINE.with_borrow_mut(|sm| *sm = Some(sign_machine));

  output_string(
    serde_json::json!({"preprocess": hex::encode(preprocess.serialize())}).to_string().as_str(),
  );
}

/// Input: {"preprocesses":{"1":"hex","2":"hex",...}}
/// Output: {"share":"hex"}
/// Consumes GLOBAL_SIGN_MACHINE, stores GLOBAL_SIG_MACHINE.
#[no_mangle]
pub extern "C" fn monero_sign(json_len: usize) {
  use modular_frost::sign::{SignMachine, Writable as _};
  use std::collections::HashMap;

  let sign_machine = GLOBAL_SIGN_MACHINE
    .with_borrow_mut(|sm| sm.take())
    .expect("GLOBAL_SIGN_MACHINE is not initialized, call monero_preprocess first");

  let json_str = input_string(json_len);
  let v: serde_json::Value = match serde_json::from_str(&json_str) {
    Ok(v) => v,
    Err(e) => {
      output_error_string(
        serde_json::json!({"message": format!("invalid JSON: {e}")}).to_string().as_str(),
      );
      return;
    }
  };

  let preprocesses_obj = match v["preprocesses"].as_object() {
    Some(o) => o,
    None => {
      output_error_string(
        serde_json::json!({"message": "missing preprocesses object"}).to_string().as_str(),
      );
      return;
    }
  };

  let mut all_preprocesses = HashMap::new();
  for (key, val) in preprocesses_obj {
    let idx: u16 = match key.parse() {
      Ok(i) => i,
      Err(_) => {
        output_error_string(
          serde_json::json!({"message": format!("invalid participant index: {key}")})
            .to_string()
            .as_str(),
        );
        return;
      }
    };
    let p = match modular_frost::dkg::Participant::new(idx) {
      Some(p) => p,
      None => {
        output_error_string(
          serde_json::json!({"message": format!("invalid participant: {idx}")})
            .to_string()
            .as_str(),
        );
        return;
      }
    };
    let hex = match val.as_str() {
      Some(h) => h,
      None => {
        output_error_string(
          serde_json::json!({"message": "preprocesses entry not a string"}).to_string().as_str(),
        );
        return;
      }
    };
    let bytes = match hex::decode(hex) {
      Ok(b) => b,
      Err(e) => {
        output_error_string(
          serde_json::json!({"message": format!("invalid preprocess hex: {e}")})
            .to_string()
            .as_str(),
        );
        return;
      }
    };
    let pp = match sign_machine.read_preprocess(&mut std::io::Cursor::new(&bytes)) {
      Ok(pp) => pp,
      Err(_) => {
        output_error_string(
          serde_json::json!({"message": format!("invalid preprocess for participant {idx}")})
            .to_string()
            .as_str(),
        );
        return;
      }
    };
    all_preprocesses.insert(p, pp);
  }

  let (sig_machine, share) = match sign_machine.sign(all_preprocesses, &[]) {
    Ok(r) => r,
    Err(e) => {
      output_error_string(
        serde_json::json!({"message": format!("sign failed: {e:?}")}).to_string().as_str(),
      );
      return;
    }
  };

  GLOBAL_SIG_MACHINE.with_borrow_mut(|sm| *sm = Some(sig_machine));

  output_string(serde_json::json!({"share": hex::encode(share.serialize())}).to_string().as_str());
}

/// Input: {"shares":{"1":"hex","2":"hex",...}}
/// Output: {"signed_tx":"hex"}
/// Consumes GLOBAL_SIG_MACHINE.
#[no_mangle]
pub extern "C" fn monero_complete(json_len: usize) {
  use modular_frost::sign::SignatureMachine;
  use std::collections::HashMap;

  let sig_machine = GLOBAL_SIG_MACHINE
    .with_borrow_mut(|sm| sm.take())
    .expect("GLOBAL_SIG_MACHINE is not initialized, call monero_sign first");

  let json_str = input_string(json_len);
  let v: serde_json::Value = match serde_json::from_str(&json_str) {
    Ok(v) => v,
    Err(e) => {
      output_error_string(
        serde_json::json!({"message": format!("invalid JSON: {e}")}).to_string().as_str(),
      );
      return;
    }
  };

  let shares_obj = match v["shares"].as_object() {
    Some(o) => o,
    None => {
      output_error_string(
        serde_json::json!({"message": "missing shares object"}).to_string().as_str(),
      );
      return;
    }
  };

  let mut all_shares = HashMap::new();
  for (key, val) in shares_obj {
    let idx: u16 = match key.parse() {
      Ok(i) => i,
      Err(_) => {
        output_error_string(
          serde_json::json!({"message": format!("invalid participant index: {key}")})
            .to_string()
            .as_str(),
        );
        return;
      }
    };
    let p = match modular_frost::dkg::Participant::new(idx) {
      Some(p) => p,
      None => {
        output_error_string(
          serde_json::json!({"message": format!("invalid participant: {idx}")})
            .to_string()
            .as_str(),
        );
        return;
      }
    };
    let hex = match val.as_str() {
      Some(h) => h,
      None => {
        output_error_string(
          serde_json::json!({"message": "shares entry not a string"}).to_string().as_str(),
        );
        return;
      }
    };
    let bytes = match hex::decode(hex) {
      Ok(b) => b,
      Err(e) => {
        output_error_string(
          serde_json::json!({"message": format!("invalid share hex: {e}")}).to_string().as_str(),
        );
        return;
      }
    };
    let share = match sig_machine.read_share(&mut std::io::Cursor::new(&bytes)) {
      Ok(s) => s,
      Err(_) => {
        output_error_string(
          serde_json::json!({"message": format!("invalid share for participant {idx}")})
            .to_string()
            .as_str(),
        );
        return;
      }
    };
    all_shares.insert(p, share);
  }

  let signed_tx = match sig_machine.complete(all_shares) {
    Ok(tx) => tx,
    Err(e) => {
      output_error_string(
        serde_json::json!({"message": format!("complete failed: {e:?}")}).to_string().as_str(),
      );
      return;
    }
  };

  output_string(serde_json::json!({"signed_tx": write_signed_tx(&signed_tx)}).to_string().as_str());
}
