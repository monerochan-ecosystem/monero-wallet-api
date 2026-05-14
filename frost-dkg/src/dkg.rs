struct Ed25519Dkg;
impl dkg_evrf::Curves for Ed25519Dkg {
  type ToweringCurve = modular_frost::curve::Ed25519;
  type EmbeddedCurve = embedwards25519::Embedwards25519;
  type EmbeddedCurveParameters = embedwards25519::Embedwards25519;
}

use crate::your_program::{input, input_string, output_string, output_error_string};
use ciphersuite::group::GroupEncoding;
use zeroize::Zeroizing;

// Cached generators (deterministic, expensive to create)
fn setup_generators_internal(
  max_threshold: u16,
  max_participants: u16,
) -> &'static dkg_evrf::Generators<Ed25519Dkg> {
  static G: std::sync::OnceLock<dkg_evrf::Generators<Ed25519Dkg>> = std::sync::OnceLock::new();
  G.get_or_init(|| dkg_evrf::Generators::new(max_threshold, max_participants))
}
fn generators() -> &'static dkg_evrf::Generators<Ed25519Dkg> {
  setup_generators_internal(16, 16)
}
/// if you never call this method, the generators will be created on first use,
/// with defaults to max_threshold 16 and max_participants 16
#[no_mangle]
pub extern "C" fn setup_generators(max_threshold: u16, max_participants: u16) {
  setup_generators_internal(max_threshold, max_participants);
}

/// Generate a DKG public key from a DKG secret key
/// dkg_secret_key_bytes: 64 bytes
/// output value: {"dkg_public_key": hex_key}
/// output error: {"message":"expected exactly 64 bytes for DKG secret key"}
#[no_mangle]

pub fn dkg_get_public_key() {
  use ciphersuite::group::GroupEncoding;
  use ciphersuite::WrappedGroup;
  use ciphersuite::FromUniformBytes;

  type EC = embedwards25519::Embedwards25519;

  let dkg_secret_key_bytes = input(64);

  let arr: [u8; 64] = match dkg_secret_key_bytes.try_into() {
    Ok(a) => a,
    Err(_) => {
      output_error_string(
        serde_json::json!({"message":"expected exactly 64 bytes for DKG secret   
 key"})
        .to_string()
        .as_str(),
      );
      return;
    }
  };

  let dkg_secret_key = Zeroizing::new(embedwards25519::Scalar::from_uniform_bytes(&arr));
  let dkg_public_key = <EC as WrappedGroup>::generator() * *dkg_secret_key;

  let hex_key = hex::encode(dkg_public_key.to_bytes());
  output_string(serde_json::json!({"dkg_public_key": hex_key}).to_string().as_str());
}

/// Participate in a DKG round.                                                          
/// Input JSON:{"dkg_secret_key":"hex64","context":"hex32","dkg_public_keys":["hex32",...],"t":2}         
/// Output JSON: {"participation":"hex_binary"}  or  {"message":"..."}                   
#[no_mangle]
pub extern "C" fn dkg_participate(json_len: usize) {
  use rand_core::OsRng;

  type EC = embedwards25519::Embedwards25519;

  let json_str = input_string(json_len);
  let v: serde_json::Value = match serde_json::from_str(&json_str) {
    Ok(v) => v,
    Err(e) => {
      output_error_string(
        serde_json::json!({"message":format!("invalid JSON: {}", e)}).to_string().as_str(),
      );
      return;
    }
  };

  let evrf_private_key = match read_dkg_secret_key(&v) {
    Ok(k) => k,
    Err(e) => {
      output_error_string(&e);
      return;
    }
  };

  let context = match read_context(&v) {
    Ok(c) => c,
    Err(e) => {
      output_error_string(&e);
      return;
    }
  };

  let pubkeys = match read_pubkey_array::<EC>(&v) {
    Ok(p) => p,
    Err(e) => {
      output_error_string(&e);
      return;
    }
  };

  let t = match read_threshold(&v, pubkeys.len()) {
    Ok(t) => t,
    Err(e) => {
      output_error_string(&e);
      return;
    }
  };

  let gens = generators();
  let participation = match dkg_evrf::Dkg::<Ed25519Dkg>::participate(
    &mut OsRng,
    gens,
    context,
    t,
    &pubkeys,
    &evrf_private_key,
  ) {
    Ok(p) => p,
    Err(e) => {
      output_error_string(
        serde_json::json!({"message":format!("DKG participate failed: {:?}",     
 e)})
        .to_string()
        .as_str(),
      );
      return;
    }
  };

  let mut buf = Vec::new();
  participation.write(&mut buf).unwrap();
  output_string(serde_json::json!({"participation": hex::encode(&buf)}).to_string().as_str());
}

/// Verify participations and extract the group key.                                                               
/// Input JSON: {"dkg_secret_key":"hex64","context":"hex32","t":2,                                                 
///              "dkg_public_keys":["hex32",...],                                                                  
///              "participations":{"1":"hex","2":"hex","3":"hex"}}                                                 
/// Output: {"group_key":"hex32","t":2,"n":3}                                                                      
///      or: {"faulty_participants":[1]}                                                                           
///      or: {"message":"NotEnoughParticipants"}                                                                   
#[no_mangle]
pub extern "C" fn dkg_verify(json_len: usize) {
  use rand_core::OsRng;

  type EC = embedwards25519::Embedwards25519;

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

  let evrf_private_key = match read_dkg_secret_key(&v) {
    Ok(k) => k,
    Err(e) => {
      output_error_string(&e);
      return;
    }
  };
  let context = match read_context(&v) {
    Ok(c) => c,
    Err(e) => {
      output_error_string(&e);
      return;
    }
  };
  let pubkeys = match read_pubkey_array::<EC>(&v) {
    Ok(p) => p,
    Err(e) => {
      output_error_string(&e);
      return;
    }
  };
  let t = match read_threshold(&v, pubkeys.len()) {
    Ok(t) => t,
    Err(e) => {
      output_error_string(&e);
      return;
    }
  };
  let n = pubkeys.len() as u16;

  let participations = match read_participations(&v, t, n) {
    Ok(p) => p,
    Err(e) => {
      output_error_string(&e);
      return;
    }
  };

  let gens = generators();
  match dkg_evrf::Dkg::<Ed25519Dkg>::verify(&mut OsRng, gens, context, t, &pubkeys, &participations)
  {
    Ok(dkg_evrf::VerifyResult::Valid(ref dkg)) => {
      let keys = dkg.keys(&evrf_private_key);
      if keys.is_empty() {
        output_error_string(
          serde_json::json!({"message": "no key shares match this private key"})
            .to_string()
            .as_str(),
        );
        return;
      }
      output_string(
        serde_json::json!({
            "group_key": hex::encode(keys[0].group_key().to_bytes()),
            "t": keys[0].params().t(),
            "n": keys[0].params().n()
        })
        .to_string()
        .as_str(),
      );
    }
    Ok(dkg_evrf::VerifyResult::Invalid(faulty)) => {
      let faulty: Vec<u16> = faulty.into_iter().map(|p| p.into()).collect();
      output_string(serde_json::json!({"faulty_participants": faulty}).to_string().as_str());
    }
    Ok(dkg_evrf::VerifyResult::NotEnoughParticipants) => {
      output_string(serde_json::json!({"message": "NotEnoughParticipants"}).to_string().as_str());
    }
    Err(e) => {
      output_error_string(
        serde_json::json!({"message": format!("DKG verify error: {:?}", e)}).to_string().as_str(),
      );
    }
  }
}

// helpers

fn read_dkg_secret_key(
  v: &serde_json::Value,
) -> Result<Zeroizing<embedwards25519::Scalar>, String> {
  use ciphersuite::FromUniformBytes;

  let hex = v["dkg_secret_key"].as_str().ok_or_else(|| {
    serde_json::json!({"message": "missing                            
 dkg_secret_key"})
    .to_string()
  })?;
  let bytes = hex::decode(hex).map_err(|e| {
    serde_json::json!({"message": format!("invalid dkg_secret_key hex:  
 {e}")})
    .to_string()
  })?;
  let arr: [u8; 64] = bytes.try_into().map_err(|_| {
    serde_json::json!({"message": "dkg_secret_key must be 64            
 bytes"})
    .to_string()
  })?;
  Ok(Zeroizing::new(embedwards25519::Scalar::from_uniform_bytes(&arr)))
}

fn read_context(v: &serde_json::Value) -> Result<[u8; 32], String> {
  let hex = v["context"]
    .as_str()
    .ok_or_else(|| serde_json::json!({"message": "missing context"}).to_string())?;
  let bytes = hex::decode(hex).map_err(|e| {
    serde_json::json!({"message": format!("invalid context hex:         
 {e}")})
    .to_string()
  })?;
  if bytes.len() != 32 {
    return Err(
      serde_json::json!({"message": "context must be 32                     
 bytes"})
      .to_string(),
    );
  }
  let mut ctx = [0u8; 32];
  ctx.copy_from_slice(&bytes);
  Ok(ctx)
}

fn read_pubkey_array<C: ciphersuite::WrappedGroup + ciphersuite::GroupIo>(
  v: &serde_json::Value,
) -> Result<Vec<C::G>, String> {
  use std::io::Cursor;

  let arr = v["dkg_public_keys"].as_array().ok_or_else(|| {
    serde_json::json!({"message": "missing dkg_public_keys            
 array"})
    .to_string()
  })?;

  let mut pubkeys = Vec::new();
  for key_val in arr {
    let hex = key_val.as_str().ok_or_else(|| {
      serde_json::json!({"message": "dkg_public_keys entry not a    
 string"})
      .to_string()
    })?;
    let bytes = hex::decode(hex).map_err(|e| {
      serde_json::json!({"message": format!("invalid dkg_public_key   
 hex: {e}")})
      .to_string()
    })?;
    let mut cursor = Cursor::new(&bytes);
    let point = C::read_G(&mut cursor).map_err(|_| {
      serde_json::json!({"message": "invalid dkg_public_key           
 point"})
      .to_string()
    })?;
    pubkeys.push(point);
  }
  Ok(pubkeys)
}

fn read_threshold(v: &serde_json::Value, n: usize) -> Result<u16, String> {
  let t = v["t"].as_u64().ok_or_else(|| serde_json::json!({"message": "missing t"}).to_string())?;
  if t == 0 || t > n as u64 {
    return Err(
      serde_json::json!({"message": format!("t must be between 1 and        
 {n}")})
      .to_string(),
    );
  }
  Ok(t as u16)
}

fn read_participations(
  v: &serde_json::Value,
  t: u16,
  n: u16,
) -> Result<
  std::collections::HashMap<dkg_evrf::Participant, dkg_evrf::Participation<Ed25519Dkg>>,
  String,
> {
  let parts = v["participations"].as_object().ok_or_else(|| {
    serde_json::json!({"message": "missing participations             
 object"})
    .to_string()
  })?;

  let mut map = std::collections::HashMap::new();
  for (key, val) in parts {
    let idx: u16 = key.parse().map_err(|_| {
      serde_json::json!({"message": format!("invalid participant      
 index: {key}")})
      .to_string()
    })?;
    let participant = dkg_evrf::Participant::new(idx).ok_or_else(|| {
      serde_json::json!({"message": format!("invalid participant    
 index: {idx}")})
      .to_string()
    })?;

    let hex = val.as_str().ok_or_else(|| {
      serde_json::json!({"message": "participation value not a      
 string"})
      .to_string()
    })?;
    let bytes = hex::decode(hex).map_err(|e| {
      serde_json::json!({"message": format!("invalid participation    
 hex: {e}")})
      .to_string()
    })?;

    let mut cursor = std::io::Cursor::new(&bytes);
    let participation =
      dkg_evrf::Participation::<Ed25519Dkg>::read(&mut cursor, t, n).map_err(|_| {
        serde_json::json!({"message": format!("invalid participation    
 for participant {idx}")})
        .to_string()
      })?;

    map.insert(participant, participation);
  }
  Ok(map)
}
