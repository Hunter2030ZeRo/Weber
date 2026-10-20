//! JSON byte accounting without allocating a temporary serialization buffer.
use serde_json::Value;
use std::io::{self, Write};

pub fn encoded_len(value: &Value) -> serde_json::Result<usize> {
    struct Counter(usize);
    impl Write for Counter {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            self.0 = self
                .0
                .checked_add(bytes.len())
                .ok_or_else(|| io::Error::other("JSON size overflow"))?;
            Ok(bytes.len())
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }
    let mut counter = Counter(0);
    serde_json::to_writer(&mut counter, value)?;
    Ok(counter.0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn quotas_count_utf8_and_json_escaping() -> serde_json::Result<()> {
        // Escaped control characters consume more bytes than their input UTF-8.
        for value in [
            json!({"text":"한글\n\t\0\"\\", "nested":[null,true,42,-3.5]}),
            json!("\0".repeat(100_000)),
            json!({}),
        ] {
            assert_eq!(encoded_len(&value)?, serde_json::to_vec(&value)?.len());
        }
        assert_eq!(encoded_len(&json!("한"))?, 5);
        assert_eq!(encoded_len(&json!("\0"))?, 8);
        Ok(())
    }
}
