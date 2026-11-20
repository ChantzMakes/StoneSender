//! Local persistence in the OS app-data directory:
//! `profiles/<id>.json` and `app-settings.json`. Writes are atomic
//! (temp file + rename) so a crash never leaves a half-written profile.

use grbl_core::profile::MachineProfile;
use serde_json::Value;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

pub struct Storage {
    root: PathBuf,
}

fn safe_id(id: &str) -> Result<&str, String> {
    if !id.is_empty() && id.len() <= 80 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        Ok(id)
    } else {
        Err(format!("invalid profile id {id:?}"))
    }
}

pub fn write_atomic(path: &Path, contents: &str) -> io::Result<()> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, contents)?;
    fs::rename(&tmp, path)
}

impl Storage {
    pub fn new(root: PathBuf) -> io::Result<Self> {
        fs::create_dir_all(root.join("profiles"))?;
        Ok(Storage { root })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Raw JSON of every stored profile. The frontend migrates and validates
    /// (older schema versions are allowed here on purpose). Unreadable files
    /// are reported, not silently dropped.
    pub fn list_profiles(&self) -> Result<Vec<Value>, String> {
        let dir = self.root.join("profiles");
        let mut out = Vec::new();
        let entries = fs::read_dir(&dir).map_err(|e| e.to_string())?;
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }
            match fs::read_to_string(&path).map_err(|e| e.to_string()).and_then(|s| serde_json::from_str::<Value>(&s).map_err(|e| e.to_string())) {
                Ok(v) => out.push(v),
                Err(e) => log::warn!("skipping unreadable profile {path:?}: {e}"),
            }
        }
        Ok(out)
    }

    pub fn save_profile(&self, value: Value) -> Result<(), String> {
        let profile = MachineProfile::from_value(value.clone()).map_err(|e| e.to_string())?;
        let id = safe_id(&profile.id)?;
        let path = self.root.join("profiles").join(format!("{id}.json"));
        let text = serde_json::to_string_pretty(&value).map_err(|e| e.to_string())?;
        write_atomic(&path, &text).map_err(|e| e.to_string())
    }

    pub fn delete_profile(&self, id: &str) -> Result<(), String> {
        let id = safe_id(id)?;
        let path = self.root.join("profiles").join(format!("{id}.json"));
        match fs::remove_file(&path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e.to_string()),
        }
    }

    pub fn load_app_settings(&self) -> Result<Option<Value>, String> {
        let path = self.root.join("app-settings.json");
        match fs::read_to_string(&path) {
            Ok(s) => serde_json::from_str(&s).map(Some).map_err(|e| e.to_string()),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e.to_string()),
        }
    }

    pub fn save_app_settings(&self, value: &Value) -> Result<(), String> {
        let text = serde_json::to_string_pretty(value).map_err(|e| e.to_string())?;
        write_atomic(&self.root.join("app-settings.json"), &text).map_err(|e| e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(name: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!("cnc-sender-test-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&p);
        p
    }

    fn preset() -> Value {
        let path = format!("{}/../presets/generic-router.json", env!("CARGO_MANIFEST_DIR"));
        serde_json::from_str(&fs::read_to_string(path).unwrap()).unwrap()
    }

    #[test]
    fn save_list_delete_round_trip() {
        let s = Storage::new(temp_root("roundtrip")).unwrap();
        let mut p = preset();
        p["id"] = "abc-123".into();
        s.save_profile(p.clone()).unwrap();
        let all = s.list_profiles().unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0]["id"], "abc-123");
        s.delete_profile("abc-123").unwrap();
        assert!(s.list_profiles().unwrap().is_empty());
        let _ = fs::remove_dir_all(s.root());
    }

    #[test]
    fn rejects_invalid_profiles_and_ids() {
        let s = Storage::new(temp_root("invalid")).unwrap();
        let mut p = preset();
        p["id"] = "../evil".into();
        assert!(s.save_profile(p.clone()).is_err());
        p["id"] = "ok".into();
        p["geometry"]["envelope"]["x"] = (-1).into();
        assert!(s.save_profile(p).is_err());
        assert!(s.delete_profile("..\\x").is_err());
        let _ = fs::remove_dir_all(s.root());
    }
}
