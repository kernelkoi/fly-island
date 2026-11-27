// The TickTick Open API calls: project and task lists, one task, and the write paths.

use chrono::{Local, NaiveDate, NaiveTime, Offset, TimeZone};
use fly_island_plugin_sdk::{json, Value};
use std::time::Duration;
use crate::model::{entry_from_task, TaskEntry};

const API_BASE: &str = "https://api.dida365.com/open/v1";

fn project_token_header(token: &str) -> String {
    format!("Bearer {token}")
}

pub(crate) fn fetch_projects(token: &str) -> Result<Vec<Value>, String> {
    let response = ureq::get(&format!("{API_BASE}/project"))
        .set("Authorization", &project_token_header(token))
        .set("Accept", "application/json")
        .timeout(Duration::from_secs(10))
        .call()
        .map_err(|error| format!("TickTick project list failed: {error}"))?;

    let payload: Value = response.into_json().map_err(|error| format!("TickTick project payload invalid: {error}"))?;
    let empty = Vec::new();
    let projects = payload.as_array().or_else(|| payload["data"].as_array()).unwrap_or(&empty);
    Ok(projects.to_vec())
}

pub(crate) fn fetch_project_tasks(token: &str, project_id: &str, project_name: &str) -> Result<Vec<TaskEntry>, String> {
    let response = ureq::get(&format!("{API_BASE}/project/{project_id}/data"))
        .set("Authorization", &project_token_header(token))
        .set("Accept", "application/json")
        .timeout(Duration::from_secs(10))
        .call()
        .map_err(|error| format!("TickTick tasks for project {project_id} failed: {error}"))?;

    let payload: Value = response.into_json().map_err(|error| format!("TickTick task payload invalid for {project_id}: {error}"))?;
    let empty = Vec::new();
    let tasks = payload["tasks"].as_array().or_else(|| payload["data"]["tasks"].as_array()).unwrap_or(&empty);

    Ok(tasks.iter().filter_map(|task| entry_from_task(task, project_id, project_name)).collect())
}

/// The one reliable source of a completed task's status and real `completedTime`. `Ok(None)` means
/// the provider no longer knows the task (deleted, or moved to another list): there is nothing left
/// to verify, so the caller forgets the row instead of asking about it on every poll.
pub(crate) fn fetch_task(token: &str, project_id: &str, task_id: &str) -> Result<Option<Value>, String> {
    let response = match ureq::get(&format!("{API_BASE}/project/{project_id}/task/{task_id}"))
        .set("Authorization", &project_token_header(token))
        .set("Accept", "application/json")
        .timeout(Duration::from_secs(10))
        .call()
    {
        Ok(response) => response,
        Err(ureq::Error::Status(404 | 410, _)) => return Ok(None),
        Err(error) => return Err(format!("TickTick task lookup failed: {error}")),
    };

    response.into_json().map(Some).map_err(|error| format!("TickTick task payload invalid: {error}"))
}

pub(crate) fn complete_task(token: &str, project_id: &str, task_id: &str) -> Result<Value, String> {
    let url = format!("{API_BASE}/project/{project_id}/task/{task_id}/complete");
    let response = ureq::post(&url)
        .set("Authorization", &project_token_header(token))
        .set("Accept", "application/json")
        .set("Content-Type", "application/json")
        .timeout(Duration::from_secs(10))
        .send_string("{}")
        .map_err(|error| format!("TickTick complete request failed: {error}"))?;

    if response.status() >= 400 {
        return Err(format!("TickTick completion failed with status {}", response.status()));
    }
    Ok(json!(true))
}

/// Undo a completion. The update endpoint needs the task's own id in the body as well as the
/// project, otherwise it answers 404 and nothing changes.
pub(crate) fn reopen_task(token: &str, project_id: &str, task_id: &str) -> Result<Value, String> {
    let body = json!({"id": task_id, "projectId": project_id, "status": 0});
    let response = ureq::post(&format!("{API_BASE}/task/{task_id}"))
        .set("Authorization", &project_token_header(token))
        .set("Accept", "application/json")
        .set("Content-Type", "application/json")
        .timeout(Duration::from_secs(10))
        .send_string(&body.to_string())
        .map_err(|error| format!("TickTick reopen request failed: {error}"))?;

    if response.status() >= 400 {
        return Err(format!("TickTick reopen failed with status {}", response.status()));
    }
    Ok(json!(true))
}

/// Quick add goes to the inbox unless a list id is supplied.
pub(crate) fn create_task(token: &str, date: NaiveDate, title: &str, project_id: Option<&str>) -> Result<Value, String> {
    let mut body = json!({
        "title": title,
        "dueDate": all_day_due(date),
        "isAllDay": true,
    });
    if let Some(project_id) = project_id {
        body["projectId"] = json!(project_id);
    }
    let response = ureq::post(&format!("{API_BASE}/task"))
        .set("Authorization", &project_token_header(token))
        .set("Accept", "application/json")
        .set("Content-Type", "application/json")
        .timeout(Duration::from_secs(10))
        .send_string(&body.to_string())
        .map_err(|error| format!("TickTick create request failed: {error}"))?;

    if response.status() >= 400 {
        return Err(format!("TickTick create failed with status {}", response.status()));
    }
    Ok(json!(true))
}

/// The `+HHMM` offset at `date`'s local midnight, so an all-day task keeps its calendar day on
/// either side of UTC. A hard-coded `+0000` would write 00:00 UTC, which is the previous day west
/// of UTC once the provider turns the instant back into local time.
fn local_offset(date: NaiveDate) -> String {
    let offset = Local
        .from_local_datetime(&date.and_time(NaiveTime::MIN))
        .single()
        .map(|dt| dt.offset().fix())
        .unwrap_or_else(|| Local::now().offset().fix());
    let seconds = offset.local_minus_utc();
    let sign = if seconds < 0 { '-' } else { '+' };
    let minutes = seconds.unsigned_abs() / 60;
    format!("{sign}{:02}{:02}", minutes / 60, minutes % 60)
}

/// The `dueDate` string for a new all-day task due on `date`.
pub(crate) fn all_day_due(date: NaiveDate) -> String {
    format!("{date}T00:00:00{}", local_offset(date))
}
