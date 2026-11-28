// Turning remembered tasks into the session rows the host draws.

use chrono::{Local, NaiveDate};
use fly_island_plugin_sdk::{json, task as task_row, Value};
use std::collections::HashSet;
use crate::model::{list_name, task_bucket_for_due, DoneEntry, PluginState, TaskEntry};

/// The host rejects a publish above 200 rows; the done group only uses what the open rows leave.
pub(crate) const ROW_CAP: usize = 200;
/// Today's done group is a convenience, not an archive.
pub(crate) const DONE_CAP: usize = 50;

pub(crate) fn build_sessions(tasks: &[TaskEntry], cap: usize) -> Vec<Value> {
    let mut ordered = tasks.to_vec();
    ordered.sort_by(|left, right| {
        let left_bucket = task_bucket_for_due(left.due_date, left.repeat_flag);
        let right_bucket = task_bucket_for_due(right.due_date, right.repeat_flag);
        let rank = |bucket: &str| match bucket {
            "overdue" => 0,
            "today" => 1,
            "future" => 2,
            _ => 3,
        };
        let bucket_order = rank(left_bucket).cmp(&rank(right_bucket));
        if bucket_order != std::cmp::Ordering::Equal {
            return bucket_order;
        }
        let left_date = left.due_date.unwrap_or(NaiveDate::MAX);
        let right_date = right.due_date.unwrap_or(NaiveDate::MAX);
        left_date.cmp(&right_date).then_with(|| left.modified_at.cmp(&right.modified_at).reverse())
    });

    let mut sessions = Vec::new();
    let today = Local::now().date_naive();
    for task in ordered.into_iter().take(cap) {
        let action_id = format!("complete.{}.{}", task.project_id, task.id);
        // The calendar group is its own field; `status` stays the open/completed lifecycle word
        // instead of borrowing the agent's "waiting" to mean overdue.
        let bucket = task_bucket_for_due(task.due_date, task.repeat_flag);
        // A repeated task's past anchor means it belongs on today, not on its anchor day.
        // The due wording is the UI's job (in the user's language), so no detail line here.
        let calendar_due = task.due_date.map(|due| if task.repeat_flag && due < today { today } else { due });
        // The row's editor appends a day (or `clear`) to this prefix; declaring the namespace
        // instead of every day keeps the snapshot small and stable between polls.
        let due_prefix = format!("due.{}.{}.", task.project_id, task.id);
        sessions.push(task_row(
            &format!("{}:{}", task.project_id, task.id),
            &task.title,
            list_name(&task.project_id, &task.project_name).as_deref(),
            "running",
            task.modified_at,
            Some(action_id.as_str()),
            None,
            calendar_due.map(|due| due.to_string()).as_deref(),
            Some(task.project_id.as_str()),
            task.repeat_flag,
            Some(task.priority),
            Some(bucket),
            std::slice::from_ref(&due_prefix),
        ));
    }
    sessions
}

/// A done row: same shape as an open one, but its check undoes the completion instead.
pub(crate) fn done_row(entry: &DoneEntry) -> Value {
    let action_id = format!("reopen.{}.{}", entry.project_id, entry.task_id);
    task_row(
        &entry.key,
        &entry.title,
        list_name(&entry.project_id, &entry.project_name).as_deref(),
        "completed",
        entry.completed_at,
        Some(action_id.as_str()),
        None,
        entry.due_date.map(|due| due.to_string()).as_deref(),
        Some(entry.project_id.as_str()),
        entry.repeat_flag,
        Some(entry.priority),
        None,
        &[],
    )
}

/// The done group only uses the space the open rows leave: seeing what is still to do matters
/// more than reviewing what is finished.
pub(crate) fn append_done(sessions: &mut Vec<Value>, done: &[DoneEntry]) {
    for entry in done {
        if sessions.len() >= ROW_CAP {
            break;
        }
        sessions.push(done_row(entry));
    }
}

/// The snapshot the current memory describes: the open rows that were on the page, plus today's
/// done group. Actions republish through this instead of a full poll, so a click never waits on
/// the provider's whole project list, and a completed row is drawn once, as done.
pub(crate) fn snapshot_from_memory(state: &PluginState) -> Value {
    let done_keys: HashSet<&str> = state.done.iter().map(|entry| entry.key.as_str()).collect();
    let open: Vec<TaskEntry> = state
        .last_open
        .iter()
        .filter(|(key, _)| state.published.contains(*key) && !done_keys.contains(key.as_str()))
        .map(|(_, entry)| entry.clone())
        .collect();
    let mut sessions = build_sessions(&open, ROW_CAP);
    append_done(&mut sessions, &state.done);
    let mut snapshot = if sessions.is_empty() {
        json!({ "composer": true })
    } else {
        json!({ "sessions": sessions, "composer": true })
    };
    // Only a host that advertised support accepts this field; it keeps those lists' last shown
    // rows when this process has none (after a restart). Sorted, so the payload is stable.
    if state.host_failed_lists && !state.failed_lists.is_empty() {
        let mut lists: Vec<&String> = state.failed_lists.iter().collect();
        lists.sort();
        snapshot["failedTaskLists"] = json!(lists);
    }
    snapshot
}
