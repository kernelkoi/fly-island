use super::{done_entry, open_task};
use crate::{actions, api::Api, model::{now_millis, PluginState}, poll};
use fly_island_plugin_sdk::{json, Value};
use std::cell::RefCell;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::Duration;

struct Server {
    base: String,
    requests: Arc<Mutex<Vec<String>>>,
    thread: Option<JoinHandle<()>>,
}

impl Server {
    fn new(reply: impl Fn(&str) -> Option<(&'static str, &'static str)> + Send + 'static) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let requests = Arc::new(Mutex::new(Vec::new()));
        let seen = Arc::clone(&requests);
        let thread = thread::spawn(move || {
            for stream in listener.incoming() {
                let mut stream = stream.unwrap();
                stream.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
                let mut reader = BufReader::new(&mut stream);
                let mut line = String::new();
                if reader.read_line(&mut line).unwrap() == 0 {
                    break;
                }
                let request = line.trim_end().split_once(" HTTP/").unwrap().0.to_owned();
                let mut length = 0;
                loop {
                    line.clear();
                    assert_ne!(reader.read_line(&mut line).unwrap(), 0, "missing end of headers");
                    if line == "\r\n" {
                        break;
                    }
                    if let Some((name, value)) = line.split_once(':') {
                        if name.eq_ignore_ascii_case("content-length") {
                            length = value.trim().parse().unwrap();
                        }
                    }
                }
                // Consume the POST before simulating a lost response.
                reader.read_exact(&mut vec![0; length]).unwrap();
                seen.lock().unwrap().push(request.clone());
                if let Some((status, body)) = reply(&request) {
                    write!(stream, "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
                }
            }
        });
        Self { base, requests, thread: Some(thread) }
    }

    fn api(&self) -> Api<'_> {
        Api { base: &self.base, token: "fake-test-token" }
    }

    fn requests(&self) -> Vec<String> {
        self.requests.lock().unwrap().clone()
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        drop(TcpStream::connect(self.base.trim_start_matches("http://")));
        self.thread.take().unwrap().join().unwrap();
    }
}

fn run_action(action: &str, server: &Server, state: &RefCell<PluginState>) -> (Result<Value, String>, Option<Value>) {
    let mut published = None;
    let result = actions::handle(action, &server.api(), state, |value| published = Some(value));
    (result, published)
}

#[test]
fn confirmed_row_actions_without_memory_leave_refresh_to_the_sdk() {
    let server = Server::new(|request| {
        Some(if request.starts_with("POST ") { ("204 No Content", "") } else { ("503 Unavailable", "") })
    });
    let state = RefCell::new(PluginState::default());
    for action in ["complete.p1.t1", "due.p1.t1.2026-11-20", "reopen.p1.t1"] {
        assert_eq!(run_action(action, &server, &state), (Ok(json!(true)), None));
    }
    assert_eq!(server.requests(), ["POST /project/p1/task/t1/complete", "POST /task/t1", "POST /task/t1"]);
}

#[test]
fn confirmed_row_actions_republish_from_memory() {
    let server = Server::new(|_| Some(("204 No Content", "")));
    let mut state = PluginState::default();
    state.last_open.insert("p1:t1".into(), open_task("t1", "Task", None, 1));
    state.published.insert("p1:t1".into());
    let state = RefCell::new(state);
    for (action, status, due) in [
        ("due.p1.t1.2026-11-20", "running", json!("2026-11-20")),
        ("complete.p1.t1", "completed", json!("2026-11-20")),
        ("reopen.p1.t1", "running", json!("2026-11-20")),
        ("due.p1.t1.clear", "running", Value::Null),
    ] {
        let (result, published) = run_action(action, &server, &state);
        assert_eq!(result, Ok(json!(true)));
        let published = published.expect("published snapshot");
        let rows = published["sessions"].as_array().unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["id"], "p1:t1");
        assert_eq!(rows[0]["status"], status);
        assert_eq!(rows[0]["due"], due);
    }
    assert_eq!(server.requests(), ["POST /task/t1", "POST /project/p1/task/t1/complete", "POST /task/t1", "POST /task/t1"]);
}

#[test]
fn confirmed_reopen_can_republish_a_remembered_row_pending_verification() {
    let server = Server::new(|_| Some(("204 No Content", "")));
    let mut state = PluginState::default();
    state.last_open.insert("p1:t1".into(), open_task("t1", "Task", None, 1));
    state.verify_misses.insert("p1:t1".into(), 1);
    let state = RefCell::new(state);
    let (result, published) = run_action("reopen.p1.t1", &server, &state);
    assert_eq!(result, Ok(json!(true)));
    let published = published.expect("published snapshot");
    assert_eq!(published["sessions"][0]["id"], "p1:t1");
    assert_eq!(published["sessions"][0]["status"], "running");
    assert!(state.borrow().verify_misses.is_empty());
    assert_eq!(server.requests(), ["POST /task/t1"]);
}

#[test]
fn quick_add_publishes_the_returned_task_without_refresh_reads() {
    let server = Server::new(|request| Some(match request {
        "POST /task" => ("201 Created", r#"{"id":"new","projectId":"p1","title":"Provider title","dueDate":"2026-11-20","status":0,"priority":3}"#),
        _ => ("503 Unavailable", ""),
    }));
    let mut state = PluginState::default();
    state.last_open.insert("p1:old".into(), open_task("old", "Existing task", None, 1));
    state.published.insert("p1:old".into());
    let state = RefCell::new(state);
    let (result, published) = run_action("create.2026-11-20.list:p1.New task", &server, &state);
    assert_eq!(result, Ok(json!(true)));
    let published = published.expect("published snapshot");
    let rows = published["sessions"].as_array().unwrap();
    let row = rows.iter().find(|row| row["id"] == "p1:new").unwrap();
    assert_eq!(row["title"], "Provider title");
    assert_eq!(row["cwd"], "计划");
    assert_eq!(row["due"], "2026-11-20");
    assert_eq!(row["priority"], 3);
    assert!(rows.iter().any(|row| row["id"] == "p1:old"));
    assert_eq!(server.requests(), ["POST /task"]);
}

#[test]
fn quick_add_confirms_even_with_no_usable_post_body() {
    for (status, body) in [
        ("204 No Content", ""),
        ("200 OK", "not JSON"),
        ("200 OK", r#"{"title":"No task ID"}"#),
    ] {
        let server = Server::new(move |request| {
            Some(if request == "POST /task" { (status, body) } else { ("503 Unavailable", "") })
        });
        let state = RefCell::new(PluginState::default());
        assert_eq!(run_action("create.2026-11-20.New task", &server, &state), (Ok(json!(true)), None));
        assert_eq!(server.requests(), ["POST /task"]);
    }
}

#[test]
fn a_lost_post_response_is_unconfirmed_and_not_replayed() {
    let server = Server::new(|_| None);
    let state = RefCell::new(PluginState::default());
    assert_eq!(run_action("create.2026-11-20.New task", &server, &state), (Err("plugin_action_unconfirmed".into()), None));
    assert_eq!(server.requests(), ["POST /task"]);
}

#[test]
fn http_rejection_reports_status_and_ambiguous_status_reports_unconfirmed() {
    for (status, message) in [
        ("401 Unauthorized", "TickTick reopen failed with status 401"),
        ("429 Too Many Requests", "TickTick reopen failed with status 429"),
        ("408 Request Timeout", "plugin_action_unconfirmed"),
        ("500 Internal Server Error", "plugin_action_unconfirmed"),
        ("502 Bad Gateway", "plugin_action_unconfirmed"),
    ] {
        let server = Server::new(move |_| Some((status, "fake-test-token or private data")));
        let mut state = PluginState::default();
        state.done.push(done_entry("p1:t1", "Done task", now_millis()));
        let state = RefCell::new(state);
        assert_eq!(run_action("reopen.p1.t1", &server, &state), (Err(message.into()), None));
        assert_eq!(state.borrow().done.len(), 1);
        assert_eq!(server.requests(), ["POST /task/t1"]);
    }
}

#[test]
fn redirect_to_get_does_not_confirm_the_post() {
    let server = Server::new(|request| Some(match request {
        "POST /task/p1" => ("302 Found\r\nLocation: /landing", ""),
        _ => ("200 OK", ""),
    }));
    let state = RefCell::new(PluginState::default());
    assert_eq!(run_action("reopen.p1.p1", &server, &state), (Err("plugin_action_unconfirmed".into()), None));
    assert_eq!(server.requests(), ["POST /task/p1"]);
}

#[test]
fn project_list_or_total_task_list_failure_leaves_memory_intact() {
    for (project_status, projects, list_status, tasks) in [
        ("401 Unauthorized", "", "200 OK", r#"{"tasks":[]}"#),
        ("200 OK", r#"{"error":"project list unavailable"}"#, "200 OK", r#"{"tasks":[]}"#),
        ("200 OK", r#"[{"id":"p1","name":"计划","kind":"TASK"}]"#, "503 Unavailable", ""),
        ("200 OK", r#"[{"id":"p1","name":"计划","kind":"TASK"}]"#, "200 OK", r#"{"data":{}}"#),
    ] {
        let server = Server::new(move |request| Some(if request == "GET /project" {
            (project_status, projects)
        } else {
            (list_status, tasks)
        }));
        let mut state = PluginState::default();
        state.last_open.insert("p1:t1".into(), open_task("t1", "Edited task", None, 1));
        state.published.insert("p1:t1".into());
        assert!(poll::poll_ticktick(&server.api(), &mut state).is_err());
        assert!(state.published.contains("p1:t1"));
        assert!(state.last_open.contains_key("p1:t1"));
        assert!(state.verify_misses.is_empty());
    }
}

#[test]
fn an_empty_successful_poll_is_distinct_from_failed_lists() {
    let server = Server::new(|request| Some(match request {
        "GET /project" => ("200 OK", "[]"),
        "GET /project/inbox/data" => ("200 OK", r#"{"tasks":[]}"#),
        _ => ("503 Unavailable", ""),
    }));
    assert_eq!(poll::poll_ticktick(&server.api(), &mut PluginState::default()), Ok(json!({"composer":true})));
}

#[test]
fn a_partial_poll_keeps_confirmed_rows_in_the_failed_list_without_verifying_them() {
    let server = Server::new(|request| Some(match request {
        "POST /task/t1" | "POST /project/p1/task/t2/complete" => ("204 No Content", ""),
        "GET /project" => ("200 OK", r#"[{"id":"p1","name":"计划","kind":"TASK"}]"#),
        "GET /project/p1/data" => ("503 Unavailable", ""),
        "GET /project/inbox/data" => ("200 OK", r#"{"tasks":[{"id":"fresh","title":"Fresh inbox task"}]}"#),
        _ => ("404 Not Found", ""),
    }));
    let mut state = PluginState::default();
    for id in ["t1", "t2"] {
        state.last_open.insert(format!("p1:{id}"), open_task(id, "Task", None, 1));
        state.published.insert(format!("p1:{id}"));
    }
    let state = RefCell::new(state);
    assert_eq!(run_action("due.p1.t1.2026-11-20", &server, &state).0, Ok(json!(true)));
    assert_eq!(run_action("complete.p1.t2", &server, &state).0, Ok(json!(true)));
    let snapshot = poll::poll_ticktick(&server.api(), &mut state.borrow_mut()).unwrap();
    let rows = snapshot["sessions"].as_array().unwrap();
    assert_eq!(rows.len(), 3);
    let row = |id| rows.iter().find(|row| row["id"] == id).unwrap();
    assert_eq!(row("p1:t1")["due"], "2026-11-20");
    assert_eq!(row("p1:t2")["status"], "completed");
    assert_eq!(row("inbox:fresh")["title"], "Fresh inbox task");
    assert!(!server.requests().iter().any(|request| request.starts_with("GET /project/p1/task/")));
}

#[test]
fn a_restarted_plugin_names_unreadable_lists_for_a_host_that_carries_them() {
    let failing = Server::new(|request| Some(match request {
        "POST /project/inbox/task/fresh/complete" => ("204 No Content", ""),
        "GET /project" => ("200 OK", r#"[{"id":"p1","name":"计划","kind":"TASK"}]"#),
        "GET /project/p1/data" => ("503 Unavailable", ""),
        "GET /project/inbox/data" => ("200 OK", r#"{"tasks":[{"id":"fresh","title":"Fresh inbox task"}]}"#),
        _ => ("404 Not Found", ""),
    }));
    let state = RefCell::new(PluginState::default());
    // An older host rejects an unknown publish field, so the list ids are only named to a host
    // that advertised support in its reserved settings key.
    let snapshot = poll::poll_ticktick(&failing.api(), &mut state.borrow_mut()).unwrap();
    assert!(snapshot.get("failedTaskLists").is_none());
    state.borrow_mut().host_failed_lists = true;
    let snapshot = poll::poll_ticktick(&failing.api(), &mut state.borrow_mut()).unwrap();
    assert_eq!(snapshot["failedTaskLists"], json!(["p1"]));
    assert_eq!(snapshot["sessions"].as_array().unwrap().len(), 1);
    // An action snapshot names the same lists: the host keeps their rows across replies too.
    let (result, published) = run_action("complete.inbox.fresh", &failing, &state);
    assert_eq!(result, Ok(json!(true)));
    assert_eq!(published.expect("published snapshot")["failedTaskLists"], json!(["p1"]));
    // Reading every list again settles them; the note goes away.
    let healthy = Server::new(|request| Some(match request {
        "GET /project" => ("200 OK", r#"[{"id":"p1","name":"计划","kind":"TASK"}]"#),
        "GET /project/p1/data" => ("200 OK", r#"{"tasks":[]}"#),
        "GET /project/inbox/data" => ("200 OK", r#"{"tasks":[]}"#),
        _ => ("404 Not Found", ""),
    }));
    let snapshot = poll::poll_ticktick(&healthy.api(), &mut state.borrow_mut()).unwrap();
    assert!(snapshot.get("failedTaskLists").is_none());
}
