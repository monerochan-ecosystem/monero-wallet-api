use monero_wallet::Scanner;
use serde_json::json;

use crate::{
  GLOBAL_SCANNER,
  your_program::{input_string, output_error_string, output_string},
};

#[no_mangle]
pub extern "C" fn scan_transaction(tx_hex_len: usize) {
  let tx_hex = input_string(tx_hex_len);
  let result = GLOBAL_SCANNER.with_borrow(|scanner| scan_one_transaction(scanner, &tx_hex));
  match result {
    Ok(value) => output_string(&value.to_string()),
    Err(error) => output_error_string(&json!({"error": error}).to_string()),
  }
}

pub fn scan_one_transaction(scanner: &Scanner, tx_as_hex: &str) -> Result<serde_json::Value, String> {
  use monero_wallet::extra::PaymentId;
  use monero_wallet::transaction::{Pruned, Timelock, Transaction};
  use monero_wallet::NotTimelocked;

  let bytes = hex::decode(tx_as_hex).map_err(|_| "invalid transaction hex")?;
  let mut remaining = bytes.as_slice();
  let tx = Transaction::read(&mut remaining).map_err(|e| format!("invalid transaction: {e}"))?;
  if !remaining.is_empty() { return Err("trailing transaction data".into()); }
  let hash = tx.hash();
  let unlock_time = match tx.prefix().additional_timelock {
    Timelock::None => "0".to_string(),
    Timelock::Block(height) => height.to_string(),
    Timelock::Time(time) => time.to_string(),
  };
  let result = scanner.scan_transaction(None, hash, &Transaction::<Pruned>::from(tx))
    .map_err(|e| format!("transaction scan failed: {e}"))?;
  let NotTimelocked::OffChain(ref outputs) = result.ignore_additional_timelock() else {
    return Err("expected off-chain outputs".into());
  };
  let outputs: Vec<_> = outputs.iter().map(|output| {
    let payment_id = match output.payment_id() {
      Some(PaymentId::Encrypted(id)) => Some(u64::from_le_bytes(id).to_string()),
      _ => None,
    };
    json!({
      "amount": output.commitment().amount.to_string(),
      "index_in_transaction": output.index_in_transaction(),
      "stealth_address": hex::encode(output.key().compress().to_bytes()),
      "payment_id": payment_id,
      "subaddress_index": output.subaddress().map(|index| [index.account(), index.address()]),
    })
  }).collect();
  Ok(json!({"tx_hash": hex::encode(hash), "unlock_time": unlock_time, "outputs": outputs}))
}
