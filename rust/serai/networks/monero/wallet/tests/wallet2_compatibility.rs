use rand_core::{OsRng, RngCore};

use serde::Deserialize;
use serde_json::json;

use monero_simple_request_rpc::SimpleRequestRpc;
use monero_wallet::{
  transaction::Transaction,
  rpc::{FeePriority, Rpc},
  address::{Network, SubaddressIndex, MoneroAddress},
  extra::{MAX_ARBITRARY_DATA_SIZE, Extra, PaymentId},
  Scanner,
};

mod runner;

#[derive(Clone, Copy, PartialEq, Eq)]
enum AddressSpec {
  Legacy,
  LegacyIntegrated([u8; 8]),
  Subaddress(SubaddressIndex),
}

#[derive(Deserialize, Debug)]
struct EmptyResponse {}

async fn make_integrated_address(rpc: &SimpleRequestRpc, payment_id: [u8; 8]) -> String {
  #[derive(Debug, Deserialize)]
  struct IntegratedAddressResponse {
    integrated_address: String,
  }

  let res = rpc
    .json_rpc_call::<IntegratedAddressResponse>(
      "make_integrated_address",
      Some(json!({ "payment_id": hex::encode(payment_id) })),
    )
    .await
    .unwrap();

  res.integrated_address
}

async fn initialize_rpcs() -> (SimpleRequestRpc, SimpleRequestRpc, MoneroAddress) {
  let wallet_rpc = SimpleRequestRpc::new("http://127.0.0.1:18082".to_string()).await.unwrap();
  let daemon_rpc = runner::rpc().await;

  #[derive(Debug, Deserialize)]
  struct AddressResponse {
    address: String,
  }

  let mut wallet_id = [0; 8];
  OsRng.fill_bytes(&mut wallet_id);
  let _: EmptyResponse = wallet_rpc
    .json_rpc_call(
      "create_wallet",
      Some(json!({ "filename": hex::encode(wallet_id), "language": "English" })),
    )
    .await
    .unwrap();

  let address: AddressResponse =
    wallet_rpc.json_rpc_call("get_address", Some(json!({ "account_index": 0 }))).await.unwrap();

  // Fund the new wallet
  let address = MoneroAddress::from_str(Network::Mainnet, &address.address).unwrap();
  daemon_rpc.generate_blocks(&address, 70).await.unwrap();

  (wallet_rpc, daemon_rpc, address)
}

async fn from_wallet_rpc_to_self(spec: AddressSpec) {
  // initialize rpc
  let (wallet_rpc, daemon_rpc, wallet_rpc_addr) = initialize_rpcs().await;

  // make an addr
  let (_, view_pair, _) = runner::random_address();
  let addr = match spec {
    AddressSpec::Legacy => view_pair.legacy_address(Network::Mainnet),
    AddressSpec::LegacyIntegrated(payment_id) => {
      view_pair.legacy_integrated_address(Network::Mainnet, payment_id)
    }
    AddressSpec::Subaddress(index) => view_pair.subaddress(Network::Mainnet, index),
  };

  // refresh & make a tx
  let _: EmptyResponse = wallet_rpc.json_rpc_call("refresh", None).await.unwrap();

  #[derive(Debug, Deserialize)]
  struct TransferResponse {
    tx_hash: String,
  }
  let tx: TransferResponse = wallet_rpc
    .json_rpc_call(
      "transfer",
      Some(json!({
        "destinations": [{"address": addr.to_string(), "amount": 1_000_000_000_000u64 }],
      })),
    )
    .await
    .unwrap();
  let tx_hash = hex::decode(tx.tx_hash).unwrap().try_into().unwrap();

  let fee_rate = daemon_rpc.get_fee_rate(FeePriority::Unimportant).await.unwrap();

  // unlock it
  let block = runner::mine_until_unlocked(&daemon_rpc, &wallet_rpc_addr, tx_hash).await;
  let block = daemon_rpc.get_scannable_block(block).await.unwrap();

  // Create the scanner
  let mut scanner = Scanner::new(view_pair);
  if let AddressSpec::Subaddress(index) = spec {
    scanner.register_subaddress(index);
  }

  // Retrieve it and scan it
  let output = scanner.scan(block).unwrap().not_additionally_locked().swap_remove(0);
  assert_eq!(output.transaction(), tx_hash);

  runner::check_weight_and_fee(&daemon_rpc.get_transaction(tx_hash).await.unwrap(), fee_rate);

  match spec {
    AddressSpec::Subaddress(index) => {
      assert_eq!(output.subaddress(), Some(index));
      assert_eq!(output.payment_id(), Some(PaymentId::Encrypted([0u8; 8])));
    }
    AddressSpec::LegacyIntegrated(payment_id) => {
      assert_eq!(output.payment_id(), Some(PaymentId::Encrypted(payment_id)));
      assert_eq!(output.subaddress(), None);
    }
    AddressSpec::Legacy => {
      assert_eq!(output.subaddress(), None);
      assert_eq!(output.payment_id(), Some(PaymentId::Encrypted([0u8; 8])));
    }
  }
  assert_eq!(output.commitment().amount, 1000000000000);
}

async_sequential!(
  async fn receipt_of_wallet_rpc_tx_standard() {
    from_wallet_rpc_to_self(AddressSpec::Legacy).await;
  }

  async fn receipt_of_wallet_rpc_tx_subaddress() {
    from_wallet_rpc_to_self(AddressSpec::Subaddress(SubaddressIndex::new(0, 1).unwrap())).await;
  }

  async fn receipt_of_wallet_rpc_tx_integrated() {
    let mut payment_id = [0u8; 8];
    OsRng.fill_bytes(&mut payment_id);
    from_wallet_rpc_to_self(AddressSpec::LegacyIntegrated(payment_id)).await;
  }
);

#[derive(PartialEq, Eq, Debug, Deserialize)]
struct Index {
  major: u32,
  minor: u32,
}

#[derive(Debug, Deserialize)]
struct Transfer {
  payment_id: String,
  subaddr_index: Index,
  amount: u64,
}

#[derive(Debug, Deserialize)]
struct TransfersResponse {
  transfer: Transfer,
  transfers: Vec<Transfer>,
}

test!(
  send_to_wallet_rpc_standard,
  (
    |_, mut builder: Builder, _| async move {
      // initialize rpc
      let (wallet_rpc, _, wallet_rpc_addr) = initialize_rpcs().await;

      // add destination
      builder.add_payment(wallet_rpc_addr, 1000000);
      (builder.build().unwrap(), wallet_rpc)
    },
    |_, _, tx: Transaction, _, data: SimpleRequestRpc| async move {
      // confirm receipt
      let _: EmptyResponse = data.json_rpc_call("refresh", None).await.unwrap();
      let transfer: TransfersResponse = data
        .json_rpc_call("get_transfer_by_txid", Some(json!({ "txid": hex::encode(tx.hash()) })))
        .await
        .unwrap();
      assert_eq!(transfer.transfer.subaddr_index, Index { major: 0, minor: 0 });
      assert_eq!(transfer.transfer.amount, 1000000);
      assert_eq!(transfer.transfer.payment_id, hex::encode([0u8; 8]));
    },
  ),
);

test!(
  send_to_wallet_rpc_subaddress,
  (
    |_, mut builder: Builder, _| async move {
      // initialize rpc
      let (wallet_rpc, _, _) = initialize_rpcs().await;

      // make the subaddress
      #[derive(Debug, Deserialize)]
      struct AccountResponse {
        address: String,
        account_index: u32,
      }
      let addr: AccountResponse = wallet_rpc.json_rpc_call("create_account", None).await.unwrap();
      assert!(addr.account_index != 0);

      builder
        .add_payment(MoneroAddress::from_str(Network::Mainnet, &addr.address).unwrap(), 1000000);
      (builder.build().unwrap(), (wallet_rpc, addr.account_index))
    },
    |_, _, tx: Transaction, _, data: (SimpleRequestRpc, u32)| async move {
      // confirm receipt
      let _: EmptyResponse = data.0.json_rpc_call("refresh", None).await.unwrap();
      let transfer: TransfersResponse = data
        .0
        .json_rpc_call(
          "get_transfer_by_txid",
          Some(json!({ "txid": hex::encode(tx.hash()), "account_index": data.1 })),
        )
        .await
        .unwrap();
      assert_eq!(transfer.transfer.subaddr_index, Index { major: data.1, minor: 0 });
      assert_eq!(transfer.transfer.amount, 1000000);
      assert_eq!(transfer.transfer.payment_id, hex::encode([0u8; 8]));

      // Make sure only one R was included in TX extra
      assert!(Extra::read::<&[u8]>(&mut tx.prefix().extra.as_ref())
        .unwrap()
        .keys()
        .unwrap()
        .1
        .is_none());
    },
  ),
);

test!(
  send_to_wallet_rpc_subaddresses,
  (
    |_, mut builder: Builder, _| async move {
      // initialize rpc
      let (wallet_rpc, daemon_rpc, _) = initialize_rpcs().await;

      // make the subaddress
      #[derive(Debug, Deserialize)]
      struct AddressesResponse {
        addresses: Vec<String>,
        address_index: u32,
      }
      let addrs: AddressesResponse = wallet_rpc
        .json_rpc_call("create_address", Some(json!({ "account_index": 0, "count": 2 })))
        .await
        .unwrap();
      assert!(addrs.address_index != 0);
      assert!(addrs.addresses.len() == 2);

      builder.add_payments(&[
        (MoneroAddress::from_str(Network::Mainnet, &addrs.addresses[0]).unwrap(), 1000000),
        (MoneroAddress::from_str(Network::Mainnet, &addrs.addresses[1]).unwrap(), 2000000),
      ]);
      (builder.build().unwrap(), (wallet_rpc, daemon_rpc, addrs.address_index))
    },
    |_, _, tx: Transaction, _, data: (SimpleRequestRpc, SimpleRequestRpc, u32)| async move {
      // confirm receipt
      let _: EmptyResponse = data.0.json_rpc_call("refresh", None).await.unwrap();
      let transfer: TransfersResponse = data
        .0
        .json_rpc_call(
          "get_transfer_by_txid",
          Some(json!({ "txid": hex::encode(tx.hash()), "account_index": 0 })),
        )
        .await
        .unwrap();

      assert_eq!(transfer.transfers.len(), 2);
      for t in transfer.transfers {
        match t.amount {
          1000000 => assert_eq!(t.subaddr_index, Index { major: 0, minor: data.2 }),
          2000000 => assert_eq!(t.subaddr_index, Index { major: 0, minor: data.2 + 1 }),
          _ => unreachable!(),
        }
      }

      // Make sure 3 additional pub keys are included in TX extra
      let keys =
        Extra::read::<&[u8]>(&mut tx.prefix().extra.as_ref()).unwrap().keys().unwrap().1.unwrap();

      assert_eq!(keys.len(), 3);
    },
  ),
);

test!(
  send_to_wallet_rpc_integrated,
  (
    |_, mut builder: Builder, _| async move {
      // initialize rpc
      let (wallet_rpc, _, _) = initialize_rpcs().await;

      // make the addr
      let mut payment_id = [0u8; 8];
      OsRng.fill_bytes(&mut payment_id);
      let addr = make_integrated_address(&wallet_rpc, payment_id).await;

      builder.add_payment(MoneroAddress::from_str(Network::Mainnet, &addr).unwrap(), 1000000);
      (builder.build().unwrap(), (wallet_rpc, payment_id))
    },
    |_, _, tx: Transaction, _, data: (SimpleRequestRpc, [u8; 8])| async move {
      // confirm receipt
      let _: EmptyResponse = data.0.json_rpc_call("refresh", None).await.unwrap();
      let transfer: TransfersResponse = data
        .0
        .json_rpc_call("get_transfer_by_txid", Some(json!({ "txid": hex::encode(tx.hash()) })))
        .await
        .unwrap();
      assert_eq!(transfer.transfer.subaddr_index, Index { major: 0, minor: 0 });
      assert_eq!(transfer.transfer.payment_id, hex::encode(data.1));
      assert_eq!(transfer.transfer.amount, 1000000);
    },
  ),
);

test!(
  send_to_wallet_rpc_with_arb_data,
  (
    |_, mut builder: Builder, _| async move {
      // initialize rpc
      let (wallet_rpc, _, wallet_rpc_addr) = initialize_rpcs().await;

      // add destination
      builder.add_payment(wallet_rpc_addr, 1000000);

      // Make 2 data that is the full 255 bytes
      for _ in 0 .. 2 {
        let data = vec![b'a'; MAX_ARBITRARY_DATA_SIZE];
        builder.add_data(data).unwrap();
      }

      (builder.build().unwrap(), wallet_rpc)
    },
    |_, _, tx: Transaction, _, data: SimpleRequestRpc| async move {
      // confirm receipt
      let _: EmptyResponse = data.json_rpc_call("refresh", None).await.unwrap();
      let transfer: TransfersResponse = data
        .json_rpc_call("get_transfer_by_txid", Some(json!({ "txid": hex::encode(tx.hash()) })))
        .await
        .unwrap();
      assert_eq!(transfer.transfer.subaddr_index, Index { major: 0, minor: 0 });
      assert_eq!(transfer.transfer.amount, 1000000);
    },
  ),
);
