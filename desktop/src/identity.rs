use crate::store::{Result, Store};
use p256::ecdsa::{signature::Signer, Signature, SigningKey};
use serde_json::{json, Value};

pub struct Identity {
    pub signing: SigningKey,
    pub noise_private: String,
    pub noise_public: String,
}

impl Identity {
    pub fn load(store: &Store) -> Result<Self> {
        if store.metadata("deviceName")?.is_none() {
            store.set_metadata(
                "deviceName",
                &std::env::var("COMPUTERNAME").unwrap_or_else(|_| "Museamo PC".into()),
            )?;
        }
        let value = match store.metadata("identity")? {
            Some(encoded) => {
                let bytes =
                    unprotect(&hex::decode(encoded).map_err(|_| "Invalid protected identity")?)?;
                museamo_sync_core::json::parse(&bytes)?
            }
            None => {
                let signing = SigningKey::random(&mut rand_core::OsRng);
                let noise = museamo_sync_core::api::evaluate(&json!({"action":"newNoiseKey"}))?;
                let value = json!({"signing":hex::encode(signing.to_bytes()),"noisePrivate":noise["private"],"noisePublic":noise["public"]});
                let protected = protect(&serde_json::to_vec(&value).map_err(|e| e.to_string())?)?;
                store.set_metadata("identity", &hex::encode(protected))?;
                value
            }
        };
        let bytes = hex::decode(
            value["signing"]
                .as_str()
                .ok_or("Invalid signing identity")?,
        )
        .map_err(|_| "Invalid signing identity")?;
        let signing = SigningKey::from_slice(&bytes).map_err(|_| "Invalid signing identity")?;
        let noise_private = value["noisePrivate"]
            .as_str()
            .ok_or("Invalid Noise identity")?
            .to_owned();
        let noise_public = value["noisePublic"]
            .as_str()
            .ok_or("Invalid Noise identity")?
            .to_owned();
        if hex::decode(&noise_private)
            .map_err(|_| "Invalid Noise identity")?
            .len()
            != 32
            || hex::decode(&noise_public)
                .map_err(|_| "Invalid Noise identity")?
                .len()
                != 32
        {
            return Err("Invalid Noise identity".into());
        }
        Ok(Self {
            signing,
            noise_private,
            noise_public,
        })
    }
    pub fn sign(&self, bytes: &[u8]) -> String {
        let signature: Signature = self.signing.sign(bytes);
        hex::encode(signature.to_der().as_bytes())
    }
    pub fn public(&self) -> String {
        hex::encode(
            self.signing
                .verifying_key()
                .to_encoded_point(false)
                .as_bytes(),
        )
    }
    pub fn value(&self, store: &Store) -> Result<Value> {
        Ok(
            json!({"deviceId":store.device,"name":store.metadata("deviceName")?.unwrap_or_else(|| std::env::var("COMPUTERNAME").unwrap_or_else(|_|"Museamo PC".into())),"noisePrivate":self.noise_private,"noisePublic":self.noise_public,"signingPublic":self.public(),"groupId":store.metadata("group")?}),
        )
    }
}

#[cfg(windows)]
fn crypt(bytes: &[u8], encrypt: bool) -> Result<Vec<u8>> {
    use windows_sys::Win32::{
        Foundation::LocalFree,
        Security::Cryptography::{
            CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
        },
    };
    let input = CRYPT_INTEGER_BLOB {
        cbData: bytes.len().try_into().map_err(|_| "Identity too large")?,
        pbData: bytes.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: std::ptr::null_mut(),
    };
    let ok = unsafe {
        if encrypt {
            CryptProtectData(
                &input,
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        } else {
            CryptUnprotectData(
                &input,
                std::ptr::null_mut(),
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        }
    };
    if ok == 0 {
        return Err("Windows could not unlock this device identity. Restore a portable backup in a new installation.".into());
    }
    let value =
        unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec() };
    unsafe {
        LocalFree(output.pbData as _);
    }
    Ok(value)
}
#[cfg(windows)]
fn protect(bytes: &[u8]) -> Result<Vec<u8>> {
    crypt(bytes, true)
}
#[cfg(windows)]
fn unprotect(bytes: &[u8]) -> Result<Vec<u8>> {
    crypt(bytes, false)
}
#[cfg(not(windows))]
fn protect(_: &[u8]) -> Result<Vec<u8>> {
    Err("Windows protected identity is required".into())
}
#[cfg(not(windows))]
fn unprotect(_: &[u8]) -> Result<Vec<u8>> {
    Err("Windows protected identity is required".into())
}
