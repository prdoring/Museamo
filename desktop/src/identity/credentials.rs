use super::{assert_new_identity, ensure_device_name, transaction, Identity};
use crate::store::{id, uuid, Result, Store};
use serde::{Deserialize, Serialize};
use serde_json::Value;

const PROVIDER: &str = "os-credential-store";
#[cfg(any(target_os = "macos", target_os = "linux"))]
const SERVICE: &str = "com.prdoring.museamo.device-identity.v1";
const SCHEMA: u32 = 1;
const MAX_SECRET_BYTES: usize = 16 * 1024;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct CredentialScope {
    library: String,
    device: String,
    credential: String,
}

impl CredentialScope {
    fn account(&self) -> String {
        format!(
            "library:{}/device:{}/identity:{}",
            self.library, self.device, self.credential
        )
    }

    fn validate(&self, store: &Store) -> Result<()> {
        uuid(&self.library)?;
        uuid(&self.device)?;
        uuid(&self.credential)?;
        if self.device != store.device
            || store.metadata("identityLibrary")?.as_deref() != Some(&self.library)
        {
            return Err(
                "Protected identity reference belongs to a different library or device.".into(),
            );
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
enum State {
    Pending,
    Ready { digest: String },
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Reference {
    schema: u32,
    provider: String,
    scope: CredentialScope,
    state: State,
}

impl Reference {
    fn read(store: &Store) -> Result<Self> {
        let encoded = store
            .metadata("identity")?
            .ok_or("Missing protected identity reference")?;
        let reference: Self = serde_json::from_str(&encoded).map_err(|_| "Invalid protected identity reference. A Windows DPAPI identity cannot be opened on this OS; import a portable backup into a new installation.")?;
        if reference.schema != SCHEMA || reference.provider != PROVIDER {
            return Err("Unsupported protected identity reference.".into());
        }
        reference.scope.validate(store)?;
        Ok(reference)
    }

    fn save(&self, store: &Store) -> Result<()> {
        store.set_metadata(
            "identity",
            &serde_json::to_string(self).map_err(|error| error.to_string())?,
        )
    }
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Secret {
    schema: u32,
    scope: CredentialScope,
    identity: Value,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum ProtectionError {
    AccessDenied,
    Unavailable,
    Ambiguous,
    InvalidCredential,
    AlreadyExists,
}

impl std::fmt::Display for ProtectionError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            Self::AccessDenied => "The OS credential store is locked or access was denied. Unlock it and reopen Museamo. Your device identity was not replaced.",
            Self::Unavailable => "The OS credential store is unavailable. Enable Keychain or a Secret Service on the desktop session and reopen Museamo. Your device identity was not replaced.",
            Self::Ambiguous => "Multiple OS credentials match this device identity. Resolve the duplicate credentials before reopening Museamo.",
            Self::InvalidCredential => "The protected device credential is invalid. It was not replaced.",
            Self::AlreadyExists => "A protected device credential already exists. It was not replaced; reopen Museamo to recover it.",
        })
    }
}

type ProtectionResult<T> = std::result::Result<T, ProtectionError>;

pub(super) trait CredentialProvider {
    /// Only a confirmed absent entry returns None. Access and service failures are errors.
    fn read(&self, scope: &CredentialScope) -> ProtectionResult<Option<Vec<u8>>>;
    fn create(&self, scope: &CredentialScope, bytes: &[u8]) -> ProtectionResult<()>;
}

pub(super) fn load(store: &Store, provider: &dyn CredentialProvider) -> Result<Identity> {
    // Commit the pointer before touching the OS store. If the process stops after
    // the protected write, the next open uses the same credential rather than orphaning it.
    transaction(store, || {
        if store.metadata("identity")?.is_none() {
            assert_new_identity(store)?;
            let library = match store.metadata("identityLibrary")? {
                Some(library) => {
                    uuid(&library)?;
                    library
                }
                None => {
                    let library = id();
                    store.set_metadata("identityLibrary", &library)?;
                    library
                }
            };
            let reference = Reference {
                schema: SCHEMA,
                provider: PROVIDER.into(),
                scope: CredentialScope {
                    library,
                    device: store.device.clone(),
                    credential: id(),
                },
                state: State::Pending,
            };
            reference.save(store)?;
        }
        Ok(())
    })?;

    // Re-read under the write lock. Another opener may have completed the pending
    // write between transactions; only the lock holder can initialize this identity.
    transaction(store, || {
        let mut reference = Reference::read(store)?;
        let bytes = match provider.read(&reference.scope).map_err(|error| error.to_string())? {
            Some(bytes) => bytes,
            None => match reference.state {
                State::Ready { .. } => return Err("This library's protected device credential is missing. Restore credential access, or import a portable backup into a new installation. The identity was not replaced.".into()),
                State::Pending => {
                    assert_new_identity(store)?;
                    let secret = Secret { schema: SCHEMA, scope: reference.scope.clone(), identity: Identity::generate()? };
                    let bytes = serde_json::to_vec(&secret).map_err(|error| error.to_string())?;
                    provider.create(&reference.scope, &bytes).map_err(|error| error.to_string())?;
                    let saved = provider.read(&reference.scope).map_err(|error| error.to_string())?.ok_or("The OS credential store did not retain the device identity. Reopen Museamo to recover pending creation.")?;
                    if saved != bytes {
                        return Err("The OS credential store returned a different device identity. It was not replaced.".into());
                    }
                    saved
                }
            },
        };
        if bytes.len() > MAX_SECRET_BYTES {
            return Err("Protected device credential is too large.".into());
        }
        let digest = museamo_sync_core::wire::hash(&bytes);
        if let State::Ready { digest: expected } = &reference.state {
            if *expected != digest {
                return Err(
                    "Protected device credential has changed. The identity was not replaced."
                        .into(),
                );
            }
        }
        let secret: Secret =
            serde_json::from_slice(&bytes).map_err(|_| "Invalid protected device credential.")?;
        if secret.schema != SCHEMA || secret.scope != reference.scope {
            return Err(
                "Protected device credential belongs to a different library or device.".into(),
            );
        }
        let identity = Identity::from_value(&secret.identity)?;
        if matches!(reference.state, State::Pending) {
            reference.state = State::Ready { digest };
            reference.save(store)?;
        }
        ensure_device_name(store)?;
        Ok(identity)
    })
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
pub(super) struct KeyringProvider;

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn entry(scope: &CredentialScope) -> ProtectionResult<keyring::Entry> {
    // Select the native backend explicitly. A missing feature must be a build error,
    // never keyring's default in-memory mock fallback.
    #[cfg(target_os = "macos")]
    let credential =
        keyring::macos::MacCredential::new_with_target(None, SERVICE, &scope.account());
    #[cfg(target_os = "linux")]
    let credential = keyring::secret_service::SsCredential::new_with_target(
        Some("default"),
        SERVICE,
        &scope.account(),
    );
    Ok(keyring::Entry::new_with_credential(Box::new(
        credential.map_err(keyring_error)?,
    )))
}

#[cfg(target_os = "macos")]
fn create_native(scope: &CredentialScope, bytes: &[u8]) -> ProtectionResult<()> {
    use security_framework::os::macos::keychain::{SecKeychain, SecPreferencesDomain};
    let keychain = SecKeychain::default_for_domain(SecPreferencesDomain::User)
        .map_err(|error| keyring_error(keyring::macos::decode_error(error)))?;
    // Add is atomic and refuses duplicate items; set_generic_password would overwrite.
    keychain
        .add_generic_password(SERVICE, &scope.account(), bytes)
        .map_err(|error| {
            if error.code() == -25299 {
                ProtectionError::AlreadyExists
            } else {
                keyring_error(keyring::macos::decode_error(error))
            }
        })
}

#[cfg(target_os = "linux")]
fn create_native(scope: &CredentialScope, bytes: &[u8]) -> ProtectionResult<()> {
    use dbus_secret_service::{EncryptionType, SecretService};
    use std::collections::HashMap;
    let map_error = |error| keyring_error(keyring::secret_service::decode_error(error));
    let service = SecretService::connect(EncryptionType::Dh).map_err(map_error)?;
    let collection = service.get_default_collection().map_err(map_error)?;
    collection.unlock().map_err(map_error)?;
    let account = scope.account();
    let attributes = HashMap::from([
        ("service", SERVICE),
        ("username", account.as_str()),
        ("target", "default"),
        ("application", "Museamo"),
    ]);
    // Never update an item created by a concurrent writer. If duplicates appear,
    // the subsequent read rejects ambiguity instead of choosing or replacing a key.
    collection
        .create_item(
            "Museamo device identity",
            attributes,
            bytes,
            false,
            "application/octet-stream",
        )
        .map_err(map_error)?;
    Ok(())
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn keyring_error(error: keyring::Error) -> ProtectionError {
    // Do not format backend errors: malformed secret errors may contain private bytes.
    #[cfg(target_os = "macos")]
    if let keyring::Error::NoStorageAccess(source) | keyring::Error::PlatformFailure(source) =
        &error
    {
        if let Some(error) = source.downcast_ref::<security_framework::base::Error>() {
            // Keyring's macOS backend categorizes denied prompts as PlatformFailure.
            // Read the OSStatus so cancellation/locking remains distinct from an absent entry.
            match error.code() {
                -128 | -25292 | -25293 | -25308 | -25315 | -34018 => {
                    return ProtectionError::AccessDenied
                }
                -25291 | -25294 | -25295 => return ProtectionError::Unavailable,
                _ => {}
            }
        }
    }
    match error {
        keyring::Error::NoStorageAccess(_) => ProtectionError::AccessDenied,
        keyring::Error::Ambiguous(_) => ProtectionError::Ambiguous,
        keyring::Error::BadEncoding(_) => ProtectionError::InvalidCredential,
        _ => ProtectionError::Unavailable,
    }
}

#[cfg(all(test, any(target_os = "macos", target_os = "linux")))]
mod native_error_tests {
    use super::*;

    #[test]
    fn backend_errors_do_not_include_private_bytes_or_turn_into_missing_entries() {
        let _provider = KeyringProvider;
        assert_eq!(
            keyring_error(keyring::Error::BadEncoding(b"private bytes".to_vec())),
            ProtectionError::InvalidCredential
        );
        let error = keyring_error(keyring::Error::NoStorageAccess(Box::new(
            std::io::Error::other("private bytes"),
        )));
        assert_eq!(error, ProtectionError::AccessDenied);
        assert!(!error.to_string().contains("private bytes"));
        assert_eq!(
            keyring_error(keyring::Error::PlatformFailure(Box::new(
                std::io::Error::other("offline")
            ))),
            ProtectionError::Unavailable
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn keychain_denial_and_service_failure_remain_distinct() {
        for status in [-128, -25293, -25308] {
            assert_eq!(
                keyring_error(keyring::Error::PlatformFailure(Box::new(
                    security_framework::base::Error::from_code(status)
                ))),
                ProtectionError::AccessDenied
            );
        }
        assert_eq!(
            keyring_error(keyring::Error::NoStorageAccess(Box::new(
                security_framework::base::Error::from_code(-25291)
            ))),
            ProtectionError::Unavailable
        );
    }
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
impl CredentialProvider for KeyringProvider {
    fn read(&self, scope: &CredentialScope) -> ProtectionResult<Option<Vec<u8>>> {
        let entry = entry(scope)?;
        match entry.get_secret() {
            Ok(bytes) => Ok(Some(bytes)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(error) => Err(keyring_error(error)),
        }
    }

    fn create(&self, scope: &CredentialScope, bytes: &[u8]) -> ProtectionResult<()> {
        let entry = entry(scope)?;
        match entry.get_secret() {
            Ok(_) => Err(ProtectionError::AlreadyExists),
            Err(keyring::Error::NoEntry) => create_native(scope, bytes),
            Err(error) => Err(keyring_error(error)),
        }
    }
}

#[cfg(test)]
pub(super) mod memory {
    use super::*;
    use std::collections::HashMap;
    use std::sync::{Arc, Mutex, OnceLock};

    type Entries = Arc<Mutex<HashMap<String, Vec<u8>>>>;

    #[derive(Default)]
    pub(in crate::identity) struct MemoryProvider {
        pub(in crate::identity) entries: Entries,
        pub(in crate::identity) failure: Mutex<Option<ProtectionError>>,
        namespace: String,
    }

    pub(in crate::identity) fn for_store(store: &Store) -> Result<MemoryProvider> {
        static ENTRIES: OnceLock<Entries> = OnceLock::new();
        let path = std::fs::canonicalize(&store.root).map_err(|error| error.to_string())?;
        Ok(MemoryProvider {
            entries: ENTRIES.get_or_init(Entries::default).clone(),
            namespace: path.to_string_lossy().into_owned(),
            ..Default::default()
        })
    }

    impl MemoryProvider {
        pub(in crate::identity) fn key(&self, scope: &CredentialScope) -> String {
            format!("{}:{}", self.namespace, scope.account())
        }
    }

    impl CredentialProvider for MemoryProvider {
        fn read(&self, scope: &CredentialScope) -> ProtectionResult<Option<Vec<u8>>> {
            if let Some(error) = *self.failure.lock().unwrap() {
                return Err(error);
            }
            Ok(self.entries.lock().unwrap().get(&self.key(scope)).cloned())
        }
        fn create(&self, scope: &CredentialScope, bytes: &[u8]) -> ProtectionResult<()> {
            if let Some(error) = *self.failure.lock().unwrap() {
                return Err(error);
            }
            let mut entries = self.entries.lock().unwrap();
            if entries.contains_key(&self.key(scope)) {
                return Err(ProtectionError::AlreadyExists);
            }
            entries.insert(self.key(scope), bytes.to_vec());
            Ok(())
        }
    }
}
