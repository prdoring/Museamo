use crate::MAX_RECORD_BYTES;
use snow::{Builder, HandshakeState, TransportState};

pub const SUITE: &str = "Noise_XX_25519_ChaChaPoly_SHA256";
pub fn handshake(
    initiator: bool,
    private: &[u8],
    prologue: &[u8],
) -> Result<HandshakeState, String> {
    let parameters = SUITE.parse().map_err(|e: snow::Error| e.to_string())?;
    let builder = Builder::new(parameters)
        .local_private_key(private)
        .map_err(|e| e.to_string())?
        .prologue(prologue)
        .map_err(|e| e.to_string())?;
    (if initiator {
        builder.build_initiator()
    } else {
        builder.build_responder()
    })
    .map_err(|e| e.to_string())
}
pub fn confirmation_code(state: &HandshakeState) -> Result<String, String> {
    if !state.is_handshake_finished() {
        return Err("Handshake is not complete".into());
    }
    let hex = hex::encode(&state.get_handshake_hash()[..16]);
    Ok(hex
        .as_bytes()
        .chunks(4)
        .map(|p| std::str::from_utf8(p).unwrap())
        .collect::<Vec<_>>()
        .join(" ")
        .to_uppercase())
}
pub fn encrypt(state: &mut TransportState, payload: &[u8]) -> Result<Vec<u8>, String> {
    if payload.len() > MAX_RECORD_BYTES {
        return Err("Transport record is too large".into());
    }
    let mut buffer = vec![0; payload.len() + 16];
    let size = state
        .write_message(payload, &mut buffer)
        .map_err(|e| e.to_string())?;
    buffer.truncate(size);
    Ok(buffer)
}
pub fn decrypt(state: &mut TransportState, ciphertext: &[u8]) -> Result<Vec<u8>, String> {
    if ciphertext.len() < 16 || ciphertext.len() > MAX_RECORD_BYTES + 16 {
        return Err("Invalid transport record size".into());
    }
    let mut buffer = vec![0; ciphertext.len()];
    let size = state
        .read_message(ciphertext, &mut buffer)
        .map_err(|e| e.to_string())?;
    buffer.truncate(size);
    Ok(buffer)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn xx_binds_payload_and_rejects_replayed_records() {
        let mut a = handshake(true, &[1; 32], b"museamo-v1/group").unwrap();
        let mut b = handshake(false, &[2; 32], b"museamo-v1/group").unwrap();
        assert!(confirmation_code(&a).is_err());
        let mut packet = [0; 1024];
        let mut payload = [0; 1024];
        let n = a.write_message(b"", &mut packet).unwrap();
        b.read_message(&packet[..n], &mut payload).unwrap();
        let n = b
            .write_message(b"responder signing identity", &mut packet)
            .unwrap();
        a.read_message(&packet[..n], &mut payload).unwrap();
        let n = a
            .write_message(b"initiator signing identity", &mut packet)
            .unwrap();
        b.read_message(&packet[..n], &mut payload).unwrap();
        assert_eq!(
            confirmation_code(&a).unwrap(),
            confirmation_code(&b).unwrap()
        );
        let mut a = a.into_transport_mode().unwrap();
        let mut b = b.into_transport_mode().unwrap();
        let packet = encrypt(&mut a, b"confirm this session").unwrap();
        assert_eq!(decrypt(&mut b, &packet).unwrap(), b"confirm this session");
        assert!(decrypt(&mut b, &packet).is_err());
    }
}
