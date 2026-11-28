use fly_island_plugin_sdk::{json, publish, run, session, stale, Value};
use std::{
    io::Write,
    process::{Command, Stdio},
    time::Duration,
};

const CHILD_ENV: &str = "FLY_ISLAND_SDK_RUNTIME_TEST_CHILD";

fn snapshot(id: &str) -> Value {
    json!({"sessions": [session(id, id, None, "running", 1, None, None)]})
}

#[test]
fn stdio_child() {
    if std::env::var_os(CHILD_ENV).is_none() {
        return;
    }
    let mut first_poll = true;
    run(
        Duration::from_secs(3600),
        |_| {
            if std::mem::take(&mut first_poll) {
                Ok(snapshot("poll"))
            } else {
                Err("test refresh failure".into())
            }
        },
        |id, _| {
            publish(snapshot(id)).map_err(|error| error.to_string())?;
            if id == "write" {
                publish(stale(snapshot("stale-action"))).map_err(|error| error.to_string())?;
            }
            Ok(json!(id))
        },
    )
    .unwrap();
}

fn exchange(actions: &[Value]) -> Vec<Value> {
    let mut child = Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "stdio_child", "--nocapture"])
        .env(CHILD_ENV, "1")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    {
        let mut input = child.stdin.take().unwrap();
        writeln!(
            input,
            "{}",
            json!({"jsonrpc":"2.0","id":0,"method":"initialize","params":{"apiVersion":1}})
        )
        .unwrap();
        for (index, params) in actions.iter().enumerate() {
            writeln!(
                input,
                "{}",
                json!({"jsonrpc":"2.0","id":index + 1,"method":"action","params":params})
            )
            .unwrap();
        }
        writeln!(input, "{}", json!({"jsonrpc":"2.0","method":"shutdown"})).unwrap();
    }
    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    // The test harness can prefix the first JSON-RPC line with the child test name.
    String::from_utf8(output.stdout)
        .unwrap()
        .lines()
        .filter_map(|line| line.find('{').map(|start| &line[start..]))
        .map(|line| serde_json::from_str(line).unwrap())
        .collect()
}

fn reply(messages: &[Value], id: u64) -> &Value {
    messages
        .iter()
        .find(|message| message["id"] == id)
        .unwrap()
}

fn published(messages: &[Value]) -> Vec<(&str, bool)> {
    messages
        .iter()
        .filter(|message| message["method"] == "publish")
        .map(|message| {
            let params = &message["params"];
            (
                params["sessions"][0]["id"].as_str().unwrap(),
                params["stale"] == true,
            )
        })
        .collect()
}

#[test]
fn handshake_announces_support_for_action_deadlines() {
    let messages = exchange(&[]);
    assert_eq!(reply(&messages, 0)["result"]["actionStartDeadline"], true);
}

#[test]
fn expired_action_is_rejected_before_callback() {
    let messages = exchange(&[json!({"id":"expired","startByMs":i64::MIN})]);
    assert_eq!(
        reply(&messages, 1)["error"]["message"],
        "plugin_action_expired"
    );
    assert_eq!(published(&messages), vec![("poll", false)]);
}

#[test]
fn actions_work_with_future_deadline_or_without_one() {
    let messages = exchange(&[
        json!({"id":"future","startByMs":i64::MAX}),
        json!({"id":"legacy"}),
    ]);
    assert_eq!(reply(&messages, 1)["result"], "future");
    assert_eq!(reply(&messages, 2)["result"], "legacy");
}

#[test]
fn invalid_deadline_is_rejected_before_callback() {
    let messages = exchange(&[
        json!({"id":"string","startByMs":"0"}),
        json!({"id":"fraction","startByMs":0.5}),
        json!({"id":"out-of-range","startByMs":i64::MAX as u64 + 1}),
    ]);
    for id in 1..=3 {
        assert_eq!(reply(&messages, id)["error"]["code"], -32602);
    }
    assert_eq!(published(&messages), vec![("poll", false)]);
}

#[test]
fn failed_poll_resends_latest_fresh_action_publish() {
    let messages = exchange(&[json!({"id":"write"})]);
    assert_eq!(reply(&messages, 1)["result"], "write");
    assert_eq!(
        published(&messages),
        vec![
            ("poll", false),
            ("write", false),
            ("stale-action", true),
            ("write", true),
        ]
    );
}
