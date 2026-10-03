use super::{assert_new_identity, ensure_device_name, transaction, Identity};
use crate::store::{Result, Store};

pub(super) fn load(store: &Store) -> Result<Identity> {
    transaction(store, || {
        let value = match store.metadata("identity")? {
            Some(encoded) => {
                let bytes = crypt(
                    &hex::decode(encoded).map_err(|_| "Invalid Windows protected identity")?,
                    false,
                )?;
                museamo_sync_core::json::parse(&bytes)?
            }
            None => {
                assert_new_identity(store)?;
                let value = Identity::generate()?;
                // Keep the existing hex-encoded DPAPI JSON blob byte format on Windows.
                let protected = crypt(
                    &serde_json::to_vec(&value).map_err(|error| error.to_string())?,
                    true,
                )?;
                store.set_metadata("identity", &hex::encode(protected))?;
                value
            }
        };
        let identity = Identity::from_value(&value)?;
        ensure_device_name(store)?;
        Ok(identity)
    })
}

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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_windows_hex_dpapi_identity_reopens_without_reencoding() {
        let root = std::env::temp_dir().join(format!("museamo-dpapi-test-{}", crate::store::id()));
        let value = Identity::generate().unwrap();
        let public = Identity::from_value(&value).unwrap().public();
        let encoded = hex::encode(crypt(&serde_json::to_vec(&value).unwrap(), true).unwrap());
        let store = Store::open_with_identity_loader(&root, |store| {
            store.set_metadata("identity", &encoded)?;
            load(store)
        })
        .unwrap();
        assert_eq!(store.identity.as_ref().unwrap().public(), public);
        assert_eq!(store.metadata("identity").unwrap().unwrap(), encoded);
        drop(store);
        let reopened = Store::open_with_identity_loader(&root, load).unwrap();
        assert_eq!(reopened.identity.as_ref().unwrap().public(), public);
        assert_eq!(reopened.metadata("identity").unwrap().unwrap(), encoded);
        assert!(reopened.metadata("identityLibrary").unwrap().is_none());
        drop(reopened);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn dpapi_unlock_failure_preserves_the_existing_blob() {
        let root = std::env::temp_dir().join(format!("museamo-dpapi-test-{}", crate::store::id()));
        let result = Store::open_with_identity_loader(&root, |store| {
            store.set_metadata("identity", "01020304")?;
            load(store)
        });
        assert!(result.is_err());
        let db = rusqlite::Connection::open(root.join("library.sqlite")).unwrap();
        let encoded: String = db
            .query_row(
                "SELECT value FROM metadata WHERE key='identity'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(encoded, "01020304");
        drop(db);
        std::fs::remove_dir_all(root).unwrap();
    }
}
