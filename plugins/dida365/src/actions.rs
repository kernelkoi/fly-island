// Action ids the host sends back, and what each one does.

use chrono::NaiveDate;
use fly_island_plugin_sdk::{json, Value};
use std::cell::RefCell;
use crate::api::{complete_task, create_task, fetch_projects, reopen_task, update_due_date, Api};
use crate::model::{entry_from_task, now_millis, DoneEntry, PluginState, TaskEntry};
use crate::sessions::{snapshot_from_memory, DONE_CAP};

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

/// `due.<projectId>.<taskId>.<YYYY-MM-DD>` sets a new day; `clear` removes it.
pub(crate) fn parse_due_action(action_id: &str) -> Option<(&str, &str, Option<NaiveDate>)> {
    let (project_id, task_id) = parse_id_action(action_id, "due.")?;
    let (task_id, day) = task_id.split_once('.')?;
    if task_id.is_empty() {
        return None;
    }
    let date = if day == "clear" { None } else { NaiveDate::parse_from_str(day, "%Y-%m-%d").ok().map(Some)? };
    Some((project_id, task_id, date))
}

/// Runs one action. After a confirmed write, publish what memory can show and leave refresh
/// reads to the SDK's poll after the reply.
pub(crate) fn handle(
    action_id: &str,
    api: &Api<'_>,
    state: &RefCell<PluginState>,
    publish: impl FnOnce(Value),
) -> Result<Value, String> {
    if action_id == "test" {
        // The settings "test connection" button: one real request tells the user whether the
        // token still works, without waiting for a poll or a failed checkbox.
        fetch_projects(api)?;
        return Ok(json!(true));
    }
    let mut state = state.borrow_mut();
    if let Some((project_id, task_id, date)) = parse_due_action(action_id) {
        update_due_date(api, project_id, task_id, date)?;
        let key = format!("{project_id}:{task_id}");
        if let Some(entry) = state.last_open.get_mut(&key) {
            entry.due_date = date;
            entry.modified_at = now_millis();
            state.verify_misses.remove(&key);
            publish(snapshot_from_memory(&state));
        } else if let Some(entry) = state.done.iter_mut().find(|entry| entry.key == key) {
            entry.due_date = date;
            publish(snapshot_from_memory(&state));
        }
        return Ok(json!(true));
    }
    if action_id.starts_with("due.") {
        return Err("Invalid TickTick due date action".to_owned());
    }
    if let Some((date, project_id, title)) = parse_create_action(action_id) {
        if let Some(response) = create_task(api, date, title, project_id)? {
            let task = response.get("data").unwrap_or(&response);
            // Use the same inbox id as the poll, even if the POST response uses an internal id.
            let project_id = project_id.unwrap_or("inbox");
            let project_name = state.last_open.values()
                .find(|entry| entry.project_id == project_id)
                .map_or("", |entry| entry.project_name.as_str());
            let title = task["title"].as_str().or_else(|| task["content"].as_str());
            if let Some(entry) = entry_from_task(task, project_id, project_name).filter(|entry| {
                entry.completed_at.is_none() && !entry.id.trim().is_empty() && title.is_some()
            }) {
                let key = format!("{}:{}", entry.project_id, entry.id);
                state.published.insert(key.clone());
                state.last_open.insert(key, entry);
                publish(snapshot_from_memory(&state));
            }
        }
        return Ok(json!(true));
    }
    // A `create.` action that fails to parse must come back as an error, not a plain
    // false: the frontend only keeps the user's text when the action rejects.
    if action_id.starts_with("create.") {
        return Err("Invalid TickTick quick add action".to_owned());
    }
    if let Some((project_id, task_id)) = parse_id_action(action_id, "reopen.") {
        reopen_task(api, project_id, task_id)?;
        let key = format!("{project_id}:{task_id}");
        let modified_at = now_millis();
        if let Some(index) = state.done.iter().position(|entry| entry.key == key) {
            let entry = state.done.remove(index);
            state.last_open.insert(key.clone(), TaskEntry {
                id: entry.task_id,
                project_id: entry.project_id,
                project_name: entry.project_name,
                title: entry.title,
                due_date: entry.due_date,
                modified_at,
                repeat_flag: entry.repeat_flag,
                priority: entry.priority,
                completed_at: None,
            });
        }
        if let Some(entry) = state.last_open.get_mut(&key) {
            entry.modified_at = modified_at;
            state.verify_misses.remove(&key);
            state.published.insert(key);
            publish(snapshot_from_memory(&state));
        }
        return Ok(json!(true));
    }
    if action_id.starts_with("reopen.") {
        return Err("Invalid TickTick reopen action".to_owned());
    }
    let Some((project_id, task_id)) = parse_id_action(action_id, "complete.") else {
        return Err("Unknown TickTick action".to_owned());
    };
    complete_task(api, project_id, task_id)?;
    let key = format!("{project_id}:{task_id}");
    if let Some(entry) = state.last_open.remove(&key) {
        state.published.remove(&key);
        state.verify_misses.remove(&key);
        state.done.retain(|entry| entry.key != key);
        state.done.push(DoneEntry::from_task(&entry, now_millis()));
        state.done.sort_by_key(|entry| std::cmp::Reverse(entry.completed_at));
        state.done.truncate(DONE_CAP);
        publish(snapshot_from_memory(&state));
    }
    Ok(json!(true))
}
