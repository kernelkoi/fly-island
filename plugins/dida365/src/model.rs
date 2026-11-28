// Task rows as the plugin remembers them, and the provider fields they come from.

use chrono::{DateTime, Local, NaiveDate, TimeZone};
use fly_island_plugin_sdk::Value;
use std::collections::{HashMap, HashSet};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Clone, Debug)]
pub(crate) struct TaskEntry {
    pub(crate) id: String,
    pub(crate) project_id: String,
    pub(crate) project_name: String,
    pub(crate) title: String,
    pub(crate) due_date: Option<NaiveDate>,
    pub(crate) modified_at: i64,
    pub(crate) repeat_flag: bool,
    /// The provider's own importance: 0 none, 1 low, 3 medium, 5 high.
    pub(crate) priority: i64,
    /// Set when the provider itself reports the task as done (the list endpoint normally hides
    /// those rows, so this is the rare case where `/data` hands us one anyway).
    pub(crate) completed_at: Option<i64>,
}

/// A task the provider confirmed as completed today. The row keeps what it needs to be drawn
/// after the task stops appearing in the open list.
#[derive(Clone, Debug)]
pub(crate) struct DoneEntry {
    /// "project:task", the id the open row used, so the UI unmounts one and mounts the other.
    pub(crate) key: String,
    pub(crate) project_id: String,
    pub(crate) task_id: String,
    pub(crate) project_name: String,
    pub(crate) title: String,
    pub(crate) due_date: Option<NaiveDate>,
    pub(crate) repeat_flag: bool,
    pub(crate) priority: i64,
    pub(crate) completed_at: i64,
}

impl DoneEntry {
    pub(crate) fn from_task(task: &TaskEntry, completed_at: i64) -> Self {
        Self {
            key: format!("{}:{}", task.project_id, task.id),
            project_id: task.project_id.clone(),
            task_id: task.id.clone(),
            project_name: task.project_name.clone(),
            title: task.title.clone(),
            due_date: task.due_date,
            repeat_flag: task.repeat_flag,
            priority: task.priority,
            completed_at,
        }
    }
}

/// What the plugin remembers between polls. The list endpoint never returns completed tasks, so
/// the only way to see one is to notice it vanished and ask the provider about that one id.
#[derive(Default)]
pub(crate) struct PluginState {
    pub(crate) last_open: HashMap<String, TaskEntry>,
    pub(crate) done: Vec<DoneEntry>,
    /// Failed lookups per vanished row, dropped once the row settles or `VERIFY_RETRIES` is hit.
    pub(crate) verify_misses: HashMap<String, u8>,
    /// Keys of the open rows in the last published snapshot. `last_open` also holds vanished rows
    /// still waiting for a reply, which must not come back to the page when an action republishes.
    pub(crate) published: HashSet<String>,
    /// Lists the last poll could not read. Their rows stay in memory here, but after a restart
    /// there is no memory: the host carries what it last showed when these ids are published.
    pub(crate) failed_lists: HashSet<String>,
    /// The connected host advertised that it carries rows for `failed_lists` itself. Set from
    /// the reserved settings key on every poll and action; older hosts never send it.
    pub(crate) host_failed_lists: bool,
}

pub(crate) fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

pub(crate) fn local_date_of(millis: i64) -> Option<NaiveDate> {
    Local.timestamp_millis_opt(millis).single().map(|dt| dt.date_naive())
}

/// 滴答 API 的时间字段可能是毫秒数或带时区的 ISO 字符串，统一成 Unix 毫秒。
pub(crate) fn parse_epoch_millis(value: &Value) -> Option<i64> {
    if let Some(seconds_or_millis) = value.as_i64() {
        return Some(if seconds_or_millis < 10_000_000_000 {
            seconds_or_millis.saturating_mul(1000)
        } else {
            seconds_or_millis
        });
    }
    let raw = value.as_str()?;
    if let Ok(dt) = DateTime::parse_from_str(raw.trim(), "%Y-%m-%dT%H:%M:%S%.f%z") {
        return Some(dt.timestamp_millis());
    }
    if let Ok(dt) = DateTime::parse_from_str(raw.trim(), "%Y-%m-%dT%H:%M:%S%z") {
        return Some(dt.timestamp_millis());
    }
    None
}

pub(crate) fn parse_local_due_date(raw: &str) -> Option<NaiveDate> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    if let Ok(date) = NaiveDate::parse_from_str(trimmed, "%Y-%m-%d") {
        return Some(date);
    }
    if let Ok(dt) = DateTime::parse_from_str(trimmed, "%Y-%m-%dT%H:%M:%S%.f%z") {
        return Some(dt.with_timezone(&Local).date_naive());
    }
    if let Ok(dt) = DateTime::parse_from_str(trimmed, "%Y-%m-%dT%H:%M:%S%z") {
        return Some(dt.with_timezone(&Local).date_naive());
    }
    None
}

pub(crate) fn task_bucket_for_due(due_date: Option<NaiveDate>, repeat_flag: bool) -> &'static str {
    let Some(due) = due_date else {
        return "future";
    };
    let today = Local::now().date_naive();
    if due < today {
        if repeat_flag {
            "today"
        } else {
            "overdue"
        }
    } else if due == today {
        "today"
    } else {
        "future"
    }
}

pub(crate) fn parse_repeat_flag(task: &Value) -> bool {
    task["repeatFlag"].as_bool().unwrap_or(false)
        || task["repeatFlag"].as_i64().is_some_and(|v| v != 0)
        || task["repeatFlag"].as_str().is_some_and(|v| !v.trim().is_empty() && v != "0")
}

fn pretty_task_title(task: &Value) -> String {
    task["title"].as_str().or_else(|| task["content"].as_str()).unwrap_or("Untitled task").to_owned()
}

/// The list a row shows, if it has one. The inbox is a pseudo list the UI names in the user's
/// language, so its rows go nameless; an unnamed list falls back to the app name.
pub(crate) fn list_name(project_id: &str, project_name: &str) -> Option<String> {
    if project_id == "inbox" {
        None
    } else if project_name.trim().is_empty() {
        Some("TickTick".to_owned())
    } else {
        Some(project_name.to_owned())
    }
}

/// One task row's worth of data, or `None` for notes, nameless tasks and other non-tasks.
pub(crate) fn entry_from_task(task: &Value, project_id: &str, project_name: &str) -> Option<TaskEntry> {
    if task["kind"].as_str().is_some_and(|kind| kind.eq_ignore_ascii_case("note")) {
        return None;
    }
    let task_id = task["id"].as_str().filter(|id| !id.is_empty())?.to_owned();
    let title = pretty_task_title(task);
    if title.trim().is_empty() {
        return None;
    }
    let due_date = task["dueDate"].as_str().and_then(parse_local_due_date).or_else(|| {
        task["startDate"].as_str().and_then(parse_local_due_date)
    });
    let modified_at = parse_epoch_millis(&task["modifiedTime"])
        .or_else(|| parse_epoch_millis(&task["createdTime"]))
        .unwrap_or_else(now_millis);
    // `status != 0` means done. The timing is what tells us whether it belongs to today's group;
    // swallowing these rows would hide a completed to-do the moment the list endpoint returns it.
    let completed_at = (task["status"].as_i64().unwrap_or(0) != 0)
        .then(|| parse_epoch_millis(&task["completedTime"]).or(Some(modified_at)))
        .flatten();

    Some(TaskEntry {
        id: task_id,
        project_id: project_id.to_owned(),
        project_name: project_name.to_owned(),
        title,
        due_date,
        modified_at,
        repeat_flag: parse_repeat_flag(task),
        priority: parse_priority(task),
        completed_at,
    })
}

/// The provider's importance: 0 none, 1 low, 3 medium, 5 high. Anything else is treated as none,
/// so an unexpected value never invents a level the UI has no word for.
pub(crate) fn parse_priority(task: &Value) -> i64 {
    match task["priority"].as_i64() {
        Some(1) => 1,
        Some(3) => 3,
        Some(5) => 5,
        _ => 0,
    }
}
