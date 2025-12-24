use monero_primitives::{keccak256_to_scalar};
use monero_wallet::{ViewPair, address::Network};
use curve25519_dalek::{Scalar, EdwardsPoint};

use rand_core::OsRng;
use zeroize::Zeroizing;

pub fn make_spendkey() -> Scalar {
  Scalar::random(&mut OsRng)
}
pub fn make_viewkey(spend_key: [u8; 32]) -> Scalar {
  keccak256_to_scalar(spend_key)
}
#[derive(serde::Serialize)]
pub struct ViewPairJson {
  view_key: String,
  mainnet_primary: String,
  stagenet_primary: String,
  testnet_primary: String,
}

pub fn viewpair_from_spendkey(spend_key: [u8; 32]) -> Result<ViewPairJson, String> {
  let spend_scalar = Scalar::from_canonical_bytes(spend_key).unwrap(); // okay to panic if spend_key is invalid
  let view_scalar = Zeroizing::new(make_viewkey(spend_key));
  let viewpair = ViewPair::new(EdwardsPoint::mul_base(&spend_scalar), view_scalar.clone())
    .map_err(|e| format!("failed to parse new Viewpair {}", e))?;

  let mainnet_primary = viewpair.legacy_address(Network::Mainnet).to_string();
  let stagenet_primary = viewpair.legacy_address(Network::Stagenet).to_string();
  let testnet_primary = viewpair.legacy_address(Network::Testnet).to_string();
  Ok(ViewPairJson {
    view_key: hex::encode(view_scalar.to_bytes()),
    mainnet_primary,
    stagenet_primary,
    testnet_primary,
  })
}
