//! frost-dkg: Standalone eVRF DKG + FROST signing with a JSON-friendly API.
//!
//! This crate wraps serai's eVRF DKG and modular-frost into a
//! JSON serialization-friendly API, callable from C.
//!
//! All messages are JSON-serializable for
//! transport over network, QR codes, USB, etc.
pub mod dkg;
pub mod monero;

pub(crate) mod your_program {
  /// implement input & output in your program to share arrays with the frost-dkg crate
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
  #[allow(dead_code)]
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

// Run a demo DKG with 3 participants, return the group key as hex.
//#[no_mangle]
// pub extern "C" fn demo_dkg() {
//   use rand_core::{OsRng, RngCore};
//   use ciphersuite::{WrappedGroup};
//   use ciphersuite::group::{GroupEncoding};
//   use zeroize::Zeroizing;
//   use std::collections::HashMap;
//   use ciphersuite::FromUniformBytes;

//   let t = 2;
//   let total_n: i32 = 3;

//   let mut bytes = [0u8; 64];
//   OsRng.fill_bytes(&mut bytes);

//   type EC = embedwards25519::Embedwards25519;

//   let mut keypairs = Vec::new();
//   for _ in 0..total_n {
//     let sk = Zeroizing::new(embedwards25519::Scalar::from_uniform_bytes(&bytes));
//     let pk = <EC as WrappedGroup>::generator() * *sk;
//     keypairs.push((sk, pk));
//   }
//   let pubkeys: Vec<_> = keypairs.iter().map(|(_, pk)| *pk).collect();

//   let mut context = [0u8; 32];
//   OsRng.fill_bytes(&mut context);

//   let gens = generators();

//   let mut participations = HashMap::new();
//   for (i, (sk, _)) in keypairs.iter().enumerate() {
//     let p =
//       dkg_evrf::Dkg::<Ed25519Dkg>::participate(&mut OsRng, gens, context, t, &pubkeys, sk).unwrap();
//     participations.insert(dkg_evrf::Participant::new(i as u16 + 1).unwrap(), p);
//   }

//   let result =
//     dkg_evrf::Dkg::<Ed25519Dkg>::verify(&mut OsRng, gens, context, t, &pubkeys, &participations)
//       .unwrap();

//   match result {
//     dkg_evrf::VerifyResult::Valid(ref dkg) => {
//       let keys = dkg.keys(&keypairs[0].0);
//       println!("group key: {}", hex::encode(keys[0].group_key().to_bytes()))
//     }
//     _ => panic!("DKG failed"),
//   }
// }
// #[cfg(test)]
// mod tests {

//   #[test]
//   fn three_party_dkg() {
//     // demo_dkg();
//   }
// }
