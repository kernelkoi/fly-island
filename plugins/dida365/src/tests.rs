use crate::actions::{parse_create_action, parse_id_action};
use crate::api::all_day_due;
use crate::model::{
    entry_from_task, now_millis, parse_epoch_millis, parse_local_due_date, parse_priority,
    task_bucket_for_due, DoneEntry, PluginState, TaskEntry,
};
use crate::poll::{verified_task, Verified};
use crate::sessions::{append_done, build_sessions, done_row, snapshot_from_memory, ROW_CAP};
use chrono::{Duration, Local, NaiveDate};
use fly_island_plugin_sdk::json;

fn open_task(id: &str, title: &str, due: Option<NaiveDate>, modified_at: i64) -> TaskEntry {
    TaskEntry {
        id: id.into(),
        project_id: "p1".into(),
        project_name: "计划".into(),
        title: title.into(),
        due_date: due,
        modified_at,
        repeat_flag: false,
        completed_at: None,
        priority: 0,
    }
}

fn done_entry(key: &str, title: &str, completed_at: i64) -> DoneEntry {
    DoneEntry {
        key: key.into(),
        project_id: "p1".into(),
        task_id: key.split(':').nth(1).unwrap_or(key).into(),
        project_name: "计划".into(),
        title: title.into(),
        due_date: None,
        repeat_flag: false,
        completed_at,
        priority: 0,
    }
}

#[test]
fn parse_due_date_maps_same_instant_to_same_local_day() {
    // 15:00+00:00 与 16:00+01:00 是同一时刻，无论机器时区如何都应落在同一天。
    let left = parse_local_due_date("2026-11-08T15:00:00.000+0000").unwrap();
    let right = parse_local_due_date("2026-11-08T16:00:00+0100").unwrap();
    assert_eq!(left, right);
    assert_eq!(
        parse_local_due_date("2026-11-09"),
        NaiveDate::from_ymd_opt(2026, 11, 9)
    );
    assert_eq!(parse_local_due_date(""), None);
}

#[test]
fn repeated_past_due_task_is_treated_as_today() {
    let today = Local::now().date_naive();
    let yday = (today - Duration::days(2)).to_string();
    let due = parse_local_due_date(&format!("{yday}T00:00:00+0000")).unwrap();
    assert_eq!(task_bucket_for_due(Some(due), true), "today");
}

#[test]
fn task_rows_carry_the_calendar_day_and_repeat_anchors_move_to_today() {
    let today = Local::now().date_naive();
    let yesterday = today - Duration::days(1);
    let mut repeated = open_task("t1", "重复任务", Some(yesterday), 1);
    repeated.repeat_flag = true;
    let tasks = vec![repeated, open_task("t2", "逾期任务", Some(yesterday), 2)];
    let sessions = build_sessions(&tasks, ROW_CAP);
    // 重复任务的旧锚点属于今天；普通逾期任务仍留在原日期，供日历显示逾期。
    let repeated = sessions.iter().find(|session| session["title"] == "重复任务").unwrap();
    let overdue = sessions.iter().find(|session| session["title"] == "逾期任务").unwrap();
    assert_eq!(repeated["due"], today.to_string());
    assert_eq!(overdue["due"], yesterday.to_string());
    // 到期措辞归前端所有：插件只发 repeat 标志，不发 detail 文案。
    assert_eq!(repeated["repeat"], json!(true));
    assert_eq!(overdue["repeat"], json!(false));
    assert_eq!(repeated["detail"], json!(null));
    // The calendar group is explicit; an open row never borrows the agent's status words.
    assert_eq!(repeated["bucket"], json!("today"));
    assert_eq!(overdue["bucket"], json!("overdue"));
    assert_eq!(repeated["status"], json!("running"));
    assert_eq!(overdue["status"], json!("running"));
    let someday = &build_sessions(&[open_task("t3", "以后", None, 3)], ROW_CAP)[0];
    assert_eq!(someday["bucket"], json!("future"));
    assert_eq!(someday["due"], json!(null));
}

#[test]
fn inbox_rows_carry_the_inbox_list_id_but_no_list_name() {
    let today = Local::now().date_naive();
    let mut inbox = open_task("t1", "收件箱任务", Some(today), 1);
    inbox.project_id = "inbox".into();
    inbox.project_name = String::new();
    let session = &build_sessions(&[inbox], ROW_CAP)[0];
    // 前端凭 listId 识别收集箱并用自己的文案命名；清单名留空，避免把某种语言写死进插件。
    assert_eq!(session["listId"], json!("inbox"));
    assert_eq!(session["cwd"], json!(null));
}

#[test]
fn sessions_stop_at_the_hosts_two_hundred_row_cap() {
    let today = Local::now().date_naive();
    let tasks: Vec<TaskEntry> = (0..250)
        .map(|index| open_task(&format!("t{index}"), &format!("任务{index}"), Some(today), index as i64))
        .collect();
    assert_eq!(build_sessions(&tasks, ROW_CAP).len(), 200);
}

#[test]
fn create_action_keeps_dots_in_the_title_and_rejects_bad_dates() {
    let (date, project_id, title) = parse_create_action("create.2026-11-17.买牛奶.两瓶").unwrap();
    assert_eq!(date, NaiveDate::from_ymd_opt(2026, 11, 17).unwrap());
    assert_eq!(project_id, None);
    assert_eq!(title, "买牛奶.两瓶");
    let (_, project_id, title) = parse_create_action("create.2026-11-17.list:p1.写周报.下午").unwrap();
    assert_eq!(project_id, Some("p1"));
    assert_eq!(title, "写周报.下午");
    assert_eq!(parse_create_action("create.2026-11-17.list:.bad"), None);
    assert_eq!(parse_create_action("create.2026-13-17.bad"), None);
    assert_eq!(parse_create_action("create.2026-11-17."), None);
    assert_eq!(parse_create_action("complete.p1.t1"), None);
    // The 200 cap counts characters, not bytes: 200 CJK characters pass, one more fails.
    assert!(parse_create_action(&format!("create.2026-11-17.{}", "测".repeat(200))).is_some());
    assert_eq!(parse_create_action(&format!("create.2026-11-17.{}", "测".repeat(201))), None);
}

#[test]
fn all_day_due_round_trips_to_the_same_local_date() {
    let date = NaiveDate::from_ymd_opt(2026, 11, 20).unwrap();
    let due = all_day_due(date);
    assert_eq!(parse_local_due_date(&due), Some(date));
    // 偏移必须是本机时区的 ±HHMM，而不是写死 +0000。
    let tail = due.split_once("T00:00:00").unwrap().1;
    assert_eq!(tail.len(), 5);
    assert!(tail.starts_with('+') || tail.starts_with('-'));
    assert!(tail[1..].bytes().all(|byte| byte.is_ascii_digit()));
}

#[test]
fn only_tasks_the_provider_reports_as_done_get_a_completion_time() {
    // `status != 0` 即已完成；列表接口通常不返回这类行，但真返回时不能让它们消失。
    let completed = json!({
        "id": "t1",
        "title": "做完的活",
        "status": 2,
        "completedTime": "2026-11-18T04:09:39.614+0000",
    });
    let entry = entry_from_task(&completed, "p1", "计划").unwrap();
    assert_eq!(entry.completed_at, parse_epoch_millis(&completed["completedTime"]));

    let open = json!({"id": "t2", "title": "没做的活", "status": 0, "modifiedTime": "2026-11-18T04:09:39.614+0000"});
    assert_eq!(entry_from_task(&open, "p1", "计划").unwrap().completed_at, None);
}

#[test]
fn a_verified_lookup_counts_only_a_completion_the_provider_reports_for_today() {
    let today = Local::now().date_naive();
    let now = now_millis();
    let done = json!({"id": "t1", "status": 2, "completedTime": now});
    assert!(matches!(verified_task(&done, today), Verified::Completed(at) if at == now));
    // completedTime 在撤销后可能残留旧值：status 0 就是没完成，但列表与单条接口可能短暂不一致，
    // 所以保留重试而不是直接丢掉。
    let open = json!({"id": "t2", "status": 0, "completedTime": now});
    assert!(matches!(verified_task(&open, today), Verified::StillOpen));
    // 昨天完成的，不进今天的已完成分组。
    let yesterday = now - 24 * 60 * 60 * 1000;
    let old = json!({"id": "t3", "status": 2, "completedTime": yesterday});
    assert!(matches!(verified_task(&old, today), Verified::NotToday));
}

#[test]
fn done_rows_follow_the_open_rows_and_undo_instead_of_completing() {
    let mut sessions = build_sessions(&[open_task("t1", "没做的活", None, 1)], ROW_CAP);
    append_done(&mut sessions, &[done_entry("p1:t9", "刚做完的活", 1_700_000_000_000)]);
    assert_eq!(sessions.len(), 2);
    assert_eq!(sessions[0]["id"], json!("p1:t1"));
    let done = &sessions[1];
    assert_eq!(done["id"], json!("p1:t9"));
    assert_eq!(done["status"], json!("completed"));
    // 已完成行的勾选框是撤销，不是再次完成。
    assert_eq!(done["action"], json!("reopen.p1.t9"));
}

#[test]
fn the_done_group_only_uses_what_the_open_rows_leave() {
    // 200 条未完成任务已经用满额度时，已完成行不应把待办挤出去。
    let tasks: Vec<TaskEntry> = (0..200).map(|index| open_task(&format!("t{index}"), "活", None, index)).collect();
    let mut sessions = build_sessions(&tasks, ROW_CAP);
    append_done(&mut sessions, &[done_entry("p1:t9", "刚做完的活", 1)]);
    assert_eq!(sessions.len(), 200);
    assert!(!sessions.iter().any(|session| session["status"] == "completed"));
}

#[test]
fn a_snapshot_from_memory_hides_unpublished_rows_and_draws_a_completed_row_once() {
    let mut state = PluginState::default();
    state.published.insert("p1:t1".into());
    state.last_open.insert("p1:t1".into(), open_task("t1", "没做的活", None, 1));
    // 消失后还在等复核的行不在已发布快照里，不能因为一次动作重新出现。
    state.last_open.insert("p1:t2".into(), open_task("t2", "消失待复核", None, 2));
    // 刚完成的行仍留在 last_open 里，重发时只能以已完成行的形式出现一次。
    let completed = open_task("t3", "刚做完的活", None, 3);
    state.published.insert("p1:t3".into());
    state.last_open.insert("p1:t3".into(), completed.clone());
    state.done.push(DoneEntry::from_task(&completed, 1_700_000_000_000));

    let snapshot = snapshot_from_memory(&state);
    let sessions = snapshot["sessions"].as_array().unwrap();
    assert_eq!(sessions.len(), 2);
    assert!(sessions.iter().any(|session| session["id"] == json!("p1:t1")));
    assert!(!sessions.iter().any(|session| session["id"] == json!("p1:t2")));
    assert_eq!(sessions.iter().filter(|session| session["id"] == json!("p1:t3")).count(), 1);
    assert_eq!(sessions.iter().find(|session| session["id"] == json!("p1:t3")).unwrap()["status"], json!("completed"));
}

#[test]
fn only_the_providers_four_priority_levels_survive_the_round_trip() {
    // 滴答用 0 / 1 / 3 / 5 表示无 / 低 / 中 / 高；其他值一律当作「无」，不凭空造档位。
    for (raw, expected) in [(0, 0), (1, 1), (3, 3), (5, 5), (2, 0), (4, 0)] {
        let task = json!({"id": "t1", "title": "有优先级的活", "priority": raw});
        assert_eq!(parse_priority(&task), expected);
        let entry = entry_from_task(&task, "p1", "计划").unwrap();
        assert_eq!(build_sessions(&[entry], ROW_CAP)[0]["priority"], json!(expected));
    }
    // The done group carries the same level: an undone row comes back with its priority.
    let mut entry = open_task("t1", "高优先级的活", None, 1);
    entry.priority = 5;
    assert_eq!(done_row(&DoneEntry::from_task(&entry, 1))["priority"], json!(5));
}

#[test]
fn reopen_actions_split_into_a_project_and_a_task() {
    assert_eq!(parse_id_action("reopen.p1.t9", "reopen."), Some(("p1", "t9")));
    assert_eq!(parse_id_action("reopen.p1", "reopen."), None);
    assert_eq!(parse_id_action("reopen..t9", "reopen."), None);
    assert_eq!(parse_id_action("complete.p1.t9", "reopen."), None);
}
