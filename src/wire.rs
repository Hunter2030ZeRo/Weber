//! Validation view of the original packet. It is never re-encoded: UTF-16 data
//! and IEEE-754 bits are forwarded unchanged to the destination JavaScript VM.
use anyhow::{Result, bail, ensure};
use serde_json::{Map, Number, Value};

pub fn decode(bytes: &[u8]) -> Result<Value> {
    ensure!(
        bytes.len() <= 1_048_576 && bytes.starts_with(b"WBR\x01"),
        "Invalid wire packet"
    );
    let mut reader = Reader { bytes, offset: 4 };
    let value = reader.value(0)?;
    ensure!(reader.offset == bytes.len(), "Trailing wire data");
    Ok(value)
}

struct Reader<'a> {
    bytes: &'a [u8],
    offset: usize,
}
impl Reader<'_> {
    fn take(&mut self, length: usize) -> Result<&[u8]> {
        ensure!(
            length <= self.bytes.len().saturating_sub(self.offset),
            "Truncated wire value"
        );
        let start = self.offset;
        self.offset += length;
        Ok(&self.bytes[start..self.offset])
    }
    fn value(&mut self, depth: usize) -> Result<Value> {
        ensure!(depth <= 64, "Wire nesting limit");
        let tag = self.take(1)?[0];
        Ok(match tag {
            0 => Value::Null,
            1 => Value::Bool(false),
            2 => Value::Bool(true),
            3 => {
                let value = f64::from_le_bytes(self.take(8)?.try_into()?);
                ensure!(value.is_finite(), "Nonfinite wire number");
                // Preserve integer types for existing serde u32/u64 contracts.
                if value >= 0.0 && value.fract() == 0.0 && value < u64::MAX as f64 {
                    Value::Number(Number::from(value as u64))
                } else if value < 0.0 && value.fract() == 0.0 && value >= i64::MIN as f64 {
                    Value::Number(Number::from(value as i64))
                } else {
                    Value::Number(
                        Number::from_f64(value)
                            .ok_or_else(|| anyhow::anyhow!("Invalid wire number"))?,
                    )
                }
            }
            4..=6 => {
                let count = u32::from_le_bytes(self.take(4)?.try_into()?) as usize;
                ensure!(
                    count <= self.bytes.len().saturating_sub(self.offset),
                    "Invalid wire count"
                );
                match tag {
                    4 => {
                        let units = self
                            .take(count * 2)?
                            .as_chunks::<2>()
                            .0
                            .iter()
                            .map(|bytes| u16::from_le_bytes([bytes[0], bytes[1]]))
                            .collect::<Vec<_>>();
                        Value::String(String::from_utf16_lossy(&units))
                    }
                    5 => {
                        let mut values = Vec::new();
                        for _ in 0..count {
                            values.push(self.value(depth + 1)?);
                        }
                        Value::Array(values)
                    }
                    _ => {
                        let mut values = Map::new();
                        for _ in 0..count {
                            let Value::String(key) = self.value(depth + 1)? else {
                                bail!("Invalid wire key")
                            };
                            ensure!(!values.contains_key(&key), "Duplicate wire key");
                            let value = self.value(depth + 1)?;
                            values.insert(key, value);
                        }
                        Value::Object(values)
                    }
                }
            }
            _ => bail!("Unknown wire tag"),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_malformed_packets() {
        for bytes in [
            &b"WBR\x01"[..],
            &b"WBR\x02\0"[..],
            &b"WBR\x01\0\0"[..],
            &b"WBR\x01\x05\xff\xff\xff\xff"[..],
            &b"WBR\x01\x04\x01\0\0\0a"[..],
        ] {
            assert!(decode(bytes).is_err());
        }
        let mut nan = b"WBR\x01\x03".to_vec();
        nan.extend(f64::NAN.to_le_bytes());
        assert!(decode(&nan).is_err());
    }
    #[test]
    fn preserves_binary64_validation() {
        let value = 1792410863697.5723_f64;
        let mut bytes = b"WBR\x01\x03".to_vec();
        bytes.extend(value.to_le_bytes());
        assert_eq!(
            decode(&bytes)
                .ok()
                .and_then(|value| value.as_f64())
                .map(f64::to_bits),
            Some(value.to_bits())
        );
    }
}
