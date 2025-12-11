use curve25519_dalek::Scalar;
use monero_wallet::{
  OutputWithDecoys, ViewPair,
  address::{MoneroAddress},
  ringct::RctType,
  rpc::{FeePriority, FeeRate, RpcError},
  send::{Change, SignableTransaction},
};
use std::{io::Cursor};
use hex::FromHex;
use rand_core::{OsRng, RngCore};
use serde::Deserialize;
use zeroize::Zeroizing;

pub fn sign_transaction(tx: String, sender_spend_key: String) -> Result<String, String> {
  let spend_bytes = <[u8; 32]>::from_hex(sender_spend_key).unwrap();
  let spend_scalar = Zeroizing::new(Scalar::from_canonical_bytes(spend_bytes).unwrap()); // okay to panic if spend_key is invalid

  let mut reader = Cursor::new(hex::decode(tx).unwrap());
  let transaction = SignableTransaction::read(&mut reader)
    .map_err(|e| format!("failed to read SignableTransaction: {:?}", e))?;
  Ok(hex::encode(
    transaction
      .sign(&mut OsRng, &spend_scalar)
      .map_err(|e| format!("failed to sign transaction: {:?}", e))?
      .serialize(),
  ))
}

pub fn read_one_input(input_bytes: &[u8]) -> Result<OutputWithDecoys, String> {
  let mut reader = Cursor::new(input_bytes);
  OutputWithDecoys::read(&mut reader)
    .map_err(|e| format!("failed to read  serialized input: {:?}", e))
}

pub fn read_inputs(vec_inputs: Vec<Vec<u8>>) -> Result<Vec<OutputWithDecoys>, String> {
  let mut inputs = Vec::with_capacity(vec_inputs.len());
  for input_bytes in vec_inputs {
    let input = read_one_input(&input_bytes)?;
    inputs.push(input);
  }
  Ok(inputs)
}
pub fn make_transaction(
  json_params: &str,
  viewpair: ViewPair,
  // inputs: Vec<OutputWithDecoys>,
  // payments: Vec<(MoneroAddress, u64)>,
  // OPTIONAL outgoing_view_key: Zeroizing<[u8; 32]>, default random if None
  // OPTIONAL: data: Vec<Vec<u8>>,
) -> Result<SignableTransaction, String> {
  let params = parse_make_transaction_params(json_params)?;
  let priority = parse_fee_priority(&params.fee_priority)?;
  let fee_rate = get_fee_rate(priority, params.fee_response).map_err(|e| {
    format!("failed to get fee rate (from fee priority + rpc get_fee_estimate response: {:?}", e)
  })?;
  let inputs = read_inputs(params.inputs)?;
  let payments = parse_payments(&params.payments)?;
  let change = Change::new(viewpair.clone(), None);
  let outgoing_view_key = match &params.outgoing_view_key {
    Some(s) => {
      let bytes: [u8; 32] = <[u8; 32]>::from_hex(s)
        .map_err(|e| format!("failed to parse outgoing_view_key hex: {:?}", e))?;
      Zeroizing::new(bytes)
    }
    None => {
      let mut outgoing_view = Zeroizing::new([0; 32]);
      OsRng.fill_bytes(&mut outgoing_view.as_mut()[..]);
      outgoing_view
    }
  };
  let data = params.data.unwrap_or(vec![]);
  SignableTransaction::new(
    RctType::ClsagBulletproofPlus,
    outgoing_view_key,
    inputs,
    payments,
    change,
    data,
    fee_rate,
  )
  .map_err(|e| format!("failed to create SignableTransaction {}", e))
}

#[derive(Debug, Deserialize)]
struct FeeResponse {
  // status: String,
  fees: Option<Vec<u64>>,
  fee: u64,
  quantization_mask: u64,
}

#[derive(Debug, Deserialize)]
struct PaymentJson {
  address: String,
  amount: String,
}

#[derive(Debug, Deserialize)]
struct MakeTransactionParams {
  inputs: Vec<Vec<u8>>,
  payments: Vec<PaymentJson>,
  fee_response: FeeResponse,
  fee_priority: String,
  outgoing_view_key: Option<String>,
  data: Option<Vec<Vec<u8>>>,
}
fn parse_payments(payments_json: &[PaymentJson]) -> Result<Vec<(MoneroAddress, u64)>, String> {
  let mut payments = Vec::with_capacity(payments_json.len());
  for payment in payments_json {
    let address = MoneroAddress::from_str_with_unchecked_network(&payment.address)
      .map_err(|e| format!("failed to parse payment address '{}' : {:?}", payment.address, e))?;
    let amount = payment
      .amount
      .parse::<u64>()
      .map_err(|e| format!("failed to parse payment amount '{}' : {:?}", payment.amount, e))?;
    payments.push((address, amount));
  }
  Ok(payments)
}
fn parse_make_transaction_params(json_str: &str) -> Result<MakeTransactionParams, String> {
  serde_json::from_str(json_str)
    .map_err(|e| format!("failed to parse make_transaction params json: {:?}", e))
}
fn parse_fee_priority(s: &str) -> Result<FeePriority, String> {
  match s.to_lowercase().as_str() {
    "unimportant" => Ok(FeePriority::Unimportant),
    "normal" => Ok(FeePriority::Normal),
    "elevated" => Ok(FeePriority::Elevated),
    "priority" => Ok(FeePriority::Priority),
    _ => {
      Err(format!("Invalid priority: '{}'. Must be: unimportant, normal, elevated, priority", s))
    }
  }
}
// adapted from monero_wallet::rpc::get_fee_rate
fn get_fee_rate(priority: FeePriority, res: FeeResponse) -> Result<FeeRate, RpcError> {
  if let Some(fees) = res.fees {
    // https://github.com/monero-project/monero/blob/94e67bf96bbc010241f29ada6abc89f49a81759c/
    // src/wallet/wallet2.cpp#L7615-L7620
    let priority_idx = usize::try_from(if priority.fee_priority() >= 4 {
      3
    } else {
      priority.fee_priority().saturating_sub(1)
    })
    .map_err(|_| RpcError::InvalidPriority)?;

    if priority_idx >= fees.len() {
      Err(RpcError::InvalidPriority)
    } else {
      FeeRate::new(fees[priority_idx], res.quantization_mask)
    }
  } else {
    // https://github.com/monero-project/monero/blob/94e67bf96bbc010241f29ada6abc89f49a81759c/
    //   src/wallet/wallet2.cpp#L7569-L7584
    // https://github.com/monero-project/monero/blob/94e67bf96bbc010241f29ada6abc89f49a81759c/
    //   src/wallet/wallet2.cpp#L7660-L7661
    let priority_idx =
      usize::try_from(if priority.fee_priority() == 0 { 1 } else { priority.fee_priority() - 1 })
        .map_err(|_| RpcError::InvalidPriority)?;
    let multipliers = [1, 5, 25, 1000];
    if priority_idx >= multipliers.len() {
      // though not an RPC error, it seems sensible to treat as such
      Err(RpcError::InvalidPriority)?;
    }
    let fee_multiplier = multipliers[priority_idx];

    FeeRate::new(res.fee * fee_multiplier, res.quantization_mask)
  }
}
