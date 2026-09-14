use std::{io::Write, path::Path};

pub fn save(path: &Path, payload: &str) -> Result<(), String> {
    crate::database::validate_payload(payload)?;
    let parent = path.parent().ok_or("备份路径无效")?;
    // Finish and flush a sibling file before replacing an existing backup.
    // An interrupted write must never truncate the user's last good export.
    let mut temporary = tempfile::NamedTempFile::new_in(parent).map_err(|e| e.to_string())?;
    temporary
        .write_all(payload.as_bytes())
        .map_err(|e| e.to_string())?;
    temporary.as_file().sync_all().map_err(|e| e.to_string())?;
    temporary.persist(path).map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    const PAYLOAD: &str = r#"{"version":2,"tasks":[]}"#;

    #[test]
    fn creates_and_replaces_a_backup_without_leaving_temporary_files() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("备份.json");
        save(&path, PAYLOAD).unwrap();
        let updated = r#"{"version":2,"tasks":[{"id":"a","title":"事项"}]}"#;
        save(&path, updated).unwrap();
        assert_eq!(std::fs::read_to_string(path).unwrap(), updated);
        assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 1);
    }

    #[test]
    fn invalid_export_keeps_existing_backup() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("backup.json");
        save(&path, PAYLOAD).unwrap();
        assert!(save(&path, "broken").is_err());
        assert_eq!(std::fs::read_to_string(path).unwrap(), PAYLOAD);
    }

    #[cfg(windows)]
    #[test]
    fn failed_replacement_keeps_existing_backup_and_cleans_temporary_file() {
        use std::os::windows::fs::OpenOptionsExt;
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("backup.json");
        save(&path, PAYLOAD).unwrap();
        let lock = std::fs::OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(&path)
            .unwrap();
        assert!(save(&path, r#"{"version":2,"tasks":[{"id":"b","title":"new"}]}"#).is_err());
        drop(lock);
        assert_eq!(std::fs::read_to_string(path).unwrap(), PAYLOAD);
        assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 1);
    }
}
