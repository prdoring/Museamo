//! Shared, storage-independent replication rules. Platform repositories apply results atomically.
pub mod api;
pub mod coordinator;
pub mod json;
pub mod membership;
pub mod model;
pub mod purge;
pub mod tags;
pub mod transport;
pub mod wire;
pub use coordinator::{Coordinator, Platform};
#[cfg(feature = "android")]
mod android;

pub const PROTOCOL_VERSION: u32 = 1;
pub const MAX_RECORD_BYTES: usize = 60 * 1024;
pub const MAX_PAYLOAD_BYTES: usize = 25 * 1024 * 1024;
/// Milliseconds since the Unix epoch representable by both native stores and JavaScript Date.
pub const MAX_TIMESTAMP: u64 = 8_640_000_000_000_000;

pub fn normalize_tag(name: &str) -> String {
    use unicode_normalization::UnicodeNormalization;
    name.trim().nfc().flat_map(char::to_lowercase).collect()
}
