// Action ids the host sends back, and what each one does.

use chrono::NaiveDate;
use fly_island_plugin_sdk::{json, Value};
use std::cell::RefCell;
use crate::api::{complete_task, create_task, fetch_projects, reopen_task};
use crate::model::{now_millis, DoneEntry, PluginState, TaskEntry};
use crate::poll::{refresh, refresh_list, republish};
use crate::sessions::DONE_CAP;

/// `create.<YYYY-MM-DD>.<title>`: the title may contain dots, so split only after the date.
/// `create.<date>.<title>` uses the plugin's default inbox; `create.<date>.list:<id>.<title>`
/// names a list from the published session's `listId`.
pub(crate) fn parse_create_action(action_id: &str) -> Option<(NaiveDate, Option<&str>, &str)> {
    let payload = action_id.strip_prefix("create.")?;
    let (date, rest) = payload.split_once('.')?;
    let date = NaiveDate::parse_from_str(date, "%Y-%m-%d").ok()?;
    let (project_id, title) = match rest.strip_prefix("list:") {
        Some(target) => {
            let (project_id, title) = target.split_once('.')?;
            (Some(project_id.trim()), title)
        }
        None => (None, rest),
    };
    if project_id.is_some_and(|id| id.is_empty() || id.len() > 4096 || id.contains('\0')) {
        return None;
    }
    let title = title.trim();
    // The cap counts characters, matching the frontend's `[...title].length`; bytes would
    // reject a 100-character Chinese title three times too early.
    if title.is_empty() || title.chars().count() > 200 || title.contains('\0') {
        return None;
    }
    Some((date, project_id, title))
}

/// `reopen.<projectId>.<taskId>`: ids carry no dots, so the first dot separates them.
pub(crate) fn parse_id_action<'a>(action_id: &'a str, prefix: &str) -> Option<(&'a str, &'a str)> {
    let payload = action_id.strip_prefix(prefix)?;
    let (project_id, task_id) = payload.split_once('.')?;
    if project_id.is_empty() || task_id.is_empty() || project_id.len() > 4096 || task_id.len() > 4096 {
        return None;
    }
    Some((project_id, task_id))
}

/// Runs one action. The connection test borrows no memory, so it reaches the provider before the
/// state is taken.
pub(crate) fn handle(action_id: &str, token: &str, state: &RefCell<PluginState>) -> Result<Value, String> {
    if action_id == "test" {
        // The settings "test connection" button: one real request tells the user whether the
        // token still works, without waiting for a poll or a failed checkbox.
        fetch_projects(token)?;
        return Ok(json!(true));
    }
    let mut state = state.borrow_mut();
    if let Some((date, project_id, title)) = parse_create_action(action_id) {
        create_task(token, date, title, project_id)?;
        // Only the receiving list changed: one request instead of the whole fan-out.
        refresh_list(token, &mut state, project_id.unwrap_or("inbox"));
        return Ok(json!(true));
    }
    // A `create.` action that fails to parse must come back as an error, not a plain
    // false: the frontend only keeps the user's text when the action rejects.
    if action_id.starts_with("create.") {
        return Err("Invalid TickTick quick add action".to_owned());
    }
    if let Some((project_id, task_id)) = parse_id_action(action_id, "reopen.") {
        reopen_task(token, project_id, task_id)?;
        let key = format!("{project_id}:{task_id}");
        let reopened = state
            .done
            .iter()
            .position(|entry| entry.key == key)
            .map(|index| state.done.remove(index));
        match reopened {
            Some(entry) => {
                // Put the row back where the open list draws it, from what the done row still
                // knows; the next poll refreshes it with the provider's copy.
                state.last_open.insert(key.clone(), TaskEntry {
                    id: entry.task_id,
                    project_id: entry.project_id,
                    project_name: entry.project_name,
                    title: entry.title,
                    due_date: entry.due_date,
                    modified_at: now_millis(),
                    repeat_flag: entry.repeat_flag,
                    priority: entry.priority,
                    completed_at: None,
                });
                state.published.insert(key);
                republish(&mut state);
            }
            None => refresh(token, &mut state),
        }
        return Ok(json!(true));
    }
    if action_id.starts_with("reopen.") {
        return Err("Invalid TickTick reopen action".to_owned());
    }
    let Some((project_id, task_id)) = parse_id_action(action_id, "complete.") else {
        return Err("Unknown TickTick action".to_owned());
    };
    complete_task(token, project_id, task_id)?;
    let key = format!("{project_id}:{task_id}");
    match state.last_open.get(&key).cloned() {
        Some(entry) => {
            // The provider confirmed the completion; move the row now and let the next poll
            // reconcile. A single checkbox costs no request fan-out.
            state.done.push(DoneEntry::from_task(&entry, now_millis()));
            state.done.sort_by_key(|entry| std::cmp::Reverse(entry.completed_at));
            state.done.truncate(DONE_CAP);
            republish(&mut state);
        }
        // This process never saw the row (its page came from a previous run's snapshot).
        None => refresh(token, &mut state),
    }
    Ok(json!(true))
}
