use chrono::{DateTime, Local, NaiveDate, TimeZone};
use fly_island_plugin_sdk::{empty, json, publish, run, stale, task as task_row, Value};
use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::rc::Rc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const API_BASE: &str = "https://api.dida365.com/open/v1";
/// The host rejects a publish above 200 rows; the done group only uses what the open rows leave.
const ROW_CAP: usize = 200;
/// How many vanished rows one poll may verify: each check is one request, so a bulk delete of a
/// whole list does not burst past the API's rate limit.
const CHECK_LIMIT: usize = 20;
/// Today's done group is a convenience, not an archive.
const DONE_CAP: usize = 50;
/// How many polls a vanished row may fail its single-task lookup before the plugin stops asking.
/// A provider that keeps failing would otherwise hold a slot in the check budget forever.
const VERIFY_RETRIES: u8 = 3;

#[derive(Clone, Debug)]
struct TaskEntry {
    id: String,
    project_id: String,
    project_name: String,
    title: String,
    due_date: Option<NaiveDate>,
    modified_at: i64,
    repeat_flag: bool,
    /// The provider's own importance: 0 none, 1 low, 3 medium, 5 high.
    priority: i64,
    /// Set when the provider itself reports the task as done (the list endpoint normally hides
    /// those rows, so this is the rare case where `/data` hands us one anyway).
    completed_at: Option<i64>,
}

/// A task the provider confirmed as completed today. The row keeps what it needs to be drawn
/// after the task stops appearing in the open list.
#[derive(Clone, Debug)]
struct DoneEntry {
    /// "project:task", the id the open row used, so the UI unmounts one and mounts the other.
    key: String,
    project_id: String,
    task_id: String,
    project_name: String,
    title: String,
    due_date: Option<NaiveDate>,
    repeat_flag: bool,
    priority: i64,
    completed_at: i64,
}

impl DoneEntry {
    fn from_task(task: &TaskEntry, completed_at: i64) -> Self {
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
struct PluginState {
    last_open: HashMap<String, TaskEntry>,
    done: Vec<DoneEntry>,
    /// Failed lookups per vanished row, dropped once the row settles or `VERIFY_RETRIES` is hit.
    verify_misses: HashMap<String, u8>,
    /// Keys of the open rows in the last published snapshot. `last_open` also holds vanished rows
    /// still waiting for a reply, which must not come back to the page when an action republishes.
    published: HashSet<String>,
    /// The last payload published, so a failed refresh still has something true to show.
    last: Option<Value>,
}

fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn local_date_of(millis: i64) -> Option<NaiveDate> {
    Local.timestamp_millis_opt(millis).single().map(|dt| dt.date_naive())
}

/// 滴答 API 的时间字段可能是毫秒数或带时区的 ISO 字符串，统一成 Unix 毫秒。
fn parse_epoch_millis(value: &Value) -> Option<i64> {
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

fn parse_local_due_date(raw: &str) -> Option<NaiveDate> {
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

fn task_bucket_for_due(due_date: Option<NaiveDate>, repeat_flag: bool) -> &'static str {
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

fn parse_repeat_flag(task: &Value) -> bool {
    task["repeatFlag"].as_bool().unwrap_or(false)
        || task["repeatFlag"].as_i64().is_some_and(|v| v != 0)
        || task["repeatFlag"].as_str().is_some_and(|v| !v.trim().is_empty() && v != "0")
}

fn project_token_header(token: &str) -> String {
    format!("Bearer {token}")
}

fn pretty_task_title(task: &Value) -> String {
    task["title"].as_str().or_else(|| task["content"].as_str()).unwrap_or("Untitled task").to_owned()
}

/// The list a row shows, if it has one. The inbox is a pseudo list the UI names in the user's
/// language, so its rows go nameless; an unnamed list falls back to the app name.
fn list_name(project_id: &str, project_name: &str) -> Option<String> {
    if project_id == "inbox" {
        None
    } else if project_name.trim().is_empty() {
        Some("TickTick".to_owned())
    } else {
        Some(project_name.to_owned())
    }
}

fn fetch_projects(token: &str) -> Result<Vec<Value>, String> {
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

/// One task row's worth of data, or `None` for notes, nameless tasks and other non-tasks.
fn entry_from_task(task: &Value, project_id: &str, project_name: &str) -> Option<TaskEntry> {
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
fn parse_priority(task: &Value) -> i64 {
    match task["priority"].as_i64() {
        Some(1) => 1,
        Some(3) => 3,
        Some(5) => 5,
        _ => 0,
    }
}

fn fetch_project_tasks(token: &str, project_id: &str, project_name: &str) -> Result<Vec<TaskEntry>, String> {
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
fn fetch_task(token: &str, project_id: &str, task_id: &str) -> Result<Option<Value>, String> {
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

fn build_sessions(tasks: &[TaskEntry], cap: usize) -> Vec<Value> {
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
        let status = if matches!(task_bucket_for_due(task.due_date, task.repeat_flag), "overdue") {
            "waiting"
        } else {
            "running"
        };
        // A repeated task's past anchor means it belongs on today, not on its anchor day.
        // The due wording is the UI's job (in the user's language), so no detail line here.
        let calendar_due = task.due_date.map(|due| if task.repeat_flag && due < today { today } else { due });
        sessions.push(task_row(
            &format!("{}:{}", task.project_id, task.id),
            &task.title,
            list_name(&task.project_id, &task.project_name).as_deref(),
            status,
            task.modified_at,
            Some(action_id.as_str()),
            None,
            calendar_due.map(|due| due.to_string()).as_deref(),
            Some(task.project_id.as_str()),
            task.repeat_flag,
            Some(task.priority),
        ));
    }
    sessions
}

/// A done row: same shape as an open one, but its check undoes the completion instead.
fn done_row(entry: &DoneEntry) -> Value {
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
    )
}

/// The done group only uses the space the open rows leave: seeing what is still to do matters
/// more than reviewing what is finished.
fn append_done(sessions: &mut Vec<Value>, done: &[DoneEntry]) {
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
fn snapshot_from_memory(state: &PluginState) -> Value {
    let done_keys: HashSet<&str> = state.done.iter().map(|entry| entry.key.as_str()).collect();
    let open: Vec<TaskEntry> = state
        .last_open
        .iter()
        .filter(|(key, _)| state.published.contains(*key) && !done_keys.contains(key.as_str()))
        .map(|(_, entry)| entry.clone())
        .collect();
    let mut sessions = build_sessions(&open, ROW_CAP);
    append_done(&mut sessions, &state.done);
    if sessions.is_empty() {
        return json!({ "composer": true });
    }
    json!({ "sessions": sessions, "composer": true })
}

fn complete_task(token: &str, project_id: &str, task_id: &str) -> Result<Value, String> {
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
fn reopen_task(token: &str, project_id: &str, task_id: &str) -> Result<Value, String> {
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

/// `create.<YYYY-MM-DD>.<title>`: the title may contain dots, so split only after the date.
/// `create.<date>.<title>` uses the plugin's default inbox; `create.<date>.list:<id>.<title>`
/// names a list from the published session's `listId`.
fn parse_create_action(action_id: &str) -> Option<(NaiveDate, Option<&str>, &str)> {
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
fn parse_id_action<'a>(action_id: &'a str, prefix: &str) -> Option<(&'a str, &'a str)> {
    let payload = action_id.strip_prefix(prefix)?;
    let (project_id, task_id) = payload.split_once('.')?;
    if project_id.is_empty() || task_id.is_empty() || project_id.len() > 4096 || task_id.len() > 4096 {
        return None;
    }
    Some((project_id, task_id))
}

/// Quick add goes to the inbox unless a list id is supplied.
fn create_task(token: &str, date: NaiveDate, title: &str, project_id: Option<&str>) -> Result<Value, String> {
    let mut body = json!({
        "title": title,
        "dueDate": format!("{}T00:00:00+0000", date),
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

/// What a single-task lookup says about a vanished row.
enum Verified {
    /// Finished today: the done group takes it, with the provider's completion time.
    Completed(i64),
    /// The provider still calls it open. The open list and the single-task endpoint can briefly
    /// disagree, so the caller retries a few rounds instead of losing the completion.
    StillOpen,
    /// Finished on another day: not news for today's group.
    NotToday,
}

/// Only `status` says whether the task is done; `completedTime` survives an undo and cannot stand
/// in for it.
fn verified_task(task: &Value, today: NaiveDate) -> Verified {
    let completed_at = parse_epoch_millis(&task["completedTime"])
        .or_else(|| parse_epoch_millis(&task["modifiedTime"]))
        .unwrap_or_else(now_millis);
    if task["status"].as_i64().unwrap_or(0) == 0 {
        return Verified::StillOpen;
    }
    if local_date_of(completed_at) != Some(today) {
        return Verified::NotToday;
    }
    Verified::Completed(completed_at)
}

fn poll_ticktick(token: &str, state: &mut PluginState) -> Result<Value, String> {
    let mut projects = fetch_projects(token)?;
    // The project list usually omits the inbox, but its special id still exposes its data.
    // The name stays empty: the UI labels the inbox itself, in the user's language.
    if !projects.iter().any(|project| project["id"] == "inbox") {
        projects.push(json!({"id": "inbox", "name": "", "kind": "TASK"}));
    }
    let today = Local::now().date_naive();
    let mut open = Vec::new();
    let mut reported_done = Vec::new();

    for project in projects {
        let project_id = project["id"].as_str().unwrap_or_default();
        if project_id.is_empty() {
            continue;
        }
        if project["kind"].as_str().is_some_and(|kind| !kind.eq_ignore_ascii_case("task")) {
            continue;
        }
        let project_name = project["name"].as_str().unwrap_or("TickTick").to_owned();
        for entry in fetch_project_tasks(token, project_id, &project_name).unwrap_or_default() {
            match entry.completed_at {
                Some(at) => reported_done.push((entry, at)),
                None => open.push(entry),
            }
        }
    }

    let open_keys: HashSet<String> = open.iter().map(|entry| format!("{}:{}", entry.project_id, entry.id)).collect();
    state.published = open_keys.clone();
    // A row that vanished from the open list either completed or was deleted, and only the
    // provider can say which. Verifying a few of them per poll keeps a bulk delete from turning
    // into a burst of requests. The ones not checked yet stay in `last_open`, so a bulk
    // completion is confirmed over the next rounds instead of being lost. A 404/410 settles the
    // row as gone and a transport error retries a few times, so no row holds a check slot forever.
    let vanished: Vec<String> = state.last_open.keys().filter(|key| !open_keys.contains(*key)).cloned().collect();
    let mut unchecked: Vec<String> = Vec::new();
    for key in vanished.iter().take(CHECK_LIMIT) {
        if state.done.iter().any(|entry| &entry.key == key) {
            continue;
        }
        let Some(known) = state.last_open.get(key) else {
            continue;
        };
        let task = match fetch_task(token, &known.project_id, &known.id) {
            // Deleted or moved elsewhere: nothing left to verify. Leaving the key out of the
            // rebuilt `last_open` forgets the row for good instead of asking every round.
            Ok(None) => continue,
            Ok(Some(task)) => task,
            Err(_) => {
                // A transport error says nothing about the task itself: retry, but not forever.
                let misses = state.verify_misses.entry(key.clone()).or_insert(0);
                *misses = misses.saturating_add(1);
                if *misses < VERIFY_RETRIES {
                    unchecked.push(key.clone());
                }
                continue;
            }
        };
        match verified_task(&task, today) {
            Verified::Completed(completed_at) => state.done.push(DoneEntry::from_task(known, completed_at)),
            // The list hid the row but the provider still calls it open: the two may simply be
            // catching up. Retry a few rounds before forgetting it, so a completion is not lost.
            Verified::StillOpen => {
                let misses = state.verify_misses.entry(key.clone()).or_insert(0);
                *misses = misses.saturating_add(1);
                if *misses < VERIFY_RETRIES {
                    unchecked.push(key.clone());
                }
            }
            Verified::NotToday => {}
        }
    }
    // The rows this round had no time to check, plus the ones whose check failed: they stay
    // listed as they were until a later round can say whether they completed.
    let pending: HashSet<&String> = vanished.iter().skip(CHECK_LIMIT).chain(unchecked.iter()).collect();
    let still_open: Vec<&String> = vanished
        .iter()
        .filter(|key| pending.contains(*key) && !state.done.iter().any(|done| &done.key == *key))
        .collect();
    for (entry, at) in reported_done {
        if local_date_of(at) != Some(today) {
            continue;
        }
        let key = format!("{}:{}", entry.project_id, entry.id);
        if !state.done.iter().any(|known| known.key == key) {
            state.done.push(DoneEntry::from_task(&entry, at));
        }
    }
    // Open again means it was reopened elsewhere; another day's completion is no longer news.
    state.done.retain(|entry| !open_keys.contains(&entry.key) && local_date_of(entry.completed_at) == Some(today));
    state.done.sort_by_key(|entry| std::cmp::Reverse(entry.completed_at));
    state.done.truncate(DONE_CAP);
    // The open rows, plus the vanished ones still waiting for their check, so a bulk completion is
    // confirmed over the next rounds instead of being forgotten.
    let previous = state.last_open.clone();
    state.last_open = open.iter().map(|entry| (format!("{}:{}", entry.project_id, entry.id), entry.clone())).collect();
    for &key in &still_open {
        if let Some(entry) = previous.get(key) {
            state.last_open.insert(key.clone(), entry.clone());
        }
    }
    // Retry counts belong only to rows still waiting for a verdict; a settled or forgotten row
    // takes its count with it.
    let waiting: HashSet<String> = state.last_open.keys().cloned().collect();
    state.verify_misses.retain(|key, _| waiting.contains(key));

    Ok(snapshot_from_memory(state))
}

/// Republish what memory already knows, so a click does not wait on the provider's whole list.
fn republish(state: &mut PluginState) {
    let snapshot = snapshot_from_memory(state);
    state.last = Some(snapshot.clone());
    let _ = publish(snapshot);
}

/// A full refresh for an action whose effect memory cannot show (quick add, or a row this process
/// never saw). The action itself already reached the provider, so a refresh that fails here
/// republishes the previous snapshot marked stale rather than a wrong or empty page.
fn refresh(token: &str, state: &mut PluginState) {
    let snapshot = match poll_ticktick(token, state) {
        Ok(snapshot) => snapshot,
        Err(_) => stale(state.last.clone().unwrap_or_else(empty)),
    };
    state.last = Some(snapshot.clone());
    let _ = publish(snapshot);
}

/// Refresh one list after a quick add: the new row needs the id the provider assigned, but the
/// other lists have not changed. Rows missing from the reply stay on the page until the next full
/// poll reconciles them, and a failed fetch leaves the page as it was (the task exists either way).
fn refresh_list(token: &str, state: &mut PluginState, project_id: &str) {
    let name = if project_id == "inbox" {
        String::new()
    } else if let Some(entry) = state.last_open.values().find(|entry| entry.project_id == project_id) {
        entry.project_name.clone()
    } else {
        let Ok(projects) = fetch_projects(token) else { return };
        let Some(project) = projects.iter().find(|project| project["id"] == project_id) else { return };
        project["name"].as_str().unwrap_or_default().to_owned()
    };
    let Ok(entries) = fetch_project_tasks(token, project_id, &name) else { return };
    for entry in entries {
        // A row the provider reports as done belongs to the done group, which the next full poll
        // fills; drawing it as open here would offer a check that completes it twice.
        if entry.completed_at.is_some() {
            continue;
        }
        let key = format!("{}:{}", entry.project_id, entry.id);
        state.last_open.insert(key.clone(), entry);
        state.published.insert(key);
    }
    republish(state);
}

fn main() {
    let state = Rc::new(RefCell::new(PluginState::default()));
    let poll_state = Rc::clone(&state);
    if run(Duration::from_secs(180), move |settings| {
        let token = settings["token"].as_str().map(str::trim).filter(|value| !value.is_empty());
        let Some(token) = token else {
            return Ok(empty());
        };
        let mut state = poll_state.borrow_mut();
        let snapshot = poll_ticktick(token, &mut state)?;
        state.last = Some(snapshot.clone());
        Ok(snapshot)
    }, move |action_id, settings| {
        let Some(token) = settings["token"].as_str().map(str::trim).filter(|value| !value.is_empty()) else {
            return Err("TickTick API token is missing".to_owned());
        };
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
    }).is_err() {
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests;
