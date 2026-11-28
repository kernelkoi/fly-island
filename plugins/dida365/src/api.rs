// The TickTick Open API calls: project and task lists, one task, and the write paths.

use chrono::{Local, NaiveDate, NaiveTime, Offset, TimeZone};
use fly_island_plugin_sdk::{json, Value};
use std::time::Duration;
use crate::model::{entry_from_task, TaskEntry};

const API_BASE: &str = "https://api.dida365.com/open/v1";

pub(crate) struct Api<'a> {
    pub(crate) base: &'a str,
    pub(crate) token: &'a str,
}

impl<'a> Api<'a> {
    pub(crate) fn new(token: &'a str) -> Self {
        Self { base: API_BASE, token }
    }

    fn token_header(&self) -> String {
        format!("Bearer {}", self.token)
    }
}

pub(crate) fn fetch_projects(api: &Api<'_>) -> Result<Vec<Value>, String> {
    let response = ureq::get(&format!("{}/project", api.base))
        .set("Authorization", &api.token_header())
        .set("Accept", "application/json")
        .timeout(Duration::from_secs(10))
        .call()
        .map_err(|error| format!("TickTick project list failed: {error}"))?;

    let payload: Value = response.into_json().map_err(|error| format!("TickTick project payload invalid: {error}"))?;
    let projects = payload.as_array().or_else(|| payload["data"].as_array())
        .ok_or("TickTick project payload is missing the projects array")?;
    Ok(projects.to_vec())
}

pub(crate) fn fetch_project_tasks(api: &Api<'_>, project_id: &str, project_name: &str) -> Result<Vec<TaskEntry>, String> {
    let response = ureq::get(&format!("{}/project/{project_id}/data", api.base))
        .set("Authorization", &api.token_header())
        .set("Accept", "application/json")
        .timeout(Duration::from_secs(10))
        .call()
        .map_err(|error| format!("TickTick tasks for project {project_id} failed: {error}"))?;

    let payload: Value = response.into_json().map_err(|error| format!("TickTick task payload invalid for {project_id}: {error}"))?;
    let tasks = payload["tasks"].as_array().or_else(|| payload["data"]["tasks"].as_array())
        .ok_or("TickTick list payload is missing the tasks array")?;

    Ok(tasks.iter().filter_map(|task| entry_from_task(task, project_id, project_name)).collect())
}

/// The one reliable source of a completed task's status and real `completedTime`. `Ok(None)` means
/// the provider no longer knows the task (deleted, or moved to another list): there is nothing left
/// to verify, so the caller forgets the row instead of asking about it on every poll.
pub(crate) fn fetch_task(api: &Api<'_>, project_id: &str, task_id: &str) -> Result<Option<Value>, String> {
    let response = match ureq::get(&format!("{}/project/{project_id}/task/{task_id}", api.base))
        .set("Authorization", &api.token_header())
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

fn post_write(api: &Api<'_>, path: &str, body: &Value, action: &str) -> Result<ureq::Response, String> {
    // ureq 2 retries a sent request only for idempotent methods. A fresh agent also avoids
    // the early header-write retry on pooled sockets, and redirects cannot confirm a write.
    let result = ureq::AgentBuilder::new().redirects(0).build()
        .post(&format!("{}{path}", api.base))
        .set("Authorization", &api.token_header())
        .set("Accept", "application/json")
        .set("Content-Type", "application/json")
        .timeout(Duration::from_secs(10))
        .send_string(&body.to_string());
    match result {
        Ok(response) if (200..300).contains(&response.status()) => Ok(response),
        Err(ureq::Error::Status(status @ 400..=499, _)) if status != 408 => {
            Err(format!("TickTick {action} failed with status {status}"))
        }
        // A timeout, lost response or upstream failure can follow a committed write.
        _ => Err("plugin_action_unconfirmed".to_owned()),
    }
}

pub(crate) fn complete_task(api: &Api<'_>, project_id: &str, task_id: &str) -> Result<(), String> {
    let path = format!("/project/{project_id}/task/{task_id}/complete");
    post_write(api, &path, &json!({}), "completion")?;
    Ok(())
}

/// Undo a completion. The update endpoint needs the task's own id in the body as well as the
/// project, otherwise it answers 404 and nothing changes.
pub(crate) fn reopen_task(api: &Api<'_>, project_id: &str, task_id: &str) -> Result<(), String> {
    let body = json!({"id": task_id, "projectId": project_id, "status": 0});
    post_write(api, &format!("/task/{task_id}"), &body, "reopen")?;
    Ok(())
}

/// Quick add goes to the inbox unless a list id is supplied.
pub(crate) fn create_task(api: &Api<'_>, date: NaiveDate, title: &str, project_id: Option<&str>) -> Result<Option<Value>, String> {
    let mut body = json!({
        "title": title,
        "dueDate": all_day_due(date),
        "isAllDay": true,
    });
    if let Some(project_id) = project_id {
        body["projectId"] = json!(project_id);
    }
    let response = post_write(api, "/task", &body, "create")?;
    // A successful status confirms the write even if the optional task body cannot be read.
    Ok(response.into_json().ok())
}

/// Change the due day, preserving the provider's other task fields. `startDate` is cleared so an
/// old start day cannot keep the task on its previous calendar position. `None` removes both.
pub(crate) fn update_due_date(api: &Api<'_>, project_id: &str, task_id: &str, date: Option<NaiveDate>) -> Result<(), String> {
    let due_date = date.map(all_day_due);
    let body = json!({"id": task_id, "projectId": project_id, "isAllDay": true, "dueDate": due_date, "startDate": Value::Null});
    post_write(api, &format!("/task/{task_id}"), &body, "due date update")?;
    Ok(())
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
