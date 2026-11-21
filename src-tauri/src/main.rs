// Stambha desktop shell.
//
// Native menu bar (About / Backup Now / Reveal Backups Folder / Quit) plus the
// privileged backup writes, which stay inside ~/Documents/Stambha.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod vault;

use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::menu::{AboutMetadata, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Emitter, Manager, Wry};
use tauri_plugin_dialog::DialogExt;

/// Set only when the webview has answered the close prompt; until then a close
/// request is diverted to the UI so the person can back up first.
static ALLOW_EXIT: AtomicBool = AtomicBool::new(false);
/// The webview sets this once its close prompt is mounted. Until then a close
/// must go through normally — a crashed UI must never trap the window open.
static CLOSE_PROMPT_READY: AtomicBool = AtomicBool::new(false);

/// The product name shown to people and used for the on-disk backup folder.
const APP_NAME: &str = "Stambha";
/// Folder names earlier builds wrote — "ContractorOS" before the rename and
/// "Sthamba" for the build before this one. Their runs must keep loading, so
/// each is adopted into APP_NAME on first use and still read if the move is
/// refused (a read-only volume), never ignored.
const LEGACY_APP_NAMES: [&str; 2] = ["Sthamba", "ContractorOS"];
/// Value written into every mirror and backup manifest.
const APP_MARKER: &str = "stambha";
const LEGACY_APP_MARKERS: [&str; 2] = ["sthamba", "contractorOS"];

/// True for a manifest written by this build or by any earlier one.
fn is_app_marker(value: Option<&str>) -> bool {
    match value {
        Some(marker) => marker == APP_MARKER || LEGACY_APP_MARKERS.contains(&marker),
        None => false,
    }
}

/// True when a path's first segment is this app's folder, past or present.
fn is_app_segment(segment: &str) -> bool {
    segment == APP_NAME || LEGACY_APP_NAMES.contains(&segment)
}

#[derive(serde::Deserialize, serde::Serialize)]
struct BackupFile {
    path: String,
    content: String,
}

#[derive(serde::Serialize)]
struct BackupRunInfo {
    run_id: String,
    created_at: String,
    files: u64,
    bytes: u64,
}

#[derive(serde::Serialize)]
struct BackupBundle {
    manifest: String,
    files: Vec<BackupFile>,
    /// The run's own folder, so the vault copy beside the JSON can be found.
    folder: String,
}

#[derive(serde::Serialize, serde::Deserialize)]
struct MirrorMeta {
    saved_at: String,
    bytes: u64,
    keys: u64,
    username: Option<String>,
}

#[derive(serde::Serialize)]
struct MirrorStatus {
    current: Option<MirrorMeta>,
    previous: Option<MirrorMeta>,
    folder: String,
}

/// One account's durable mirror lives under its own folder, so switching
/// accounts can never overwrite another person's last-known-good copy.
fn mirror_dir(app: &AppHandle, user: &str) -> Result<PathBuf, String> {
    let base = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(base.join("mirror").join(checked_segment(user)?))
}

/// Replace a file atomically: write a sibling temp file, flush it to disk, then
/// rename over the target. A crash either leaves the old file or the new one.
pub(crate) fn atomic_write(target: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let tmp = target.with_extension("tmp");
    {
        use std::io::Write;
        let mut file = fs::File::create(&tmp).map_err(|e| e.to_string())?;
        file.write_all(bytes).map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
    }
    // Windows refuses to rename onto an existing file; every other platform
    // replaces atomically.
    #[cfg(windows)]
    if target.exists() {
        let _ = fs::remove_file(target);
    }
    fs::rename(&tmp, target).map_err(|e| e.to_string())?;
    // Make the rename itself durable where the filesystem supports it.
    #[cfg(unix)]
    if let Some(parent) = target.parent() {
        if let Ok(dir) = fs::File::open(parent) {
            let _ = dir.sync_all();
        }
    }
    Ok(())
}

fn mirror_write_to(dir: &Path, payload: &str) -> Result<MirrorMeta, String> {
    let value: serde_json::Value =
        serde_json::from_str(payload).map_err(|e| format!("mirror payload is not JSON: {e}"))?;
    if !is_app_marker(value.get("app").and_then(|v| v.as_str()))
        || value.get("kind").and_then(|v| v.as_str()) != Some("live-mirror")
    {
        return Err("refusing to write a file that is not a Stambha live mirror".into());
    }
    let keys = value
        .get("keys")
        .and_then(|v| v.as_object())
        .ok_or_else(|| "mirror payload has no keys object".to_string())?;
    let meta = MirrorMeta {
        saved_at: value
            .get("savedAt")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        bytes: payload.len() as u64,
        keys: keys.len() as u64,
        username: value
            .get("user")
            .and_then(|u| u.get("username"))
            .and_then(|v| v.as_str())
            .map(|v| v.to_string()),
    };

    let live = dir.join("live.json");
    let previous = dir.join("live.previous.json");
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;

    // Keep exactly one previous version, and only once there is a current one.
    if live.exists() {
        if previous.exists() {
            fs::remove_file(&previous).map_err(|e| e.to_string())?;
        }
        fs::rename(&live, &previous).map_err(|e| e.to_string())?;
        let meta_path = dir.join("live.meta.json");
        if meta_path.exists() {
            let previous_meta = dir.join("live.previous.meta.json");
            let _ = fs::remove_file(&previous_meta);
            fs::rename(&meta_path, &previous_meta).map_err(|e| e.to_string())?;
        }
    }

    atomic_write(&live, payload.as_bytes())?;
    let meta_json = serde_json::to_vec(&meta).map_err(|e| e.to_string())?;
    atomic_write(&dir.join("live.meta.json"), &meta_json)?;
    Ok(meta)
}

fn read_meta(path: &Path) -> Option<MirrorMeta> {
    let text = fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
}

fn mirror_status_at(dir: &Path) -> MirrorStatus {
    MirrorStatus {
        current: read_meta(&dir.join("live.meta.json")),
        previous: read_meta(&dir.join("live.previous.meta.json")),
        folder: dir.to_string_lossy().to_string(),
    }
}

fn read_mirror_at(dir: &Path, which: &str) -> Result<String, String> {
    let name = match which {
        "current" => "live.json",
        "previous" => "live.previous.json",
        other => return Err(format!("unknown mirror version: {other}")),
    };
    fs::read_to_string(dir.join(name)).map_err(|e| format!("no {which} mirror copy available: {e}"))
}

/// Names Windows reserves for devices. A folder called `CON` (or `PRN`, `NUL`,
/// `COM1`…) cannot be created there at all, so such a name gets a suffix rather
/// than failing the whole backup on one platform. Matching is on the stem, so
/// `CON.pdf` is covered too.
pub(crate) fn is_reserved_windows_name(value: &str) -> bool {
    let stem = value.split('.').next().unwrap_or(value).to_ascii_uppercase();
    let stem = stem.trim_end();
    if matches!(stem, "CON" | "PRN" | "AUX" | "NUL") {
        return true;
    }
    let bytes = stem.as_bytes();
    bytes.len() == 4
        && (stem.starts_with("COM") || stem.starts_with("LPT"))
        && bytes[3].is_ascii_digit()
        && bytes[3] != b'0'
}

/// A single path segment: no separators, no `.`/`..`, nothing exotic.
pub(crate) fn checked_segment(value: &str) -> Result<String, String> {
    let ok = !value.is_empty()
        && value.len() <= 80
        && value
            .chars()
            .all(|c| c.is_alphanumeric() || c == '-' || c == '_');
    if !ok {
        return Err(format!("refusing unsafe folder name: {value}"));
    }
    if is_reserved_windows_name(value) {
        return Ok(format!("{value}_"));
    }
    Ok(value.to_string())
}

/// Where one account's backups live: <app>/<user> or <app>.
fn runs_root(root: &Path, user: Option<&str>) -> Result<PathBuf, String> {
    match user {
        Some(name) => Ok(root.join(checked_segment(name)?)),
        None => Ok(root.to_path_buf()),
    }
}

fn run_id_of(file_name: &str) -> Option<&str> {
    let rest = file_name.strip_prefix("manifest-")?.strip_suffix(".json")?;
    let b = rest.as_bytes();
    // YYYYMMDD-HHMMSS or YYYYMMDD-HHMMSS-mmm (older runs had no milliseconds).
    let base_ok = b.len() >= 15
        && b[..8].iter().all(|c| c.is_ascii_digit())
        && b[8] == b'-'
        && b[9..15].iter().all(|c| c.is_ascii_digit());
    let shape_ok = base_ok
        && match b.len() {
            15 => true,
            19 => b[15] == b'-' && b[16..].iter().all(|c| c.is_ascii_digit()),
            _ => false,
        };
    if shape_ok {
        Some(rest)
    } else {
        None
    }
}

/// Every backup run under one account's folder, newest first.
fn collect_runs(root: &Path, user: Option<&str>) -> Result<Vec<BackupRunInfo>, String> {
    let dir = runs_root(root, user)?;
    let entries = match fs::read_dir(&dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error.to_string()),
    };
    let mut runs = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        let Some(run_id) = run_id_of(&name) else { continue };
        let Ok(text) = fs::read_to_string(entry.path()) else { continue };
        let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) else { continue };
        runs.push(BackupRunInfo {
            run_id: run_id.to_string(),
            created_at: value
                .get("createdAt")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            files: value
                .pointer("/totals/files")
                .and_then(|v| v.as_u64())
                .unwrap_or(0),
            bytes: value
                .pointer("/totals/bytes")
                .and_then(|v| v.as_u64())
                .unwrap_or(0),
        });
    }
    runs.sort_by(|a, b| b.run_id.cmp(&a.run_id));
    Ok(runs)
}

/// Where a manifest path really lives on disk.
///
/// Manifests written before the rename begin with `ContractorOS/` while the
/// folder is now `Stambha` (or the other way round when an old folder could not
/// be moved). Only the first segment is swapped for the folder `root` actually
/// uses; the reported path stays exactly as the manifest wrote it.
fn manifest_path_on_disk(docs: &Path, root: &Path, relative: &str) -> Result<PathBuf, String> {
    let folder = root
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(APP_NAME);
    let mut parts = relative.splitn(2, '/');
    let first = parts.next().unwrap_or("");
    let mapped = if is_app_segment(first) {
        match parts.next() {
            Some(rest) => format!("{folder}/{rest}"),
            None => folder.to_string(),
        }
    } else {
        relative.to_string()
    };
    safe_join(docs, &mapped)
}

/// Read one run's manifest and every restorable file it lists.
///
/// Every path is resolved under `root`; a manifest that points outside the
/// backup folder is refused rather than read.
fn read_bundle(docs: &Path, root: &Path, user: Option<&str>, run_id: &str) -> Result<BackupBundle, String> {
    let dir = runs_root(root, user)?;
    let manifest_path = dir.join(format!("manifest-{run_id}.json"));
    let manifest = fs::read_to_string(&manifest_path)
        .map_err(|e| format!("could not read backup manifest: {e}"))?;
    let value: serde_json::Value =
        serde_json::from_str(&manifest).map_err(|e| format!("backup manifest is not valid JSON: {e}"))?;
    if !is_app_marker(value.get("app").and_then(|v| v.as_str())) {
        return Err("that folder does not contain a Stambha backup".into());
    }
    let mut files = Vec::new();
    let entries = value
        .get("files")
        .and_then(|v| v.as_array())
        .ok_or_else(|| "backup manifest has no file list".to_string())?;
    for entry in entries {
        if entry.get("restorable").and_then(|v| v.as_bool()) == Some(false) {
            continue;
        }
        let relative = entry
            .get("path")
            .and_then(|v| v.as_str())
            .ok_or_else(|| "backup manifest has a file without a path".to_string())?;
        let target = manifest_path_on_disk(docs, root, relative)?;
        if !target.starts_with(root) {
            return Err(format!("refusing to read outside the backup folder: {relative}"));
        }
        let content = fs::read_to_string(&target)
            .map_err(|e| format!("backup file is missing or unreadable ({relative}): {e}"))?;
        files.push(BackupFile {
            path: relative.to_string(),
            content,
        });
    }
    Ok(BackupBundle {
        manifest,
        files,
        folder: dir.to_string_lossy().to_string(),
    })
}

/// Where the person asked backups to go. `None` or blank means Documents.
///
/// A chosen folder is validated here — absolute, no `..` — before any file is
/// written, so the command can never be steered outside what was intended.
fn custom_backup_base(input: Option<String>) -> Result<Option<PathBuf>, String> {
    let raw = match input {
        Some(value) => value,
        None => return Ok(None),
    };
    let value = raw.trim().to_string();
    if value.is_empty() {
        return Ok(None);
    }
    let expanded = if value == "~" || value.starts_with("~/") {
        let home = std::env::var("HOME")
            .or_else(|_| std::env::var("USERPROFILE"))
            .map_err(|_| "could not find your home folder".to_string())?;
        if value == "~" {
            PathBuf::from(home)
        } else {
            PathBuf::from(home).join(&value[2..])
        }
    } else {
        PathBuf::from(&value)
    };
    if !expanded.is_absolute() {
        return Err("choose an absolute folder path for backups".into());
    }
    if expanded
        .components()
        .any(|c| matches!(c, Component::ParentDir))
    {
        return Err("the backup folder cannot contain ..".into());
    }
    Ok(Some(expanded))
}

/// The person's Documents folder, with a fallback for systems that do not
/// define one (a minimal Linux install has no XDG user directories at all).
/// Backups must never fail because a folder is missing — the write creates it.
fn documents_dir(app: &AppHandle) -> Result<PathBuf, String> {
    if let Ok(dir) = app.path().document_dir() {
        return Ok(dir);
    }
    let home = app.path().home_dir().map_err(|e| e.to_string())?;
    Ok(home.join("Documents"))
}

/// The backup folder inside `base`, adopting a pre-rename folder in place.
///
/// Builds before the rename wrote `Documents/ContractorOS`. On first use that
/// folder is moved to `Documents/Stambha`, so every existing run stays listed
/// and restorable instead of being stranded. If the move is not permitted
/// (a read-only volume), the old folder is used as-is — never ignored.
fn backup_root_dir(base: &Path) -> PathBuf {
    let current = base.join(APP_NAME);
    if current.exists() {
        return current;
    }
    // Adopt the newest earlier folder that exists, one rename at a time.
    for name in LEGACY_APP_NAMES {
        let legacy = base.join(name);
        if legacy.is_dir() && fs::rename(&legacy, &current).is_ok() {
            return current;
        }
    }
    // A move can be refused on a read-only volume: read the old folder then.
    for name in LEGACY_APP_NAMES {
        let legacy = base.join(name);
        if legacy.is_dir() {
            return legacy;
        }
    }
    current
}

/// The folder backup paths are written into, plus the app root inside it
/// (manifest paths already begin with the app name).
fn backup_base_and_root(
    app: &AppHandle,
    custom: Option<String>,
) -> Result<(PathBuf, PathBuf), String> {
    let base = match custom_backup_base(custom)? {
        Some(path) => path,
        None => documents_dir(app)?,
    };
    let root = backup_root_dir(&base);
    Ok((base, root))
}

fn safe_join(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let rel = Path::new(relative);
    if rel.is_absolute()
        || rel.components().any(|c| {
            matches!(
                c,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        return Err(format!("refusing unsafe backup path: {relative}"));
    }
    Ok(root.join(rel))
}

/// Write a backup tree under `root`.
///
/// Pure filesystem work (no Tauri types) so it can be tested directly: every
/// nested project/feature directory is created, each file is written with its
/// exact content, and a path that escapes `root` aborts the whole run.
fn write_backup_tree(root: &Path, files: &[BackupFile]) -> Result<(), String> {
    fs::create_dir_all(root).map_err(|e| e.to_string())?;
    for file in files {
        let target = safe_join(root, &file.path)?;
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        fs::write(&target, file.content.as_bytes()).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Older builds wrote `Documents/<app>/<app>/...` because the manifest paths
/// already begin with the app name. Move that stray level up so those backups
/// are listed and restorable instead of being stranded. Both the current and
/// the pre-rename folder name are checked, so every earlier build is covered.
fn flatten_legacy_root(root: &Path) -> Result<usize, String> {
    let mut moved = 0;
    for name in std::iter::once(APP_NAME).chain(LEGACY_APP_NAMES) {
        moved += flatten_nested_root(root, name)?;
    }
    Ok(moved)
}

fn flatten_nested_root(root: &Path, name: &str) -> Result<usize, String> {
    let nested = root.join(name);
    if !nested.is_dir() {
        return Ok(0);
    }
    let entries = fs::read_dir(&nested).map_err(|e| e.to_string())?;
    let mut moved = 0;
    for entry in entries.flatten() {
        let target = root.join(entry.file_name());
        if target.exists() {
            continue;
        }
        fs::rename(entry.path(), &target).map_err(|e| e.to_string())?;
        moved += 1;
    }
    // Only remove the leftover if everything could be moved out of it.
    let empty = fs::read_dir(&nested)
        .map(|mut dir| dir.next().is_none())
        .unwrap_or(false);
    if empty {
        let _ = fs::remove_dir(&nested);
    }
    Ok(moved)
}

/// Print the main window through the webview's native print operation.
///
/// The webview's own `window.print()` is a silent no-op on some macOS builds, so
/// macOS asks for the direct native call. `wry` only implements that operation
/// on macOS; every other platform answers `false` and the UI prints through
/// `window.print()`, which Tauri supports on all platforms.
#[tauri::command]
fn print_window(window: tauri::WebviewWindow<Wry>) -> Result<bool, String> {
    #[cfg(target_os = "macos")]
    {
        window.print().map_err(|error| error.to_string())?;
        return Ok(true);
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = &window;
        Ok(false)
    }
}

#[tauri::command]
fn save_backup_files(
    app: AppHandle,
    files: Vec<BackupFile>,
    root: Option<String>,
) -> Result<String, String> {
    // Manifest paths are already rooted at the app name, so they resolve
    // against the chosen base folder — joining them onto the app root nested
    // the folder one level too deep.
    let (base, folder) = backup_base_and_root(&app, root)?;
    write_backup_tree(&base, &files)?;
    Ok(folder.to_string_lossy().to_string())
}

#[tauri::command]
fn quit_app(app: AppHandle) {
    ALLOW_EXIT.store(true, Ordering::SeqCst);
    app.exit(0);
}

#[tauri::command]
fn close_prompt_ready() {
    CLOSE_PROMPT_READY.store(true, Ordering::SeqCst);
}

#[tauri::command]
fn mirror_write(app: AppHandle, user: String, payload: String) -> Result<MirrorMeta, String> {
    let dir = mirror_dir(&app, &user)?;
    mirror_write_to(&dir, &payload)
}

#[tauri::command]
fn mirror_status(app: AppHandle, user: String) -> Result<MirrorStatus, String> {
    let dir = mirror_dir(&app, &user)?;
    Ok(mirror_status_at(&dir))
}

#[tauri::command]
fn mirror_read(app: AppHandle, user: String, which: String) -> Result<String, String> {
    let dir = mirror_dir(&app, &user)?;
    read_mirror_at(&dir, &which)
}

#[tauri::command]
fn list_backup_runs(
    app: AppHandle,
    user: Option<String>,
    root: Option<String>,
) -> Result<Vec<BackupRunInfo>, String> {
    let (_base, folder) = backup_base_and_root(&app, root)?;
    flatten_legacy_root(&folder)?;
    collect_runs(&folder, user.as_deref())
}

#[tauri::command]
fn read_backup_run(
    app: AppHandle,
    run_id: String,
    user: Option<String>,
    root: Option<String>,
) -> Result<BackupBundle, String> {
    let (base, folder) = backup_base_and_root(&app, root)?;
    flatten_legacy_root(&folder)?;
    if run_id_of(&format!("manifest-{run_id}.json")).is_none() {
        return Err(format!("not a backup run id: {run_id}"));
    }
    read_bundle(&base, &folder, user.as_deref(), &run_id)
}

/// Open a folder in the platform's own file manager.
///
/// Every desktop target has a real implementation — `open` on macOS, Explorer on
/// Windows, `xdg-open` on Linux — because "Reveal folder" is a button people
/// press and expect to see a window. Windows' `/select,` form only applies to a
/// file inside a folder, so a directory is handed to Explorer as a directory.
pub(crate) fn open_dir(path: &Path) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    let launched = std::process::Command::new("open").arg(path).spawn();

    #[cfg(target_os = "windows")]
    let launched = std::process::Command::new("explorer").arg(path).spawn();

    #[cfg(all(unix, not(target_os = "macos")))]
    let launched = std::process::Command::new("xdg-open").arg(path).spawn();

    #[cfg(not(any(target_os = "macos", target_os = "windows", unix)))]
    let launched: std::io::Result<std::process::Child> = Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "this platform has no folder opener",
    ));

    launched
        .map(|_| ())
        .map_err(|error| format!("could not open the folder: {error}"))
}

/// Open a bundled file with the platform's default application.
///
/// Used for the licence notices the installer carries: MIT and Apache-2.0 both
/// require the notice to travel with copies of the software, so it is shipped
/// inside the bundle and opened from the Help menu.
fn open_file(path: &Path) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    let launched = std::process::Command::new("open").arg(path).spawn();

    // Explorer alone would only reveal the file; rundll32 hands it to its
    // registered handler, which is what "open" means on Windows.
    #[cfg(target_os = "windows")]
    let launched = std::process::Command::new("rundll32")
        .args(["url.dll,FileProtocolHandler"])
        .arg(path)
        .spawn();

    #[cfg(all(unix, not(target_os = "macos")))]
    let launched = std::process::Command::new("xdg-open").arg(path).spawn();

    #[cfg(not(any(target_os = "macos", target_os = "windows", unix)))]
    let launched: std::io::Result<std::process::Child> = Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "this platform has no file opener",
    ));

    launched
        .map(|_| ())
        .map_err(|error| format!("could not open the file: {error}"))
}

/// The third-party licence notice bundled with the installer.
fn open_notices(app: &AppHandle) -> Result<(), String> {
    let dir = app.path().resource_dir().map_err(|e| e.to_string())?;
    open_file(&dir.join("THIRD-PARTY-NOTICES.txt"))
}

#[tauri::command]
fn reveal_backup_folder(app: AppHandle, root: Option<String>) -> Result<(), String> {
    let (_base, folder) = backup_base_and_root(&app, root)?;
    fs::create_dir_all(&folder).map_err(|e| e.to_string())?;
    open_dir(&folder)
}

/// Ask for a folder with the native panel (Finder/Explorer). Returns the chosen
/// absolute path, or None when the panel is dismissed. The path is validated
/// with the same rules the backup write uses, so the chooser cannot steer a
/// write outside an absolute, traversal-free folder.
#[tauri::command]
async fn choose_backup_folder(
    app: AppHandle,
    start: Option<String>,
) -> Result<Option<String>, String> {
    let mut dialog = app.dialog().file().set_title("Choose a folder for backups");
    if let Some(dir) = custom_backup_base(start)? {
        dialog = dialog.set_directory(dir);
    }
    // The panel is modal and blocking; keep it off the main thread.
    let picked = tauri::async_runtime::spawn_blocking(move || dialog.blocking_pick_folder())
        .await
        .map_err(|e| e.to_string())?;
    Ok(picked
        .and_then(|path| path.into_path().ok())
        .map(|path| path.to_string_lossy().to_string()))
}

fn about_item(app: &AppHandle) -> tauri::Result<PredefinedMenuItem<Wry>> {
    PredefinedMenuItem::about(
        app,
        Some("About Contractor's Stambha"),
        Some(AboutMetadata {
            name: Some("Contractor's Stambha".to_string()),
            version: Some(env!("CARGO_PKG_VERSION").to_string()),
            comments: Some(
                "Construction project management: BOQ, daily site reports, attendance, payroll, billing, job costing, WIP and a double-entry ledger."
                    .to_string(),
            ),
            copyright: Some("© 2026 Contractor's Stambha".to_string()),
            ..Default::default()
        }),
    )
}

fn licences_item(app: &AppHandle) -> tauri::Result<MenuItem<Wry>> {
    MenuItem::with_id(
        app,
        "third_party_licences",
        "Third-party licences",
        true,
        None::<&str>,
    )
}

fn file_menu(app: &AppHandle) -> tauri::Result<Submenu<Wry>> {
    let print = MenuItem::with_id(app, "print", "Print…", true, Some("CmdOrCtrl+P"))?;
    let backup = MenuItem::with_id(app, "backup_now", "Backup Now", true, Some("CmdOrCtrl+B"))?;
    let reveal = MenuItem::with_id(
        app,
        "reveal_backups",
        "Reveal Backups Folder",
        true,
        Some("CmdOrCtrl+Shift+B"),
    )?;
    Submenu::with_items(
        app,
        "File",
        true,
        &[
            &print,
            &PredefinedMenuItem::separator(app)?,
            &backup,
            &reveal,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::close_window(app, Some("Close Window"))?,
        ],
    )
}

fn edit_menu(app: &AppHandle) -> tauri::Result<Submenu<Wry>> {
    Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )
}

fn window_menu(app: &AppHandle) -> tauri::Result<Submenu<Wry>> {
    Submenu::with_items(
        app,
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(app, None)?,
            &PredefinedMenuItem::maximize(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::fullscreen(app, None)?,
        ],
    )
}

#[cfg(target_os = "macos")]
fn build_menu(app: &AppHandle) -> tauri::Result<Menu<Wry>> {
    let app_menu = Submenu::with_items(
        app,
        "Contractor's Stambha",
        true,
        &[
            &about_item(app)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::hide(app, Some("Hide Contractor's Stambha"))?,
            &PredefinedMenuItem::hide_others(app, Some("Hide Others"))?,
            &PredefinedMenuItem::show_all(app, Some("Show All"))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::quit(app, Some("Quit Contractor's Stambha"))?,
        ],
    )?;
    let help = Submenu::with_items(app, "Help", true, &[&licences_item(app)?])?;
    Menu::with_items(
        app,
        &[
            &app_menu,
            &file_menu(app)?,
            &edit_menu(app)?,
            &window_menu(app)?,
            &help,
        ],
    )
}

#[cfg(not(target_os = "macos"))]
fn build_menu(app: &AppHandle) -> tauri::Result<Menu<Wry>> {
    let help = Submenu::with_items(
        app,
        "Help",
        true,
        &[
            &about_item(app)?,
            &licences_item(app)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::quit(app, Some("Quit"))?,
        ],
    )?;
    Menu::with_items(
        app,
        &[&file_menu(app)?, &edit_menu(app)?, &window_menu(app)?, &help],
    )
}

fn main() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let menu = build_menu(app.handle())?;
            app.set_menu(menu)?;

            Ok(())
        })
        .on_menu_event(|app, event| match event.id().as_ref() {
            // Printing owns the whole page in the webview, so the menu only
            // asks the UI; App prints the sheet the open page registered.
            "print" => {
                let _ = app.emit("menu:print", ());
            }
            // Backup needs the webview's data, so it delegates to the same
            // runBackup() the Settings button uses.
            "backup_now" => {
                let _ = app.emit("menu:backup-now", ());
            }
            // Revealing the folder is pure filesystem work — do it natively.
            "reveal_backups" => {
                // The menu item has no access to the Settings preference, so it
                // opens the default folder; Settings reveals the chosen one.
                if let Err(error) = reveal_backup_folder(app.clone(), None) {
                    eprintln!("could not reveal backup folder: {error}");
                }
            }
            // The installer carries the notices it must reproduce — open them.
            "third_party_licences" => {
                if let Err(error) = open_notices(app) {
                    eprintln!("could not open third-party notices: {error}");
                }
            }
            _ => {}
        })
        // A window close is not an exit: hand it to the UI, which asks about a
        // backup, then calls quit_app() if the person still wants to leave.
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if CLOSE_PROMPT_READY.load(Ordering::SeqCst) && !ALLOW_EXIT.load(Ordering::SeqCst) {
                    api.prevent_close();
                    let _ = window.app_handle().emit("app:close-requested", ());
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            print_window,
            choose_backup_folder,
            save_backup_files,
            reveal_backup_folder,
            list_backup_runs,
            read_backup_run,
            quit_app,
            close_prompt_ready,
            mirror_write,
            mirror_status,
            mirror_read,
            vault::vault_upload_begin,
            vault::vault_upload_chunk,
            vault::vault_upload_finish,
            vault::vault_upload_abort,
            vault::vault_read_base64,
            vault::vault_exists,
            vault::vault_delete,
            vault::vault_usage,
            vault::vault_open,
            vault::vault_reveal,
            vault::vault_reveal_folder,
            vault::vault_folder,
            vault::vault_export_copy,
            vault::vault_backup_copy,
            vault::vault_restore_copy,
            vault::vault_purge_user
        ])
        .build(tauri::generate_context!())
        .expect("error while building Contractor's Stambha");

    app.run(|app_handle, event| {
        // Cmd+Q / menu Quit arrives here, not at the window handler.
        if let tauri::RunEvent::ExitRequested { api, code, .. } = event {
            if code.is_none()
                && CLOSE_PROMPT_READY.load(Ordering::SeqCst)
                && !ALLOW_EXIT.load(Ordering::SeqCst)
            {
                api.prevent_exit();
                let _ = app_handle.emit("app:close-requested", ());
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::{
        backup_root_dir, checked_segment, collect_runs, custom_backup_base, flatten_legacy_root,
        mirror_status_at, mirror_write_to, read_bundle, read_mirror_at, safe_join, write_backup_tree,
        is_app_segment, BackupFile, APP_NAME, LEGACY_APP_NAMES,
    };
    use std::fs;
    use std::path::Path;

    #[test]
    fn windows_device_names_are_made_safe() {
        // One platform's rules must never fail a backup on another.
        assert_eq!(checked_segment("CON").unwrap(), "CON_");
        assert_eq!(checked_segment("nul").unwrap(), "nul_");
        assert_eq!(checked_segment("COM1").unwrap(), "COM1_");
        assert_eq!(checked_segment("LPT9").unwrap(), "LPT9_");
        // Ordinary names and near-misses are left exactly as they are.
        assert_eq!(checked_segment("alex").unwrap(), "alex");
        assert_eq!(checked_segment("CONS").unwrap(), "CONS");
        assert_eq!(checked_segment("COM0").unwrap(), "COM0");
        assert_eq!(checked_segment("COM10").unwrap(), "COM10");
    }

    #[test]
    fn accepts_relative_backup_paths() {
        let path = safe_join(Path::new("/tmp/root"), "PRJ-001_BOQ/BOQ/boq.json").unwrap();
        assert_eq!(path, Path::new("/tmp/root/PRJ-001_BOQ/BOQ/boq.json"));
    }

    #[test]
    fn backup_folder_must_be_absolute_and_traversal_free() {
        assert!(custom_backup_base(Some("relative/backups".into())).is_err());
        assert!(custom_backup_base(Some("/tmp/a/../b".into())).is_err());
        assert!(custom_backup_base(None).unwrap().is_none());
        assert!(custom_backup_base(Some("   ".into())).unwrap().is_none());
        assert_eq!(
            custom_backup_base(Some("/tmp/cos-backups".into())).unwrap(),
            Some(std::path::PathBuf::from("/tmp/cos-backups"))
        );
    }

    #[test]
    fn rejects_traversal_and_absolute_paths() {
        assert!(safe_join(Path::new("/tmp/root"), "../evil.json").is_err());
        assert!(safe_join(Path::new("/tmp/root"), "/etc/passwd").is_err());
        assert!(safe_join(Path::new("/tmp/root"), "a/../../b.json").is_err());
    }

    /// The real desktop write path, exercised against a temp directory:
    /// ContractorOS/<project>/<feature>/<file> plus the company folders.
    #[test]
    fn writes_the_nested_backup_tree() {
        let root = std::env::temp_dir().join(format!("contractoros-backup-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);

        let files = vec![
            BackupFile {
                path: "PRJ-001_Sample-Commercial-Complex/BOQ/boq-20261112-110500.json".into(),
                content: "{\"items\":1}".into(),
            },
            BackupFile {
                path: "PRJ-001_Sample-Commercial-Complex/Attendance/attendance-20261112-110500.json".into(),
                content: "{\"2026-11-12\":{}}".into(),
            },
            BackupFile {
                path: "PRJ-002_Hill-Road/BOQ/boq-20261112-110500.json".into(),
                content: "[]".into(),
            },
            BackupFile {
                path: "_Company/Settings/company-settings-20261112-110500.json".into(),
                content: "{}".into(),
            },
            BackupFile {
                path: "manifest-20261112-110500.json".into(),
                content: "{\"app\":\"contractorOS\"}".into(),
            },
        ];

        write_backup_tree(&root, &files).expect("tree write should succeed");

        // Every file exists with exactly its content.
        for file in &files {
            let path = root.join(&file.path);
            assert!(path.is_file(), "missing file: {}", file.path);
            assert_eq!(fs::read_to_string(&path).unwrap(), file.content, "content mismatch: {}", file.path);
        }

        // The nested project/feature directories really were created.
        assert!(root.join("PRJ-001_Sample-Commercial-Complex").is_dir());
        assert!(root.join("PRJ-001_Sample-Commercial-Complex/BOQ").is_dir());
        assert!(root.join("PRJ-001_Sample-Commercial-Complex/Attendance").is_dir());
        assert!(root.join("PRJ-002_Hill-Road/BOQ").is_dir());
        assert!(root.join("_Company/Settings").is_dir());

        // A second run overwrites in place rather than nesting another level.
        write_backup_tree(&root, &files).expect("repeat write should succeed");
        assert!(root.join("PRJ-001_Sample-Commercial-Complex/BOQ/boq-20261112-110500.json").is_file());

        // An escaping path is refused.
        let escaped = write_backup_tree(
            &root,
            &[BackupFile { path: "../escaped.json".into(), content: "x".into() }],
        );
        assert!(escaped.is_err());
        assert!(!root.parent().unwrap().join("escaped.json").exists());

        fs::remove_dir_all(&root).expect("cleanup temp dir");
    }

    fn temp_docs(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "stambha-{tag}-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write_run(docs: &Path, user: &str, run: &str, files: &[(&str, &str)]) {
        let root = docs.join(APP_NAME).join(user);
        fs::create_dir_all(&root).unwrap();
        let entries: Vec<String> = files
            .iter()
            .map(|(path, _)| {
                format!(
                    "{{\"path\":\"{path}\",\"key\":\"contractoros_settings\",\"restorable\":true,\"bytes\":2,\"count\":1}}"
                )
            })
            .collect();
        let manifest = format!(
            "{{\"app\":\"contractorOS\",\"version\":2,\"runId\":\"{run}\",\"createdAt\":\"2026-11-13T12:00:00Z\",\"files\":[{}],\"totals\":{{\"files\":{},\"bytes\":99}}}}",
            entries.join(","),
            files.len() + 2
        );
        fs::write(root.join(format!("manifest-{run}.json")), manifest).unwrap();
        for (path, content) in files {
            // Fixture manifests may use the pre-rename prefix while the folder
            // has already been adopted under the new name — exactly what a real
            // migrated computer looks like.
            let on_disk = match path.split_once('/') {
                Some((first, rest)) if is_app_segment(first) => format!("{APP_NAME}/{rest}"),
                _ => path.to_string(),
            };
            let target = docs.join(on_disk);
            fs::create_dir_all(target.parent().unwrap()).unwrap();
            fs::write(target, content).unwrap();
        }
    }

    #[test]
    fn lists_and_reads_runs_under_the_account_folder() {
        let docs = temp_docs("runs");
        write_run(
            &docs,
            "alex",
            "20261113-120000-000",
            &[("ContractorOS/alex/_Company/Settings/company-settings.json", "{}")],
        );
        write_run(&docs, "alex", "20261112-090000-000", &[]);

        let root = docs.join(APP_NAME);
        let runs = collect_runs(&root, Some("alex")).unwrap();
        assert_eq!(runs.len(), 2);
        // Newest first, and the totals come from the manifest itself.
        assert_eq!(runs[0].run_id, "20261113-120000-000");
        assert_eq!(runs[0].files, 3);
        assert_eq!(runs[0].bytes, 99);

        let bundle = read_bundle(&docs, &root, Some("alex"), "20261113-120000-000").unwrap();
        assert_eq!(bundle.files.len(), 1);
        assert_eq!(bundle.files[0].content, "{}");

        fs::remove_dir_all(&docs).unwrap();
    }

    #[test]
    fn refuses_to_read_outside_the_backup_folder() {
        let docs = temp_docs("escape");
        let root = docs.join("ContractorOS");
        fs::create_dir_all(&root).unwrap();
        fs::write(
            docs.join("secret.json"),
            "{\"app\":\"contractorOS\"}",
        )
        .unwrap();
        fs::write(
            root.join("manifest-20261113-120000-000.json"),
            "{\"app\":\"contractorOS\",\"files\":[{\"path\":\"secret.json\",\"restorable\":true}]}",
        )
        .unwrap();

        // `secret.json` sits in Documents/, outside ContractorOS.
        assert!(read_bundle(&docs, &root, None, "20261113-120000-000").is_err());
        // And a traversal is refused before any read.
        assert!(checked_segment("../etc").is_err());
        assert!(checked_segment("alex").is_ok());

        fs::remove_dir_all(&docs).unwrap();
    }

    #[test]
    fn moves_a_doubly_nested_legacy_folder_up_one_level() {
        let docs = temp_docs("legacy");
        let root = docs.join("ContractorOS");
        let stray = root.join("ContractorOS").join("alex").join("PRJ-001_BOQ");
        fs::create_dir_all(&stray).unwrap();
        fs::write(stray.join("boq.json"), "[]").unwrap();

        let moved = flatten_legacy_root(&root).unwrap();
        assert_eq!(moved, 1);
        assert!(root.join("alex/PRJ-001_BOQ/boq.json").is_file());
        assert!(!root.join("ContractorOS").exists());

        // A second call is a no-op.
        assert_eq!(flatten_legacy_root(&root).unwrap(), 0);

        fs::remove_dir_all(&docs).unwrap();
    }

    #[test]
    fn legacy_backups_still_load_after_the_rename() {
        // Both earlier folder names, each with the marker that build wrote.
        for (folder, marker) in [
            (LEGACY_APP_NAMES[0], "sthamba"),
            (LEGACY_APP_NAMES[1], "contractorOS"),
        ] {
            let docs = temp_docs(&format!("rename-{folder}"));
            let legacy = docs.join(folder).join("alex");
            fs::create_dir_all(&legacy).unwrap();
            let manifest = format!(
                "{{\"app\":\"{marker}\",\"version\":2,\"runId\":\"20261112-090000-000\",\"createdAt\":\"2026-11-12T09:00:00Z\",\"files\":[],\"totals\":{{\"files\":0,\"bytes\":0}}}}"
            );
            fs::write(legacy.join("manifest-20261112-090000-000.json"), manifest).unwrap();

            // The first launch of this build adopts the old folder in place.
            let root = backup_root_dir(&docs);
            assert_eq!(root, docs.join(APP_NAME));
            assert!(docs.join(APP_NAME).is_dir());
            assert!(!docs.join(folder).exists());

            // That old run is still listed, and its manifest still loads.
            let runs = collect_runs(&root, Some("alex")).unwrap();
            assert_eq!(runs.len(), 1);
            assert_eq!(runs[0].run_id, "20261112-090000-000");
            let bundle = read_bundle(&docs, &root, Some("alex"), "20261112-090000-000").unwrap();
            assert!(bundle.manifest.contains(marker));
            assert!(bundle.files.is_empty());

            fs::remove_dir_all(&docs).unwrap();
        }
    }

    #[test]
    fn mirror_is_atomic_and_keeps_one_previous_version() {
        let dir = temp_docs("mirror").join("account");
        let first = r#"{"app":"contractorOS","kind":"live-mirror","savedAt":"2026-11-14T10:00:00Z","user":{"username":"alex"},"keys":{"contractoros_boq::PRJ-001":"[]"}}"#;
        let meta = mirror_write_to(&dir, first).unwrap();
        assert_eq!(meta.keys, 1);
        assert_eq!(meta.username.as_deref(), Some("alex"));
        assert!(meta.bytes > 0);
        // No previous copy exists until a second write happens.
        assert!(read_mirror_at(&dir, "previous").is_err());

        let second = first.replace("10:00:00Z", "11:00:00Z");
        mirror_write_to(&dir, &second).unwrap();
        assert!(read_mirror_at(&dir, "current").unwrap().contains("11:00:00Z"));
        assert!(read_mirror_at(&dir, "previous").unwrap().contains("10:00:00Z"));

        let status = mirror_status_at(&dir);
        assert_eq!(status.current.unwrap().keys, 1);
        assert_eq!(status.previous.unwrap().keys, 1);

        // Only real mirrors and known versions are accepted.
        assert!(mirror_write_to(&dir, r#"{"app":"other"}"#).is_err());
        assert!(mirror_write_to(&dir, "not json").is_err());
        assert!(read_mirror_at(&dir, "bogus").is_err());

        fs::remove_dir_all(dir.parent().unwrap()).unwrap();
    }
}
