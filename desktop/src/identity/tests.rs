use super::credentials::{
    memory::MemoryProvider, CredentialProvider, CredentialScope, ProtectionError,
};
use super::*;
use rusqlite::Connection;
use std::path::{Path, PathBuf};
use std::sync::Arc;

struct Fixture {
    root: PathBuf,
    provider: MemoryProvider,
}

impl Fixture {
    fn new() -> Self {
        Self {
            root: std::env::temp_dir()
                .join(format!("museamo-identity-test-{}", crate::store::id())),
            provider: MemoryProvider::default(),
        }
    }
    fn open(&self) -> Result<Store> {
        open(&self.root, &self.provider)
    }
    fn connection(&self) -> Connection {
        Connection::open(self.root.join("library.sqlite")).unwrap()
    }
    fn reference(&self) -> String {
        self.connection()
            .query_row(
                "SELECT value FROM metadata WHERE key='identity'",
                [],
                |row| row.get(0),
            )
            .unwrap()
    }
    fn scope(&self) -> CredentialScope {
        serde_json::from_value(
            serde_json::from_str::<Value>(&self.reference()).unwrap()["scope"].clone(),
        )
        .unwrap()
    }
    fn failure(&self, error: Option<ProtectionError>) {
        *self.provider.failure.lock().unwrap() = error;
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

fn open(root: &Path, provider: &dyn CredentialProvider) -> Result<Store> {
    Store::open_with_identity_loader(root, |store| Identity::load_with_provider(store, provider))
}

#[test]
fn credential_reference_reopens_same_signing_and_noise_identity_without_storing_private_bytes() {
    let fixture = Fixture::new();
    let store = fixture.open().unwrap();
    let identity = store.identity.as_ref().unwrap();
    let public = identity.public();
    let private = hex::encode(identity.signing.to_bytes());
    let noise_private = identity.noise_private.clone();
    let noise_public = identity.noise_public.clone();
    let reference = store.metadata("identity").unwrap().unwrap();
    assert!(!reference.contains(&private));
    assert!(!reference.contains(&noise_private));
    assert!(!reference.contains("signing"));
    drop(store);
    let reopened = fixture.open().unwrap();
    let identity = reopened.identity.as_ref().unwrap();
    assert_eq!(identity.public(), public);
    assert_eq!(identity.noise_private, noise_private);
    assert_eq!(identity.noise_public, noise_public);
    assert_eq!(reopened.metadata("identity").unwrap().unwrap(), reference);
    assert_eq!(fixture.provider.entries.lock().unwrap().len(), 1);
}

#[test]
fn locked_unavailable_and_ambiguous_stores_preserve_existing_identity() {
    let fixture = Fixture::new();
    let public = fixture.open().unwrap().identity.as_ref().unwrap().public();
    let reference = fixture.reference();
    let protected = fixture.provider.entries.lock().unwrap().clone();
    for error in [
        ProtectionError::AccessDenied,
        ProtectionError::Unavailable,
        ProtectionError::Ambiguous,
        ProtectionError::InvalidCredential,
    ] {
        fixture.failure(Some(error));
        assert!(fixture.open().err().unwrap().contains(&error.to_string()));
        assert_eq!(fixture.reference(), reference);
        assert_eq!(*fixture.provider.entries.lock().unwrap(), protected);
    }
    fixture.failure(None);
    assert_eq!(
        fixture.open().unwrap().identity.as_ref().unwrap().public(),
        public
    );
}

#[test]
fn completed_identity_with_missing_credential_is_never_replaced() {
    let fixture = Fixture::new();
    drop(fixture.open().unwrap());
    let reference = fixture.reference();
    fixture.provider.entries.lock().unwrap().clear();
    assert!(fixture
        .open()
        .err()
        .unwrap()
        .contains("credential is missing"));
    assert_eq!(fixture.reference(), reference);
    assert!(fixture.provider.entries.lock().unwrap().is_empty());
}

#[test]
fn unavailable_store_during_first_creation_retries_the_same_pending_reference() {
    let fixture = Fixture::new();
    fixture.failure(Some(ProtectionError::Unavailable));
    assert!(fixture.open().is_err());
    let reference = serde_json::from_str::<Value>(&fixture.reference()).unwrap();
    assert_eq!(reference["state"], "pending");
    assert!(fixture.provider.entries.lock().unwrap().is_empty());
    fixture.failure(None);
    let store = fixture.open().unwrap();
    let ready =
        serde_json::from_str::<Value>(&store.metadata("identity").unwrap().unwrap()).unwrap();
    assert_eq!(ready["scope"], reference["scope"]);
    assert!(ready["state"]["ready"]["digest"].is_string());
}

struct InterruptedWrite<'a>(&'a MemoryProvider);
impl CredentialProvider for InterruptedWrite<'_> {
    fn read(
        &self,
        scope: &CredentialScope,
    ) -> std::result::Result<Option<Vec<u8>>, ProtectionError> {
        self.0.read(scope)
    }
    fn create(
        &self,
        scope: &CredentialScope,
        bytes: &[u8],
    ) -> std::result::Result<(), ProtectionError> {
        self.0.create(scope, bytes)?;
        Err(ProtectionError::Unavailable)
    }
}

#[test]
fn protected_write_that_reports_failure_is_recovered_without_another_create() {
    let fixture = Fixture::new();
    assert!(open(&fixture.root, &InterruptedWrite(&fixture.provider)).is_err());
    let pending = fixture.reference();
    assert_eq!(
        serde_json::from_str::<Value>(&pending).unwrap()["state"],
        "pending"
    );
    let secret = fixture.provider.read(&fixture.scope()).unwrap().unwrap();
    let public =
        Identity::from_value(&serde_json::from_slice::<Value>(&secret).unwrap()["identity"])
            .unwrap()
            .public();
    let store = fixture.open().unwrap();
    assert_eq!(store.identity.as_ref().unwrap().public(), public);
    assert_eq!(
        fixture.provider.read(&fixture.scope()).unwrap().unwrap(),
        secret
    );
    assert_eq!(fixture.provider.entries.lock().unwrap().len(), 1);
}

#[test]
fn failed_metadata_commit_after_key_creation_recovers_the_saved_key() {
    let fixture = Fixture::new();
    let failed = Store::open_with_identity_loader(&fixture.root, |store| {
        store.db.execute_batch("CREATE TRIGGER reject_identity_ready BEFORE UPDATE ON metadata WHEN NEW.key='identity' BEGIN SELECT RAISE(FAIL,'fixture persistence failure'); END;").map_err(|error| error.to_string())?;
        Identity::load_with_provider(store, &fixture.provider)
    });
    assert!(failed
        .err()
        .unwrap()
        .contains("fixture persistence failure"));
    assert_eq!(
        serde_json::from_str::<Value>(&fixture.reference()).unwrap()["state"],
        "pending"
    );
    let secret = fixture.provider.read(&fixture.scope()).unwrap().unwrap();
    fixture
        .connection()
        .execute_batch("DROP TRIGGER reject_identity_ready")
        .unwrap();
    let expected =
        Identity::from_value(&serde_json::from_slice::<Value>(&secret).unwrap()["identity"])
            .unwrap()
            .public();
    assert_eq!(
        fixture.open().unwrap().identity.as_ref().unwrap().public(),
        expected
    );
    assert_eq!(
        fixture.provider.read(&fixture.scope()).unwrap().unwrap(),
        secret
    );
}

#[test]
fn corrupted_or_changed_credentials_fail_without_modifying_the_reference_or_key() {
    let fixture = Fixture::new();
    drop(fixture.open().unwrap());
    let reference = fixture.reference();
    let scope = fixture.scope();
    let key = fixture.provider.key(&scope);
    fixture
        .provider
        .entries
        .lock()
        .unwrap()
        .insert(key, b"corrupted credential".to_vec());
    assert!(fixture
        .open()
        .err()
        .unwrap()
        .contains("credential has changed"));
    assert_eq!(fixture.reference(), reference);
    assert_eq!(
        fixture.provider.read(&scope).unwrap().unwrap(),
        b"corrupted credential"
    );
}

#[test]
fn pending_credential_bound_to_a_different_scope_is_not_used_or_replaced() {
    let fixture = Fixture::new();
    assert!(open(&fixture.root, &InterruptedWrite(&fixture.provider)).is_err());
    let scope = fixture.scope();
    let original = fixture.provider.read(&scope).unwrap().unwrap();
    let mut secret: Value = serde_json::from_slice(&original).unwrap();
    secret["scope"]["device"] = json!(crate::store::id());
    let wrong_scope_secret = serde_json::to_vec(&secret).unwrap();
    fixture
        .provider
        .entries
        .lock()
        .unwrap()
        .insert(fixture.provider.key(&scope), wrong_scope_secret.clone());
    assert!(fixture
        .open()
        .err()
        .unwrap()
        .contains("different library or device"));
    assert_eq!(
        fixture.provider.read(&scope).unwrap().unwrap(),
        wrong_scope_secret
    );
    assert_eq!(
        serde_json::from_str::<Value>(&fixture.reference()).unwrap()["state"],
        "pending"
    );
}

#[test]
fn missing_or_malformed_metadata_does_not_reinitialize_a_signed_library() {
    let fixture = Fixture::new();
    drop(fixture.open().unwrap());
    let protected = fixture.provider.entries.lock().unwrap().clone();
    for invalid in ["not a reference", "01020304", "{}"] {
        fixture
            .connection()
            .execute(
                "UPDATE metadata SET value=?1 WHERE key='identity'",
                [invalid],
            )
            .unwrap();
        assert!(fixture.open().is_err());
        assert_eq!(fixture.reference(), invalid);
    }
    fixture
        .connection()
        .execute("DELETE FROM metadata WHERE key='identity'", [])
        .unwrap();
    assert!(fixture
        .open()
        .err()
        .unwrap()
        .contains("identity metadata is missing"));
    assert_eq!(*fixture.provider.entries.lock().unwrap(), protected);
}

#[test]
fn different_libraries_use_distinct_scoped_credentials_in_the_same_provider() {
    let first = Fixture::new();
    let second = Fixture::new();
    let a = open(&first.root, &first.provider).unwrap();
    let b = open(&second.root, &first.provider).unwrap();
    assert_ne!(a.device, b.device);
    assert_ne!(
        a.identity.as_ref().unwrap().public(),
        b.identity.as_ref().unwrap().public()
    );
    assert_ne!(
        a.metadata("identityLibrary").unwrap(),
        b.metadata("identityLibrary").unwrap()
    );
    assert_eq!(first.provider.entries.lock().unwrap().len(), 2);
}

#[test]
fn default_test_provider_survives_reopen_and_isolates_canonical_library_paths() {
    let first = Fixture::new();
    let store = Store::open(&first.root).unwrap();
    let public = store.identity.as_ref().unwrap().public();
    let provider = credentials::memory::for_store(&store).unwrap();
    let alias = first.root.join(".");
    drop(store);
    assert_eq!(
        Store::open(&alias)
            .unwrap()
            .identity
            .as_ref()
            .unwrap()
            .public(),
        public
    );
    let second = Fixture::new();
    std::fs::create_dir_all(&second.root).unwrap();
    let source = first.connection();
    source
        .execute_batch("PRAGMA wal_checkpoint(TRUNCATE)")
        .unwrap();
    drop(source);
    std::fs::copy(
        first.root.join("library.sqlite"),
        second.root.join("library.sqlite"),
    )
    .unwrap();
    assert!(Store::open(&second.root)
        .err()
        .unwrap()
        .contains("credential is missing"));
    assert!(provider.read(&first.scope()).unwrap().is_some());
}

#[test]
fn concurrent_openers_reuse_one_device_and_one_credential() {
    let fixture = Fixture::new();
    // Prepare the SQLite schema first; this test exercises identity creation locking.
    assert!(
        Store::open_with_identity_loader(&fixture.root, |_| Err("prepare schema only".into()))
            .is_err()
    );
    let root = fixture.root.clone();
    let provider = Arc::new(MemoryProvider::default());
    let barrier = Arc::new(std::sync::Barrier::new(2));
    let handles: Vec<_> = (0..2)
        .map(|_| {
            let root = root.clone();
            let provider = provider.clone();
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                barrier.wait();
                let store = open(&root, &*provider).unwrap();
                (
                    store.device.clone(),
                    store.identity.as_ref().unwrap().public(),
                )
            })
        })
        .collect();
    let identities: Vec<_> = handles
        .into_iter()
        .map(|handle| handle.join().unwrap())
        .collect();
    assert_eq!(identities[0], identities[1]);
    assert_eq!(provider.entries.lock().unwrap().len(), 1);
}

#[test]
fn missing_device_identifier_does_not_assign_a_new_device_to_an_existing_identity() {
    let fixture = Fixture::new();
    drop(fixture.open().unwrap());
    let reference = fixture.reference();
    let protected = fixture.provider.entries.lock().unwrap().clone();
    fixture
        .connection()
        .execute("DELETE FROM metadata WHERE key='device'", [])
        .unwrap();
    assert!(fixture
        .open()
        .err()
        .unwrap()
        .contains("device identifier is missing"));
    assert_eq!(fixture.reference(), reference);
    assert_eq!(*fixture.provider.entries.lock().unwrap(), protected);
    let count: u32 = fixture
        .connection()
        .query_row(
            "SELECT count(*) FROM metadata WHERE key='device'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(count, 0);
}

#[test]
fn pending_reference_with_a_signed_journal_cannot_generate_a_replacement_key() {
    let fixture = Fixture::new();
    drop(fixture.open().unwrap());
    let mut reference: Value = serde_json::from_str(&fixture.reference()).unwrap();
    reference["state"] = json!("pending");
    let pending = serde_json::to_string(&reference).unwrap();
    fixture
        .connection()
        .execute(
            "UPDATE metadata SET value=?1 WHERE key='identity'",
            [&pending],
        )
        .unwrap();
    fixture.provider.entries.lock().unwrap().clear();
    assert!(fixture
        .open()
        .err()
        .unwrap()
        .contains("identity metadata is missing"));
    assert!(fixture.provider.entries.lock().unwrap().is_empty());
    assert_eq!(fixture.reference(), pending);
}
