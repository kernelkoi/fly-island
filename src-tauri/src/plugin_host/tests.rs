use std::{io::{Cursor, Write}, sync::{Arc, Mutex}, time::{Duration, Instant}};
use serde_json::json;
use sha2::{Digest, Sha256};
use super::{download, manifest::Manifest, packages::{self, IndexEntry}, process::{self, Worker}, protocol, service::Host};

fn manifest() -> Manifest { Manifest::parse(include_bytes!("../../../plugins/example-hello/fly-island-plugin.json")).unwrap() }
#[test]
fn action_errors_reach_the_page_on_one_bounded_line() {
    let reply = json!({"jsonrpc":"2.0","id":3,"error":{"code":-32000,"message":"TickTick\ncompletion failed: 401"}});
    assert_eq!(process::action_error_message(&reply).as_deref(), Some("TickTick completion failed: 401"));
    let reply = json!({"error":{"message":"错".repeat(400)}});
    assert_eq!(process::action_error_message(&reply).unwrap().chars().count(), 301);
    assert_eq!(process::action_error_message(&json!({"error":{"message":"  "}})), None);
    assert_eq!(process::action_error_message(&json!({"error":{"code":-32601}})), None);
}

#[test]
fn stale_publish_does_not_replace_a_confirmed_snapshot() {
    let payload = |status, stale| {
        let line = json!({"jsonrpc":"2.0","method":"publish","params":{
            "sessions":[{"id":"example","title":"Review","status":status,"updatedAt":1}], "stale":stale
        }});
        protocol::parse_publish(&line.to_string(), &manifest()).unwrap().unwrap()
    };
    let mut last = None;
    let recovered = process::received_snapshot(&mut last, payload("running", true));
    assert!(recovered.stale);
    assert_eq!(recovered.sessions[0].status, "running");
    process::received_snapshot(&mut last, payload("completed", false));
    let replayed = process::received_snapshot(&mut last, payload("running", true));
    assert!(replayed.stale);
    assert_eq!(replayed.sessions[0].status, "completed");
    let replayed = process::received_snapshot(&mut last, protocol::Contributions { stale: true, ..Default::default() });
    assert!(replayed.stale);
    assert_eq!(replayed.sessions[0].status, "completed");
}

#[test]
fn a_reply_that_outlived_the_start_deadline_is_still_taken() {
    let queued = Instant::now();
    let (reply, receiver) = std::sync::mpsc::sync_channel(1);
    let mut pending = std::collections::HashMap::from([(7u64, (queued + process::ACTION_REPLY_TIMEOUT, reply))]);
    process::expire_pending(&mut pending, queued + process::ACTION_TIMEOUT);
    assert_eq!(pending.len(), 1);
    assert!(receiver.try_recv().is_err());
    process::expire_pending(&mut pending, queued + process::ACTION_REPLY_TIMEOUT);
    assert!(pending.is_empty());
    assert_eq!(receiver.try_recv().unwrap(), Err("plugin_action_unconfirmed".into()));
}

#[test]
fn a_restart_keeps_rows_of_lists_its_first_poll_could_not_read() {
    let row = |id: &str, list: &str, updated: i64| json!({
        "id":id,"title":id,"kind":"task","listId":list,"cwd":"List","status":"running",
        "updatedAt":updated,"action":null,"detail":null
    });
    let parse = |params: serde_json::Value| protocol::parse_publish(
        &json!({"jsonrpc":"2.0","method":"publish","params":params}).to_string(), &manifest()).unwrap().unwrap();
    let mut last = None;
    process::received_snapshot(&mut last, parse(json!({"sessions":[row("a:1","a",10), row("b:1","b",5)]})));
    // After the restart list a cannot be read; the fresh process remembers nothing of its rows.
    let merged = process::received_snapshot(&mut last, parse(json!({"sessions":[row("b:2","b",20)], "failedTaskLists":["a"]})));
    assert_eq!(merged.sessions.iter().map(|s| s.id.as_str()).collect::<Vec<_>>(), ["b:2", "a:1"]);
    // Wire-only: the page never sees the metadata, and the cache is the merged view.
    assert!(merged.failed_task_lists.is_empty());
    // A later poll that does read list a replaces it; nothing is resurrected from the old rows.
    let fresh = process::received_snapshot(&mut last, parse(json!({"sessions":[row("b:3","b",30), row("a:2","a",40)]})));
    assert_eq!(fresh.sessions.iter().map(|s| s.id.as_str()).collect::<Vec<_>>(), ["b:3", "a:2"]);
    let stale = process::received_snapshot(&mut last, protocol::Contributions { stale: true, failed_task_lists: vec!["a".into()], ..Default::default() });
    assert!(stale.stale && stale.failed_task_lists.is_empty() && stale.sessions.len() == 2);
}

#[test]
fn failed_list_metadata_is_bounded_and_ignored_without_a_cache() {
    let publish = |params: serde_json::Value| json!({"jsonrpc":"2.0","method":"publish","params":params}).to_string();
    let m = manifest();
    for failed in [json!([""]), json!(["a","a"]), json!(["\0"]), json!((0..201).map(|i| i.to_string()).collect::<Vec<_>>())] {
        assert!(protocol::parse_publish(&publish(json!({"sessions":[], "failedTaskLists":failed})), &m).is_err());
    }
    let data = protocol::parse_publish(&publish(json!({"sessions":[], "failedTaskLists":["a"]})), &m).unwrap().unwrap();
    let mut last = None;
    let first = process::received_snapshot(&mut last, data);
    assert!(first.failed_task_lists.is_empty());
}

#[test]
fn validates_manifest_and_protocol() {
    for (field, value) in [("id", json!("../escape")), ("id", json!("con")), ("apiVersion", json!(2)), ("permissions", json!(["webview"]))] {
        let mut v = serde_json::to_value(manifest()).unwrap(); v[field] = value;
        assert!(Manifest::parse(&serde_json::to_vec(&v).unwrap()).is_err());
    }
    for path in ["../test.exe", "C:/test.exe", "a\\test.exe", "/test.exe"] {
        let mut m = manifest(); m.runtime.command = path.into(); assert!(m.validate().is_err());
    }
    let mut m = manifest();
    m.icon = Some("ticktick".into());
    assert!(m.validate().is_ok());
    m.icon = Some("TickTick".into());
    assert!(m.validate().is_err());
    let publish = |params| json!({"jsonrpc":"2.0","method":"publish","params":params}).to_string();
    let m = manifest();
    assert!(protocol::parse_publish(&publish(json!({})), &m).unwrap().is_some());
    assert!(protocol::parse_publish(&"x".repeat(protocol::MAX_LINE+1), &m).is_err());
    assert!(protocol::parse_publish("{\"jsonrpc\":\"1.0\"}", &m).is_err());
    let invalid = json!({"quota":[{"id":"q","label":"q","remainingPercent":101,"secondaryPercent":null,"balance":null,"resetsAt":null,"updatedAt":1}]});
    assert!(protocol::parse_publish(&publish(invalid), &m).is_err());
    let session = |detail| json!({"sessions":[{"id":"s","title":"t","cwd":null,"status":"running","updatedAt":1,"action":null,"detail":detail}]});
    assert!(protocol::parse_publish(&publish(session(json!(null))), &m).unwrap().is_some());
    assert!(protocol::parse_publish(&publish(session(json!("下午 2 点前 · 工作"))), &m).unwrap().is_some());
    assert!(protocol::parse_publish(&publish(session(json!("\0"))), &m).is_err());
    let task = json!({"sessions":[{"id":"t","title":"t","kind":"task","cwd":null,"status":"running","updatedAt":1,"action":null,"detail":null}]});
    assert!(protocol::parse_publish(&publish(task), &m).unwrap().is_some());
    let bad_kind = json!({"sessions":[{"id":"t","title":"t","kind":"todo","cwd":null,"status":"running","updatedAt":1,"action":null,"detail":null}]});
    assert!(protocol::parse_publish(&publish(bad_kind), &m).is_err());
    let due_task = json!({"sessions":[{"id":"t","title":"t","kind":"task","cwd":null,"status":"running","updatedAt":1,"action":null,"detail":null,"due":"2026-11-17"}]});
    assert!(protocol::parse_publish(&publish(due_task), &m).unwrap().is_some());
    for due in ["2026-13-01", "2026-11-32", "2026-1-1", "today"] {
        let bad_due = json!({"sessions":[{"id":"t","title":"t","kind":"task","cwd":null,"status":"running","updatedAt":1,"action":null,"detail":null,"due":due}]});
        assert!(protocol::parse_publish(&publish(bad_due), &m).is_err());
    }
    // The host accepts the provider's 0–5 scale; the plugin page names 0/1/3/5 and leaves the
    // rest undrawn. Outside that range is a plugin bug, not a row to guess at.
    for priority in [0, 1, 2, 3, 4, 5] {
        let row = json!({"sessions":[{"id":"t","title":"t","kind":"task","cwd":null,"status":"running","updatedAt":1,"action":null,"detail":null,"priority":priority}]});
        assert!(protocol::parse_publish(&publish(row), &m).unwrap().is_some());
    }
    for priority in [-1, 6] {
        let row = json!({"sessions":[{"id":"t","title":"t","kind":"task","cwd":null,"status":"running","updatedAt":1,"action":null,"detail":null,"priority":priority}]});
        assert!(protocol::parse_publish(&publish(row), &m).is_err());
    }
    // The calendar group is a field of its own; an open row says "running" whatever its group.
    for bucket in ["overdue", "today", "future"] {
        let row = json!({"sessions":[{"id":"t","title":"t","kind":"task","cwd":null,"status":"running","updatedAt":1,"action":null,"detail":null,"bucket":bucket}]});
        assert!(protocol::parse_publish(&publish(row), &m).unwrap().is_some());
    }
    for bucket in ["", "waiting", "Overdue"] {
        let row = json!({"sessions":[{"id":"t","title":"t","kind":"task","cwd":null,"status":"running","updatedAt":1,"action":null,"detail":null,"bucket":bucket}]});
        assert!(protocol::parse_publish(&publish(row), &m).is_err());
    }
    // Extra row actions are namespaces: a prefix must end at a dot so it cannot authorize a
    // neighbouring id, and a handful per row is all any editor needs.
    let with_prefixes = |prefixes: serde_json::Value| json!({"sessions":[{"id":"t","title":"t","kind":"task","cwd":null,"status":"running","updatedAt":1,"action":null,"detail":null,"actionPrefixes":prefixes}]});
    assert!(protocol::parse_publish(&publish(with_prefixes(json!(["due.p1.t1."]))), &m).unwrap().is_some());
    assert!(protocol::parse_publish(&publish(with_prefixes(json!([]))), &m).unwrap().is_some());
    for bad in [json!(["due.p1.t1"]), json!([""]), json!(["due.\0."]), json!(["x", "x", "x", "x", "x", "x", "x", "x", "x"])] {
        assert!(protocol::parse_publish(&publish(with_prefixes(bad)), &m).is_err());
    }
    let mut restricted = m.clone(); restricted.contributes.clear();
    let n = json!({"notifications":[{"id":"n","sourceId":"test","appName":"test","icon":"plugin","title":"test","body":"test","receivedAt":1,"action":null}]});
    assert!(protocol::parse_publish(&publish(n), &restricted).is_err());
    // A plugin page: the manifest names one of the host's icons, and the panel may only use
    // declared actions.
    let mut with_panel = serde_json::to_value(&m).unwrap();
    with_panel["permissions"] = json!(["panel"]);
    with_panel["contributes"] = json!(["panel"]);
    with_panel["panel"] = json!({"icon": "battery"});
    with_panel["actions"] = json!([{"id": "refresh", "label": {"zh-CN": "重新扫描", "en": "Scan again"}}]);
    let page = Manifest::parse(&serde_json::to_vec(&with_panel).unwrap()).unwrap();
    let good = json!({"panel": {"headline": "2 个设备", "note": null, "rows": [{"id": "a", "title": "A", "detail": null, "percent": 59, "countdownTo": null, "tone": "warning"}], "actions": ["refresh"], "attention": true}});
    let parsed = protocol::parse_publish(&publish(good.clone()), &page).unwrap().unwrap();
    assert!(parsed.panel.is_some_and(|panel| panel.rows.len() == 1 && panel.attention));
    assert!(protocol::parse_publish(&publish(good.clone()), &m).is_err(), "a panel needs its contribution");
    for (field, value) in [("percent", json!(101)), ("tone", json!("loud")), ("countdownTo", json!(-1))] {
        let mut bad = good.clone();
        bad["panel"]["rows"][0][field] = value;
        assert!(protocol::parse_publish(&publish(bad), &page).is_err(), "{field}");
    }
    let mut undeclared_action = good.clone();
    undeclared_action["panel"]["actions"] = json!(["rest_now"]);
    assert!(protocol::parse_publish(&publish(undeclared_action), &page).is_err());
    let mut bad_manifest = with_panel.clone();
    bad_manifest["panel"] = json!({"icon": "usb"});
    assert!(Manifest::parse(&serde_json::to_vec(&bad_manifest).unwrap()).is_err(), "an icon the host cannot draw");
    let mut no_meta = with_panel.clone();
    no_meta.as_object_mut().unwrap().remove("panel");
    assert!(Manifest::parse(&serde_json::to_vec(&no_meta).unwrap()).is_err(), "contribution without a page");
    for (attempt, seconds) in [1, 2, 4, 8, 16, 32].into_iter().enumerate() {
        assert_eq!(process::restart_delay(attempt as u32), Some(Duration::from_secs(seconds)));
    }
    assert_eq!(process::restart_delay(6), None);
    assert_eq!(process::restart_delay(u32::MAX), None);
}

#[test]
fn all_bundled_manifests_are_accepted() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../plugins");
    let mut ids = std::collections::BTreeSet::new();
    for entry in std::fs::read_dir(root).unwrap().flatten() {
        let path = entry.path().join("fly-island-plugin.json");
        if path.is_file() {
            let manifest = Manifest::parse(&std::fs::read(&path).unwrap())
                .unwrap_or_else(|error| panic!("{}: {error}", path.display()));
            assert!(ids.insert(manifest.id), "Duplicate plugin manifest at {}", path.display());
        }
    }
    assert!(ids.contains("example-hello"));
    let market: Vec<String> = serde_json::from_str(include_str!("../../../plugins/market-packages.json")).unwrap();
    assert!(market.iter().all(|id| ids.contains(id)));
}

#[test]
fn eye_care_upgrade_rounds_legacy_durations_up_to_whole_minutes() {
    use super::storage::{upgrade_settings, Installed};
    let new = Manifest::parse(include_bytes!("../../../plugins/eye-care/fly-island-plugin.json")).unwrap();
    let mut old = new.clone();
    let rest = old.settings.iter_mut().find(|s| s.key == "rest-minutes").unwrap();
    rest.key = "rest".into();
    rest.kind = "text".into();
    rest.min = None;
    rest.max = None;
    rest.default = json!("20");
    let mut previous = Installed { manifest: old, enabled: true, directory: Default::default(),
        development: false, settings: Default::default() };
    assert_eq!(upgrade_settings(Some(&previous), &new)["rest-minutes"], "1");
    previous.settings.insert("rest".into(), json!("150"));
    let migrated = upgrade_settings(Some(&previous), &new);
    assert_eq!(migrated["rest-minutes"], "3");
    assert!(!migrated.contains_key("rest"));
    previous.settings.insert("rest-minutes".into(), json!("3"));
    assert_eq!(upgrade_settings(Some(&previous), &new)["rest-minutes"], "3");
    for (old, expected) in [("2.5", "3"), ("0.3333333333333333", "1"), ("60", "60")] {
        previous.settings.insert("rest-minutes".into(), json!(old));
        assert_eq!(upgrade_settings(Some(&previous), &new)["rest-minutes"], expected);
    }
    assert!(!upgrade_settings(None, &new).contains_key("rest-minutes"));
}

#[test]
fn integer_settings_reject_fractions_and_enforce_manifest_bounds() {
    let manifest = Manifest::parse(include_bytes!("../../../plugins/eye-care/fly-island-plugin.json")).unwrap();
    for (key, max) in [("period", 720), ("rest-minutes", 60), ("idle", 120)] {
        let setting = manifest.settings.iter().find(|s| s.key == key).unwrap();
        assert!(setting.accepts(&json!("1")));
        assert!(setting.accepts(&json!(max.to_string())));
        for invalid in ["", "0", "1.5", "-1", "1e1", "NaN", " 2 ", "4294967296"] {
            assert!(!setting.accepts(&json!(invalid)), "{key}: {invalid}");
        }
        assert!(!setting.accepts(&json!((max + 1).to_string())));
        assert!(!setting.accepts(&json!(1)));
    }
    for (min, max) in [(Some(3), Some(2)), (None, Some(2)), (Some(1), None)] {
        let mut invalid = manifest.clone();
        invalid.settings[0].min = min;
        invalid.settings[0].max = max;
        assert!(invalid.validate().is_err());
    }
}

#[test]
fn windows_device_names_and_archive_aliases_are_rejected() {
    for path in ["CON.txt", "aux.exe", "dir/COM1.log", "LPT9.exe", "LPT¹.log", "a./file", "a /file", "x:stream", "dir//x", "dir/../x"] {
        assert!(!super::manifest::relative_path(path), "{path}");
        let root = temporary(&format!("path-{}", path.bytes().map(u32::from).sum::<u32>()));
        let bytes = zip(&[(path, b"bad")]);
        assert!(packages::extract(&bytes, &root, &entry(&bytes, String::new())).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }
}

#[test]
fn development_directory_survives_pasted_quotes_and_whitespace() {
    // Windows wins "os error 123" on each of these before it looks at the directory, so the
    // paste has to be cleaned up rather than reported as a broken path.
    for raw in [r#""C:\tools\plugin""#, "  C:\\tools\\plugin  ", "\u{feff}C:\\tools\\plugin", "“C:\\tools\\plugin”"] {
        assert_eq!(super::clean_directory(raw), r"C:\tools\plugin", "{raw:?}");
    }
    assert_eq!(super::clean_directory(" \t"), "");
    assert_eq!(super::clean_directory(r"C:\tools\plugin"), r"C:\tools\plugin");
}

#[test]
fn stderr_does_not_leak_split_or_multiline_credentials() {
    let root = temporary("redaction");
    let secret = "sensitive-token".to_owned();
    let mut input = format!("{}{}\n", "x".repeat(8188), secret);
    input.push_str("before sensitive-token after\nfirst-secret\nsecond-secret\nunterminated-sensitive");
    let path = root.join("log");
    process::log_stderr(Cursor::new(input), &path, &[secret, "first-secret\nsecond-secret".into()]);
    let raw = std::fs::read_to_string(path).unwrap();
    assert!(!raw.contains("sensitive") && !raw.contains("first-secret") && !raw.contains("second-secret"));
    assert!(raw.contains("before [redacted] after"));
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn download_policy_and_file_limits_are_enforced() {
    for (url, dev, allowed) in [
        ("https://github.com/a", false, true), ("http://github.com/a", true, false),
        ("http://127.0.0.1/a", true, true), ("http://127.0.0.1/a", false, false),
        ("https://user:password@example.com/a", false, false), ("file:///C:/a", false, false),
    ] { assert_eq!(download::network_source_allowed(&reqwest::Url::parse(url).unwrap(), dev), allowed, "{url}"); }
    let fetch = |url: &str, local, limit| tauri::async_runtime::block_on(download::fetch(url, local, limit, Default::default()));
    let root = temporary("local-bound");
    let path = root.join("file"); std::fs::write(&path, [1; 32]).unwrap();
    assert!(fetch(path.to_str().unwrap(), true, 16).is_err());
    assert!(fetch(path.to_str().unwrap(), false, 64).is_err());
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn redirects_cannot_escape_the_local_http_policy() {
    use std::{io::Read, net::TcpListener};
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}/index", listener.local_addr().unwrap());
    let server = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        stream.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
        let mut request = [0; 2048]; let _ = stream.read(&mut request).unwrap();
        stream.write_all(b"HTTP/1.1 302 Found\r\nLocation: http://example.com/not-local\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").unwrap();
    });
    let error = tauri::async_runtime::block_on(download::fetch(&url, true, 1024, Default::default())).unwrap_err();
    server.join().unwrap();
    assert_eq!(error.code, download::REFUSED);
    assert!(!error.detail.contains("example.com"), "URL omitted from diagnostics: {}", error.detail);
}

#[test]
fn incompatible_plugin_does_not_hide_compatible_index_entries() {
    let good = entry(b"zip", "https://example.com/a.zip".into());
    let mut future = good.clone(); future.id = "future-plugin".into(); future.min_app_version = "999.0.0".into();
    let entries: Vec<_> = packages::parse_index(&serde_json::to_vec(&vec![good, future]).unwrap()).unwrap()
        .into_iter().filter(IndexEntry::compatible).collect();
    assert_eq!(entries.len(), 1); assert_eq!(entries[0].id, "example-hello");
}

#[test]
fn market_install_errors_report_the_failing_stage() {
    let root = temporary("market-error-codes");
    let host = Host::new(root.join("data"), None, true).unwrap();
    let index = root.join("index.json");
    let archive = root.join("bundle.zip");
    let mut registry = host.snapshot().registry;
    registry.developer_mode = true;
    registry.index_url = index.to_string_lossy().into_owned();
    host.persist(registry).unwrap();
    let install_error = || tauri::async_runtime::block_on(host.install("example-hello", false)).unwrap_err();
    assert_eq!(install_error(), "plugin_index_unavailable");
    std::fs::write(&index, b"not JSON").unwrap();
    assert_eq!(install_error(), "plugin_index_incompatible");
    std::fs::write(&index, b"[]").unwrap();
    assert_eq!(install_error(), "plugin_not_listed");
    let mut bundle = entry(b"not ZIP", archive.to_string_lossy().into_owned());
    let update_index = |bundle: &IndexEntry| std::fs::write(&index, serde_json::to_vec(&[bundle]).unwrap()).unwrap();
    bundle.min_app_version = "999.0.0".into();
    update_index(&bundle);
    assert_eq!(install_error(), "plugin_index_incompatible");
    bundle.min_app_version = env!("CARGO_PKG_VERSION").into();
    update_index(&bundle);
    assert_eq!(install_error(), "plugin_package_download_failed");
    std::fs::write(&archive, b"wrong bytes").unwrap();
    assert_eq!(install_error(), "plugin_package_integrity_failed");
    std::fs::write(&archive, b"not ZIP").unwrap();
    assert_eq!(install_error(), "plugin_package_invalid");
    let log = std::fs::read_to_string(host.root.join("plugin-logs/catalog.log")).unwrap();
    assert!(log.contains("plugin_package_integrity_failed: Plugin SHA-256 or size mismatch"));
    assert!(log.contains("Requires Fly Island 999.0.0"));
    assert!(host.snapshot().registry.installed.is_empty());
    assert!(!host.root.join("plugins/.staging-example-hello").exists());
    drop(host);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn registry_drops_secret_and_unknown_plaintext_settings() {
    let root = temporary("registry-settings");
    let mut m = manifest();
    m.settings.push(serde_json::from_value(json!({"key":"api_key","label":{"zh-CN":"密钥","en":"Key"},"type":"secret","default":""})).unwrap());
    let p = super::storage::Installed { manifest:m, enabled:false, directory:root.clone(), development:false,
        settings: [("api_key".into(), json!("never-persist")), ("unknown".into(), json!(true))].into() };
    let registry = super::storage::Registry { installed:[(p.manifest.id.clone(), p)].into(), ..Default::default() };
    super::storage::save(&root, &registry).unwrap();
    assert!(super::storage::load(&root).installed["example-hello"].settings.is_empty());
    std::fs::remove_dir_all(root).unwrap();
}
fn zip(files: &[(&str, &[u8])]) -> Vec<u8> {
    let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
    for (name, bytes) in files {
        writer.start_file(*name, zip::write::SimpleFileOptions::default()).unwrap();
        writer.write_all(bytes).unwrap();
    }
    writer.finish().unwrap().into_inner()
}
fn entry(bytes: &[u8], url: String) -> IndexEntry {
    let m = manifest();
    IndexEntry { id: m.id, version: m.version, name: m.name, description: m.description, api_version: 1, url, sha256: format!("{:x}", Sha256::digest(bytes)), size: bytes.len() as u64, min_app_version: env!("CARGO_PKG_VERSION").into() }
}
fn temporary(name: &str) -> std::path::PathBuf {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../node_modules/.cache/plugin-tests").join(format!("{name}-{}", std::process::id()));
    if root.exists() { std::fs::remove_dir_all(&root).unwrap(); }
    std::fs::create_dir_all(&root).unwrap(); root
}
#[test]
fn rejects_hash_and_zip_traversal() {
    let root = temporary("archive");
    let bytes = zip(&[("../escape.exe", b"bad")]);
    let e = entry(&bytes, String::new());
    assert!(packages::extract(&bytes, &root, &e).is_err());
    std::fs::remove_dir_all(root).unwrap();
}
fn fixture() -> std::path::PathBuf {
    let mut candidates = Vec::new();
    if let Ok(cur) = std::env::current_exe() {
        if let Some(debug_dir) = cur.parent().and_then(|p| p.parent()) {
            candidates.push(debug_dir.join("example-hello.exe"));
        }
    }
    if let Some(target) = std::env::var_os("CARGO_TARGET_DIR") {
        candidates.push(std::path::PathBuf::from(target).join("debug/example-hello.exe"));
    }
    candidates.push(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("target/debug/example-hello.exe"));
    candidates.push(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../target/debug/example-hello.exe"));
    candidates.push(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../plugins/target/debug/example-hello.exe"));
    for c in candidates {
        if c.exists() {
            return c;
        }
    }
    panic!("Build plugins/example-hello first with the same CARGO_TARGET_DIR");
}
#[test]
fn example_worker_handshake_actions_and_stop() {
    let root = temporary("process");
    std::fs::copy(fixture(), root.join("example-hello.exe")).unwrap();
    let live = Arc::new(Mutex::new(Vec::new())); let output = live.clone();
    let worker = Worker::start(root.clone(), manifest(), json!({"interval":"5"}), root.join("stderr.log"), Arc::new(move |data, status| { output.lock().unwrap().push((status.to_owned(), data)); }));
    let until = Instant::now() + Duration::from_secs(8);
    while !live.lock().unwrap().iter().any(|(_, d)| !d.quota.is_empty()) && Instant::now() < until { std::thread::sleep(Duration::from_millis(20)); }
    assert!(live.lock().unwrap().iter().any(|(s, d)| s == "running" && d.quota.len() == 1 && d.notifications.len() == 1 && d.sessions.len() == 1));
    assert_eq!(worker.request("action", json!({"id":"hello"})).unwrap().recv_timeout(Duration::from_secs(3)).unwrap().unwrap(), json!(true));
    let before = Instant::now(); drop(worker); assert!(before.elapsed() < Duration::from_secs(2));
    std::fs::remove_dir_all(root).unwrap();
}
#[test]
fn a_request_that_outlived_its_queue_does_not_reach_the_worker() {
    let root = temporary("expired-action");
    std::fs::copy(fixture(), root.join("example-hello.exe")).unwrap();
    let (waiting, queued) = std::sync::mpsc::sync_channel(1);
    let (resume, gate) = std::sync::mpsc::sync_channel(1);
    let gate = Mutex::new(Some(gate));
    let worker = Worker::start(root.clone(), manifest(), json!({}), root.join("stderr.log"), Arc::new(move |_, status| {
        if status == "starting" {
            if let Some(gate) = gate.lock().unwrap().take() {
                let _ = waiting.send(());
                let _ = gate.recv_timeout(Duration::from_secs(20));
            }
        }
    }));
    queued.recv_timeout(Duration::from_secs(3)).unwrap();
    let reply = worker.request("action", json!({"id":"hello"})).unwrap();
    std::thread::sleep(Duration::from_secs(16));
    resume.send(()).unwrap();
    let result = reply.recv_timeout(Duration::from_secs(8)).unwrap();
    drop(worker);
    std::fs::remove_dir_all(root).unwrap();
    assert_eq!(result, Err("plugin_action_expired".into()));
}

#[test]
fn local_index_install_enable_publish_disable_uninstall() {
    let root = temporary("installation");
    let exe = std::fs::read(fixture()).unwrap(); let m = serde_json::to_vec(&manifest()).unwrap();
    let bytes = zip(&[("fly-island-plugin.json", &m), ("example-hello.exe", &exe)]);
    let archive = root.join("example.zip"); std::fs::write(&archive, &bytes).unwrap();
    let e = entry(&bytes, reqwest::Url::from_file_path(&archive).unwrap().to_string());
    let index = root.join("plugins-index.json"); std::fs::write(&index, serde_json::to_vec(&vec![e]).unwrap()).unwrap();
    let host = Host::new(root.join("data"), None, true).unwrap(); let mut registry = host.snapshot().registry;
    registry.developer_mode = true; registry.index_url = index.to_string_lossy().into_owned(); host.persist(registry).unwrap();
    assert!(tauri::async_runtime::block_on(host.install("not-in-index", false)).is_err());
    tauri::async_runtime::block_on(host.install("example-hello", false)).unwrap();
    assert!(!host.snapshot().registry.installed["example-hello"].enabled);
    host.enable("example-hello", true).unwrap();
    let until = Instant::now() + Duration::from_secs(8);
    while !host.snapshot().live.get("example-hello").is_some_and(|l| !l.data.quota.is_empty()) && Instant::now() < until { std::thread::sleep(Duration::from_millis(20)); }
    assert_eq!(host.snapshot().live["example-hello"].data.notifications.len(), 1);
    assert_eq!(host.action("example-hello", "hello").unwrap(), json!(true));
    host.shutdown();
    assert!(host.workers.lock().unwrap().is_empty() && host.snapshot().live.is_empty());
    host.enable("example-hello", true).unwrap();
    let until = Instant::now() + Duration::from_secs(8);
    while !host.snapshot().live.get("example-hello").is_some_and(|l| !l.data.quota.is_empty()) && Instant::now() < until { std::thread::sleep(Duration::from_millis(20)); }
    assert_eq!(host.action("example-hello", "hello").unwrap(), json!(true));
    host.enable("example-hello", false).unwrap(); assert!(host.snapshot().live.is_empty());
    host.uninstall("example-hello").unwrap(); assert!(host.snapshot().registry.installed.is_empty());
    assert!(!host.root.join("plugins/example-hello").exists()); drop(host); std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn built_artifacts_index_installs_and_runs() {
    let index_file = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../artifacts/plugins/plugins-index.json");
    if !index_file.exists() {
        assert!(std::env::var_os("FLY_ISLAND_REQUIRE_PLUGIN_ARTIFACTS").is_none(), "Build the market packages before running this test");
        return;
    }
    const ISOLATED: &str = "FLY_ISLAND_PLUGIN_TEST_PROFILE";
    if std::env::var_os(ISOLATED).is_none() {
        let profile = temporary("built-index-profile");
        let status = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "plugin_host::tests::built_artifacts_index_installs_and_runs", "--nocapture"])
            .env(ISOLATED, &profile).env("USERPROFILE", &profile).env("HOME", &profile)
            .env("APPDATA", &profile).env("LOCALAPPDATA", &profile).env_remove("FLY_ISLAND_PLUGINS_INDEX")
            .status().unwrap();
        std::fs::remove_dir_all(profile).unwrap();
        assert!(status.success());
        return;
    }
    keyring::Entry::store_status().as_ref().unwrap();
    keyring_core::set_default_store(keyring_core::mock::Store::new().unwrap());
    let root = temporary("built-index-test");
    let host = Host::new(root.join("data"), None, true).unwrap();
    let mut registry = host.snapshot().registry;
    registry.developer_mode = true;
    let mut built = packages::parse_index(&std::fs::read(&index_file).unwrap()).unwrap();
    for entry in &mut built {
        let asset = format!("{}-{}-windows-x86_64.zip", entry.id, entry.version);
        assert!(entry.url.ends_with(&format!("/{asset}")));
        let archive = index_file.with_file_name(asset).canonicalize().unwrap();
        entry.url = archive.to_string_lossy().into_owned();
    }
    let local_index = root.join("local-index.json");
    std::fs::write(&local_index, serde_json::to_vec(&built).unwrap()).unwrap();
    registry.index_url = local_index.to_string_lossy().into_owned();
    host.persist(registry).unwrap();

    let entries = tauri::async_runtime::block_on(host.catalog()).unwrap();
    if !entries.iter().any(|entry| entry.id == "example-hello") {
        let approved: Vec<String> = serde_json::from_str(include_str!("../../../plugins/market-packages.json")).unwrap();
        assert!(approved.iter().all(|id| entries.iter().any(|entry| &entry.id == id)));
        assert_eq!(entries.len(), approved.len());
        assert!(!entries.is_empty());
        for entry in entries {
            let id = entry.id.as_str();
            tauri::async_runtime::block_on(host.install(id, false)).unwrap();
            assert!(!host.snapshot().registry.installed[id].enabled);
            match id {
                "eye-care" => {
                    host.enable(id, true).unwrap();
                    let until = Instant::now() + Duration::from_secs(8);
                    while !host.snapshot().live.get(id).is_some_and(|entry| entry.data.panel.is_some()) && Instant::now() < until {
                        std::thread::sleep(Duration::from_millis(20));
                    }
                    assert!(host.snapshot().live[id].data.panel.is_some());
                    host.enable(id, false).unwrap();
                    host.uninstall(id).unwrap();
                }
                "device-battery" => {
                    assert!(host.device_battery().is_err());
                    host.enable(id, true).unwrap();
                    assert!(host.device_battery().is_ok());
                    let bridge = host.snapshot().registry.installed[id].directory.join("device-battery-bridge.exe");
                    let output = std::process::Command::new(bridge).arg("battery").output().unwrap();
                    assert!(output.status.success());
                    let snapshot: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
                    assert!(snapshot["devices"].is_array());
                    host.uninstall(id).unwrap();
                    assert!(host.device_battery().is_err());
                }
                "minimax" => {
                    host.enable(id, true).unwrap();
                    let until = Instant::now() + Duration::from_secs(8);
                    while !host.snapshot().live.get(id).is_some_and(|entry| entry.status == "running") && Instant::now() < until {
                        std::thread::sleep(Duration::from_millis(20));
                    }
                    assert_eq!(host.snapshot().live[id].status, "running");
                    host.uninstall(id).unwrap();
                }
                _ => panic!("Unexpected package in the selected market: {id}"),
            }
        }
        assert!(host.snapshot().registry.installed.is_empty());
        drop(host);
        std::fs::remove_dir_all(root).unwrap();
        return;
    }

    tauri::async_runtime::block_on(host.install("example-hello", false)).unwrap();
    assert!(host.snapshot().registry.installed.contains_key("example-hello"));
    assert!(!host.snapshot().registry.installed["example-hello"].enabled);

    host.enable("example-hello", true).unwrap();
    let until = Instant::now() + Duration::from_secs(8);
    while !host.snapshot().live.get("example-hello").is_some_and(|l| !l.data.quota.is_empty()) && Instant::now() < until {
        std::thread::sleep(Duration::from_millis(20));
    }
    let live = host.snapshot().live;
    assert!(live.contains_key("example-hello"));
    assert_eq!(live["example-hello"].data.quota.len(), 1);
    assert_eq!(live["example-hello"].data.notifications.len(), 1);

    host.enable("example-hello", false).unwrap();
    assert!(host.snapshot().live.is_empty());
    host.uninstall("example-hello").unwrap();
    assert!(host.snapshot().registry.installed.is_empty());

    drop(host);
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn composer_actions_are_allowed_but_undeclared_ones_are_not() {
    let root = temporary("composer-actions");
    let host = Host::new(root.join("data"), None, true).unwrap();
    let plugin = super::storage::Installed {
        manifest: manifest(), enabled: true, directory: root.join("plugins/example-hello"),
        development: false, settings: Default::default(),
    };
    host.persist(super::storage::Registry { installed: [(plugin.manifest.id.clone(), plugin)].into(), ..Default::default() }).unwrap();
    // Nothing published yet: the composer allowance needs the plugin's own announcement.
    assert_eq!(host.action("example-hello", "create.2026-11-18.买牛奶").unwrap_err(), "Unknown plugin action");
    let live = |composer| super::service::Live {
        status: "running".into(), settings_configured: true,
        data: protocol::Contributions { composer, ..Default::default() },
    };
    for (composer, allowed) in [(true, true), (false, false)] {
        host.live.lock().unwrap().insert("example-hello".into(), live(composer));
        // A `create.` action for a composer plugin reaches the (here missing) worker; without the
        // announcement, and for anything outside the composer contract, the gate still rejects it.
        assert_eq!(
            host.action("example-hello", "create.2026-11-18.买牛奶").unwrap_err(),
            if allowed { "Plugin is stopped" } else { "Unknown plugin action" }
        );
        assert_eq!(host.action("example-hello", "complete.p1.t1").unwrap_err(), "Unknown plugin action");
    }
    // A row's own namespace: actions under the declared prefix reach the plugin, others do not.
    let prefix = |prefixes: serde_json::Value| super::service::Live {
        status: "running".into(), settings_configured: true,
        data: protocol::Contributions {
            sessions: serde_json::from_value(json!([{"id": "p1:t1", "title": "t", "kind": "task", "cwd": null, "status": "running", "updatedAt": 1, "action": null, "actionPrefixes": prefixes}])).unwrap(),
            ..Default::default()
        },
    };
    host.live.lock().unwrap().insert("example-hello".into(), prefix(json!(["due.p1.t1."])));
    for action in ["due.p1.t1.2026-11-20", "due.p1.t1.clear"] {
        assert_eq!(host.action("example-hello", action).unwrap_err(), "Plugin is stopped");
    }
    for action in ["due.p1.t2.2026-11-20", "due.p1.t1", "complete.p1.t1"] {
        assert_eq!(host.action("example-hello", action).unwrap_err(), "Unknown plugin action");
    }
    host.live.lock().unwrap().insert("example-hello".into(), prefix(json!([])));
    assert_eq!(host.action("example-hello", "due.p1.t1.2026-11-20").unwrap_err(), "Unknown plugin action");
    drop(host);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn disabled_host_does_not_start_fetch_or_change_saved_plugins() {
    let root = temporary("disabled-host");
    let plugin = super::storage::Installed {
        manifest: manifest(), enabled: true, directory: root.join("plugins/example-hello"),
        development: false, settings: Default::default(),
    };
    let registry = super::storage::Registry {
        installed: [(plugin.manifest.id.clone(), plugin)].into(),
        developer_mode: true, index_url: "http://127.0.0.1:1/must-not-fetch".into(),
    };
    super::storage::save(&root, &registry).unwrap();
    let saved = std::fs::read(root.join("plugins-state.json")).unwrap();
    let host = Host::new(root.clone(), None, false).unwrap();
    assert!(host.snapshot().registry.installed.is_empty());
    host.start("example-hello").unwrap();
    assert!(tauri::async_runtime::block_on(host.catalog()).unwrap().is_empty());
    tauri::async_runtime::block_on(host.install("example-hello", false)).unwrap();
    host.enable("example-hello", false).unwrap();
    host.setting("example-hello", "enabled", json!(false)).unwrap();
    host.uninstall("example-hello").unwrap();
    assert_eq!(host.action("example-hello", "hello").unwrap(), serde_json::Value::Null);
    host.persist(Default::default()).unwrap();
    assert!(host.workers.lock().unwrap().is_empty() && host.snapshot().live.is_empty());
    assert!(!root.join("plugins").exists() && !root.join("plugin-logs").exists());
    assert_eq!(std::fs::read(root.join("plugins-state.json")).unwrap(), saved);
    drop(host);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn market_host_only_exposes_approved_non_development_packages() {
    let root = temporary("market-only");
    let host = Host::market(root.clone(), None).unwrap();
    let from = |name: &str, manifest: Manifest, development| super::storage::Installed {
        manifest, enabled: true, directory: root.join("plugins").join(name),
        development, settings: Default::default(),
    };
    let mut registry = host.snapshot().registry;
    registry.developer_mode = true;
    registry.index_url = "http://127.0.0.1:1/local-index".into();
    let eye = Manifest::parse(include_bytes!("../../../plugins/eye-care/fly-island-plugin.json")).unwrap();
    let mini = Manifest::parse(include_bytes!("../../../plugins/minimax/fly-island-plugin.json")).unwrap();
    registry.installed.insert("example-hello".into(), from("example-hello", manifest(), false));
    registry.installed.insert("eye-care".into(), from("eye-care", eye, false));
    registry.installed.insert("minimax".into(), from("minimax", mini, true));
    host.persist(registry).unwrap();
    let public = host.public_snapshot();
    assert!(!public.registry.installed.contains_key("example-hello"));
    assert!(!public.registry.installed.contains_key("minimax"));
    assert!(public.registry.installed.contains_key("eye-care"));
    assert!(!public.registry.developer_mode && public.registry.index_url.is_empty());
    assert!(!host.allows_development());
    assert!(!host.source().1);
    assert!(host.source().0.ends_with("/releases/download/plugins-channel/plugins-index.json"));
    assert!(host.start("example-hello").is_err());
    assert_eq!(
        tauri::async_runtime::block_on(host.install("example-hello", false)).unwrap_err(),
        "Plugin is unavailable in this build"
    );
    assert!(host.start("minimax").is_err());
    assert!(host.uninstall("minimax").is_err());
    assert_eq!(host.snapshot().registry.installed.len(), 3);
    drop(host);
    std::fs::remove_dir_all(root).unwrap();
}

/// Real packages from the published `plugins-channel`, installed into a temporary directory and
/// removed again. Reads the release only. Run by hand:
/// `cargo test --manifest-path src-tauri/Cargo.toml published_market_packages -- --ignored --nocapture`
#[test]
#[ignore = "downloads the published packages from GitHub"]
fn published_market_packages_install() {
    // Removing MiniMax runs its own disconnect step and clears its credential: keep both away
    // from the real profile and Credential Manager.
    const ISOLATED: &str = "FLY_ISLAND_PLUGIN_LIVE_PROFILE";
    if std::env::var_os(ISOLATED).is_none() {
        let profile = temporary("published-profile");
        let status = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "plugin_host::tests::published_market_packages_install", "--ignored", "--nocapture"])
            .env(ISOLATED, &profile).env("USERPROFILE", &profile).env("HOME", &profile)
            .env("APPDATA", &profile).env("LOCALAPPDATA", &profile).env_remove("FLY_ISLAND_PLUGINS_INDEX")
            .status().unwrap();
        std::fs::remove_dir_all(profile).unwrap();
        assert!(status.success());
        return;
    }
    keyring::Entry::store_status().as_ref().unwrap();
    keyring_core::set_default_store(keyring_core::mock::Store::new().unwrap());
    let root = temporary("published-market");
    let host = Host::market(root.clone(), None).unwrap();
    let entries = tauri::async_runtime::block_on(host.catalog()).unwrap();
    assert!(!entries.is_empty(), "the published index lists no approved package");
    let mut failed = Vec::new();
    for entry in entries {
        let started = Instant::now();
        let result = tauri::async_runtime::block_on(host.install(&entry.id, false));
        println!("{} {} ({} bytes): {:?} in {:.1}s", entry.id, entry.version, entry.size, result, started.elapsed().as_secs_f32());
        if result.is_err() {
            failed.push(entry.id);
            continue;
        }
        assert!(host.root.join("plugins").join(&entry.id).join("fly-island-plugin.json").is_file());
        assert!(!host.root.join("plugins").join(format!(".download-{}.zip", entry.id)).exists());
        tauri::async_runtime::block_on(host.remove(&entry.id)).unwrap();
        assert!(!host.root.join("plugins").join(&entry.id).exists());
    }
    if !failed.is_empty() {
        println!("{}", std::fs::read_to_string(host.root.join("plugin-logs/catalog.log")).unwrap_or_default());
    }
    drop(host);
    std::fs::remove_dir_all(root).unwrap();
    assert!(failed.is_empty(), "failed: {failed:?}");
}
