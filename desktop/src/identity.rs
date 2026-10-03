use crate::store::{Result, Store};
use p256::ecdsa::{signature::Signer, Signature, SigningKey};
use serde_json::{json, Value};

#[cfg(any(test, target_os = "macos", target_os = "linux"))]
mod credentials;
#[cfg(windows)]
mod dpapi;
#[cfg(test)]
mod tests;

pub struct Identity {
    pub signing: SigningKey,
    pub noise_private: String,
    pub noise_public: String,
}

impl Identity {
    pub fn load(store: &Store) -> Result<Self> {
        #[cfg(test)]
        {
            let provider = credentials::memory::for_store(store)?;
            Self::load_with_provider(store, &provider)
        }
        #[cfg(all(not(test), windows))]
        {
            dpapi::load(store)
        }
        #[cfg(all(not(test), any(target_os = "macos", target_os = "linux")))]
        {
            Self::load_with_provider(store, &credentials::KeyringProvider)
        }
        #[cfg(all(not(test), not(any(windows, target_os = "macos", target_os = "linux"))))]
        {
            let _ = store;
            Err("Protected device identities are not supported on this OS.".into())
        }
    }

    #[cfg(any(test, target_os = "macos", target_os = "linux"))]
    fn load_with_provider(
        store: &Store,
        provider: &dyn credentials::CredentialProvider,
    ) -> Result<Self> {
        credentials::load(store, provider)
    }

    fn generate() -> Result<Value> {
        let signing = SigningKey::random(&mut rand_core::OsRng);
        let noise = museamo_sync_core::api::evaluate(&json!({"action":"newNoiseKey"}))?;
        Ok(
            json!({"signing":hex::encode(signing.to_bytes()),"noisePrivate":noise["private"],"noisePublic":noise["public"]}),
        )
    }

    fn from_value(value: &Value) -> Result<Self> {
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
            json!({"deviceId":store.device,"name":store.metadata("deviceName")?.unwrap_or_else(device_name),"noisePrivate":self.noise_private,"noisePublic":self.noise_public,"signingPublic":self.public(),"groupId":store.metadata("group")?}),
        )
    }
}

fn device_name() -> String {
    std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .unwrap_or_else(|_| "Museamo desktop".into())
}

fn ensure_device_name(store: &Store) -> Result<()> {
    if store.metadata("deviceName")?.is_none() {
        store.set_metadata("deviceName", &device_name())?;
    }
    Ok(())
}

fn assert_new_identity(store: &Store) -> Result<()> {
    // The signed journal can only exist after a successful identity initialization.
    // Losing its identity metadata must never create a new signer for that device.
    if store.metadata("signedJournal")?.is_some() {
        return Err("This library's device identity metadata is missing. Restore a portable backup in a new installation.".into());
    }
    Ok(())
}

fn transaction<T>(store: &Store, operation: impl FnOnce() -> Result<T>) -> Result<T> {
    store
        .db
        .execute_batch("BEGIN IMMEDIATE")
        .map_err(|error| error.to_string())?;
    let result = operation();
    match result {
        Ok(value) => match store.db.execute_batch("COMMIT") {
            Ok(()) => Ok(value),
            Err(error) => {
                let _ = store.db.execute_batch("ROLLBACK");
                Err(error.to_string())
            }
        },
        Err(error) => {
            let _ = store.db.execute_batch("ROLLBACK");
            Err(error)
        }
    }
}
