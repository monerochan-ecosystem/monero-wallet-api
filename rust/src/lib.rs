use std::cell::RefCell;

thread_local! {
    static THREAD_LOCAL_STRING: RefCell<String> = RefCell::new(String::from("Initial value"));
}
pub fn add(left: usize, right: usize) -> usize {
    THREAD_LOCAL_STRING.with(|string| {
        println!("Initial value: {}", string.borrow());

        // Modify the string
        *string.borrow_mut() = String::from("New value");

        println!("Modified value: {}", string.borrow());
    });

    left + right
}

#[cfg(test)]
mod tests {
    use super::*;
    use curve25519_dalek::scalar::Scalar;
    use hex::FromHex;
    use monero_wallet;
    use zeroize::Zeroizing;

    #[test]
    fn it_works() {
        let result = add(2, 2);
        assert_eq!(result, 4);
    }

    #[test]
    fn test_monero_serai() {
        THREAD_LOCAL_STRING.with(|string| {
            println!("Initial value: {}", string.borrow());

            // Modify the string
            *string.borrow_mut() = String::from("New value");

            println!("Modified value: {}", string.borrow());
        });
        let primary_address = "55Py9fSwyEeQX1CydtFfPk96uHEFxSxvD9AYBy7dwnYt9cXqKDjix9rS9AWZ5GnH4B1Z7yHr3B2UH2updNw5ZNJEEnv87H1";
        let secret_view_key = "1195868d30373aa9d92c1a21514de97670bcd360c209a409ea3234174892770e";
        let view_key_bytes = <[u8; 32]>::from_hex(secret_view_key.to_string()).unwrap();
        let viewpair = monero_wallet::ViewPair::new(
            monero_wallet::address::MoneroAddress::from_str_with_unchecked_network(primary_address)
                .map_err(|e| {
                    eprintln!(
                        "There is an issue with the primary address that you provided: {}",
                        primary_address.to_string()
                    );
                    eprintln!("{}", e.to_string());
                    std::process::exit(1);
                })
                .unwrap()
                .spend(),
            Zeroizing::new(Scalar::from_canonical_bytes(view_key_bytes).unwrap()), // monero::PrivateKey::from_str(secret_view_key).map_err(|e| {
                                                                                   //     eprintln!("There is an issue with the view key that you provided: {}",
                                                                                   //       secret_view_key.to_string());
                                                                                   //     eprintln!("{}", e.to_string());
                                                                                   //     std::process::exit(1);
                                                                                   // }).unwrap(),
        )
        .unwrap();
        println!(
            "HI {:#?}",
            viewpair.legacy_address(monero_wallet::address::Network::Stagenet)
        );
        let result = 4;
        assert_eq!(result, 4);
    }
}
