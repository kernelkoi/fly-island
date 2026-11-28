// A poll: fetch every list, reconcile what vanished, and publish a fresh snapshot.

use chrono::{Local, NaiveDate};
use fly_island_plugin_sdk::{json, Value};
use std::collections::HashSet;
use crate::api::{fetch_project_tasks, fetch_projects, fetch_task, Api};
use crate::model::{local_date_of, now_millis, parse_epoch_millis, DoneEntry, PluginState};
use crate::sessions::{snapshot_from_memory, DONE_CAP};

/// How many vanished rows one poll may verify: each check is one request, so a bulk delete of a
/// whole list does not burst past the API's rate limit.
const CHECK_LIMIT: usize = 20;
/// How many polls a vanished row may fail its single-task lookup before the plugin stops asking.
/// A provider that keeps failing would otherwise hold a slot in the check budget forever.
const VERIFY_RETRIES: u8 = 3;

/// What a single-task lookup says about a vanished row.
pub(crate) enum Verified {
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
pub(crate) fn verified_task(task: &Value, today: NaiveDate) -> Verified {
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

pub(crate) fn poll_ticktick(api: &Api<'_>, state: &mut PluginState) -> Result<Value, String> {
    let mut projects = fetch_projects(api)?;
    // The project list usually omits the inbox, but its special id still exposes its data.
    // The name stays empty: the UI labels the inbox itself, in the user's language.
    if !projects.iter().any(|project| project["id"] == "inbox") {
        projects.push(json!({"id": "inbox", "name": "", "kind": "TASK"}));
    }
    let today = Local::now().date_naive();
    // One request per list, each up to 10s: fetched in small parallel windows instead of one long
    // serial line, so a poll with many lists cannot stall the plugin on a slow list.
    const FETCH_CONCURRENCY: usize = 8;
    let lists: Vec<(String, String)> = projects
        .into_iter()
        .filter(|project| {
            let id = project["id"].as_str().unwrap_or_default();
            !id.is_empty() && !project["kind"].as_str().is_some_and(|kind| !kind.eq_ignore_ascii_case("task"))
        })
        .map(|project| {
            let id = project["id"].as_str().unwrap_or_default().to_owned();
            let name = project["name"].as_str().unwrap_or("TickTick").to_owned();
            (id, name)
        })
        .collect();
    let mut open = Vec::new();
    let mut reported_done = Vec::new();
    let mut failed_lists: HashSet<String> = HashSet::new();
    let mut any_list_succeeded = false;
    for chunk in lists.chunks(FETCH_CONCURRENCY) {
        std::thread::scope(|scope| {
            let handles: Vec<_> = chunk.iter().map(|(id, name)| {
                (id.as_str(), scope.spawn(move || fetch_project_tasks(api, id, name)))
            }).collect();
            for (id, handle) in handles {
                let Ok(Ok(entries)) = handle.join() else {
                    failed_lists.insert(id.to_owned());
                    continue;
                };
                any_list_succeeded = true;
                for entry in entries {
                    match entry.completed_at {
                        Some(at) => reported_done.push((entry, at)),
                        None => open.push(entry),
                    }
                }
            }
        });
    }
    if !any_list_succeeded {
        return Err("TickTick task lists unavailable".to_owned());
    }

    let open_keys: HashSet<String> = open.iter().map(|entry| format!("{}:{}", entry.project_id, entry.id)).collect();
    // A failed list gives no evidence that its rows vanished. Keep its published rows and
    // pending lookups, including edits that were just confirmed by a POST.
    state.published.retain(|key| state.last_open.get(key)
        .is_some_and(|entry| failed_lists.contains(entry.project_id.as_str())));
    state.published.extend(open_keys.iter().cloned());
    // A row that vanished from the open list either completed or was deleted, and only the
    // provider can say which. Verifying a few of them per poll keeps a bulk delete from turning
    // into a burst of requests. The ones not checked yet stay in `last_open`, so a bulk
    // completion is confirmed over the next rounds instead of being lost. A 404/410 settles the
    // row as gone and a transport error retries a few times, so no row holds a check slot forever.
    let vanished: Vec<String> = state.last_open.iter()
        .filter(|(key, entry)| !open_keys.contains(*key) && !failed_lists.contains(entry.project_id.as_str()))
        .map(|(key, _)| key.clone())
        .collect();
    let mut unchecked: Vec<String> = Vec::new();
    for key in vanished.iter().take(CHECK_LIMIT) {
        if state.done.iter().any(|entry| &entry.key == key) {
            continue;
        }
        let Some(known) = state.last_open.get(key) else {
            continue;
        };
        let task = match fetch_task(api, &known.project_id, &known.id) {
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
    state.last_open.retain(|key, entry| {
        failed_lists.contains(entry.project_id.as_str())
            || (pending.contains(key) && !state.done.iter().any(|done| &done.key == key))
    });
    state.last_open.extend(open.into_iter().map(|entry| (format!("{}:{}", entry.project_id, entry.id), entry)));
    // Retry counts belong only to rows still waiting for a verdict; a settled or forgotten row
    // takes its count with it.
    let waiting: HashSet<String> = state.last_open.keys().cloned().collect();
    state.verify_misses.retain(|key, _| waiting.contains(key));
    // The host keeps the rows it last showed for these lists: a process restarted after a crash
    // has no memory of them, and only the host still has them.
    state.failed_lists = failed_lists;

    Ok(snapshot_from_memory(state))
}
