use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use std::{path::Path, sync::Mutex, time::Duration};

pub struct Database(pub Mutex<Result<Connection, String>>);

#[derive(Serialize)]
pub struct Snapshot {
    pub payload: Option<String>,
    pub revision: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Backup {
    pub id: i64,
    pub created_at: String,
}

pub fn open(path: &Path) -> Result<Connection, String> {
    let connection = Connection::open(path).map_err(|e| e.to_string())?;
    initialize(&connection)?;
    Ok(connection)
}

fn initialize(connection: &Connection) -> Result<(), String> {
    connection
        .busy_timeout(Duration::from_secs(5))
        .map_err(|e| e.to_string())?;
    let version: i64 = connection
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .map_err(|e| e.to_string())?;
    if version > 1 {
        return Err("数据库来自更新版本，请使用新版 TaskDock 打开".into());
    }
    connection.execute_batch(
        "PRAGMA journal_mode=WAL;
         PRAGMA synchronous=FULL;
         CREATE TABLE IF NOT EXISTS document (id INTEGER PRIMARY KEY CHECK(id=1), payload TEXT NOT NULL, revision INTEGER NOT NULL);
         CREATE TABLE IF NOT EXISTS backups (id INTEGER PRIMARY KEY AUTOINCREMENT, payload TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
         PRAGMA user_version=1;"
    ).map_err(|e| e.to_string())
}

pub fn validate_payload(payload: &str) -> Result<(), String> {
    if payload.len() > 50 * 1024 * 1024 {
        return Err("备份文件不能超过 50 MB".into());
    }
    let value: serde_json::Value = serde_json::from_str(payload).map_err(|e| e.to_string())?;
    if value.get("version").and_then(|v| v.as_u64()) != Some(2) {
        return Err("不支持的数据版本".into());
    }
    let tasks = value
        .get("tasks")
        .and_then(|v| v.as_array())
        .ok_or("事项列表无效")?;
    if tasks.len() > 20_000 {
        return Err("事项数量超过上限".into());
    }
    let mut ids = std::collections::HashSet::new();
    for task in tasks {
        let id = task
            .get("id")
            .and_then(|v| v.as_str())
            .ok_or("事项编号缺失")?;
        let title = task
            .get("title")
            .and_then(|v| v.as_str())
            .ok_or("事项名称缺失")?;
        if id.is_empty() || !ids.insert(id) || title.trim().is_empty() {
            return Err("事项编号重复或名称为空".into());
        }
    }
    Ok(())
}

pub fn read(connection: &Connection) -> Result<Snapshot, String> {
    connection
        .query_row(
            "SELECT payload, revision FROM document WHERE id=1",
            [],
            |row| {
                Ok(Snapshot {
                    payload: Some(row.get(0)?),
                    revision: row.get(1)?,
                })
            },
        )
        .optional()
        .map(|snapshot| {
            snapshot.unwrap_or(Snapshot {
                payload: None,
                revision: 0,
            })
        })
        .map_err(|e| e.to_string())
}

pub fn write(connection: &mut Connection, payload: &str, expected: i64) -> Result<i64, String> {
    validate_payload(payload)?;
    let tx = connection
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    let previous = read(&tx)?;
    if previous.revision != expected {
        return Err("数据已更新，请重新加载后再操作".into());
    }
    if let Some(ref old) = previous.payload {
        if old == payload {
            return Ok(previous.revision);
        }
        if validate_payload(old).is_ok() {
            tx.execute("INSERT INTO backups(payload) VALUES (?1)", [old])
                .map_err(|e| e.to_string())?;
        }
    }
    let revision = previous.revision + 1;
    tx.execute("INSERT INTO document(id,payload,revision) VALUES(1,?1,?2) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload, revision=excluded.revision", params![payload, revision]).map_err(|e| e.to_string())?;
    tx.execute(
        "DELETE FROM backups WHERE id NOT IN (SELECT id FROM backups ORDER BY id DESC LIMIT 20)",
        [],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(revision)
}

#[tauri::command]
pub fn read_document(database: tauri::State<'_, Database>) -> Result<Snapshot, String> {
    let guard = database.0.lock().map_err(|e| e.to_string())?;
    read(guard.as_ref().map_err(Clone::clone)?)
}

#[tauri::command]
pub fn write_document(
    database: tauri::State<'_, Database>,
    payload: String,
    expected_revision: i64,
) -> Result<i64, String> {
    let mut guard = database.0.lock().map_err(|e| e.to_string())?;
    write(
        guard.as_mut().map_err(|e| e.clone())?,
        &payload,
        expected_revision,
    )
}

#[tauri::command]
pub fn list_backups(database: tauri::State<'_, Database>) -> Result<Vec<Backup>, String> {
    let guard = database.0.lock().map_err(|e| e.to_string())?;
    let connection = guard.as_ref().map_err(Clone::clone)?;
    let mut statement = connection
        .prepare("SELECT id, created_at FROM backups ORDER BY id DESC")
        .map_err(|e| e.to_string())?;
    let rows = statement
        .query_map([], |row| {
            Ok(Backup {
                id: row.get(0)?,
                created_at: row.get(1)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn read_backup(database: tauri::State<'_, Database>, id: i64) -> Result<String, String> {
    let guard = database.0.lock().map_err(|e| e.to_string())?;
    guard
        .as_ref()
        .map_err(Clone::clone)?
        .query_row("SELECT payload FROM backups WHERE id=?1", [id], |row| {
            row.get(0)
        })
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn connection() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        initialize(&c).unwrap();
        c
    }
    fn document(title: &str) -> String {
        serde_json::json!({"version":2,"tasks":[{"id":"a","title":title}]}).to_string()
    }
    #[test]
    fn saves_with_backup_and_rejects_stale_writer() {
        let mut c = connection();
        let first = document("first");
        let second = document("second");
        assert_eq!(write(&mut c, &first, 0).unwrap(), 1);
        assert!(write(&mut c, &second, 0).is_err());
        assert_eq!(read(&c).unwrap().payload.unwrap(), first);
        assert_eq!(write(&mut c, &second, 1).unwrap(), 2);
        let backup: String = c
            .query_row("SELECT payload FROM backups", [], |row| row.get(0))
            .unwrap();
        assert_eq!(backup, first);
    }
    #[test]
    fn invalid_write_preserves_document_and_revision() {
        let mut c = connection();
        write(&mut c, &document("safe"), 0).unwrap();
        assert!(write(&mut c, "broken", 1).is_err());
        assert_eq!(read(&c).unwrap().revision, 1);
    }
    #[test]
    fn keeps_twenty_backups_and_no_backup_for_identical_save() {
        let mut c = connection();
        for i in 0..25 {
            write(&mut c, &document(&i.to_string()), i).unwrap();
        }
        assert_eq!(write(&mut c, &document("24"), 25).unwrap(), 25);
        let count: i64 = c
            .query_row("SELECT count(*) FROM backups", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 20);
    }
    #[test]
    fn refuses_future_database_schema() {
        let c = Connection::open_in_memory().unwrap();
        c.pragma_update(None, "user_version", 99).unwrap();
        assert!(initialize(&c).is_err());
    }

    #[test]
    fn document_revision_and_backup_survive_database_reopen() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("taskdock.sqlite3");
        {
            let mut c = open(&path).unwrap();
            write(&mut c, &document("first"), 0).unwrap();
            write(&mut c, &document("second"), 1).unwrap();
        }
        let c = open(&path).unwrap();
        let snapshot = read(&c).unwrap();
        assert_eq!(snapshot.revision, 2);
        assert_eq!(snapshot.payload.unwrap(), document("second"));
        let backup: String = c
            .query_row("SELECT payload FROM backups", [], |row| row.get(0))
            .unwrap();
        assert_eq!(backup, document("first"));
        let integrity: String = c
            .query_row("PRAGMA integrity_check", [], |row| row.get(0))
            .unwrap();
        assert_eq!(integrity, "ok");
    }

    #[test]
    fn separate_database_connections_cannot_overwrite_a_newer_revision() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("taskdock.sqlite3");
        let mut first = open(&path).unwrap();
        let mut second = open(&path).unwrap();
        let stale_revision = read(&second).unwrap().revision;
        write(&mut first, &document("newer"), 0).unwrap();
        assert!(write(&mut second, &document("stale"), stale_revision).is_err());
        assert_eq!(read(&second).unwrap().payload.unwrap(), document("newer"));
    }
}
