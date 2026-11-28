// The plugin's wiring: SDK lifecycle, poll and action callbacks. The work lives beside it:
// `model` (task rows and provider fields), `api` (TickTick calls), `sessions` (published rows),
// `poll` (reconciling vanished rows) and `actions` (action ids and what they do).

mod actions;
mod api;
mod model;
mod poll;
mod sessions;

use fly_island_plugin_sdk::{empty, publish, run};
use model::PluginState;
use std::cell::RefCell;
use std::rc::Rc;
use std::time::Duration;

fn main() {
    let state = Rc::new(RefCell::new(PluginState::default()));
    let poll_state = Rc::clone(&state);
    if run(Duration::from_secs(180), move |settings| {
        let token = settings["token"].as_str().map(str::trim).filter(|value| !value.is_empty());
        let Some(token) = token else {
            poll_state.borrow_mut().host_failed_lists = false;
            return Ok(empty());
        };
        let mut state = poll_state.borrow_mut();
        // Reserved host capability; absent on older hosts, which reject the publish field.
        state.host_failed_lists = settings["_host-failed-task-lists"] == true;
        poll::poll_ticktick(&api::Api::new(token), &mut state)
    }, move |action_id, settings| {
        let Some(token) = settings["token"].as_str().map(str::trim).filter(|value| !value.is_empty()) else {
            return Err("TickTick API token is missing".to_owned());
        };
        state.borrow_mut().host_failed_lists = settings["_host-failed-task-lists"] == true;
        actions::handle(action_id, &api::Api::new(token), &state, |snapshot| {
            let _ = publish(snapshot);
        })
    }).is_err() {
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests;
