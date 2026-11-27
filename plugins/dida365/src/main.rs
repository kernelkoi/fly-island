// The plugin's wiring: SDK lifecycle, poll and action callbacks. The work lives beside it:
// `model` (task rows and provider fields), `api` (TickTick calls), `sessions` (published rows),
// `poll` (reconciling vanished rows) and `actions` (action ids and what they do).

mod actions;
mod api;
mod model;
mod poll;
mod sessions;

use fly_island_plugin_sdk::{empty, run};
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
            return Ok(empty());
        };
        let mut state = poll_state.borrow_mut();
        let snapshot = poll::poll_ticktick(token, &mut state)?;
        state.last = Some(snapshot.clone());
        Ok(snapshot)
    }, move |action_id, settings| {
        let Some(token) = settings["token"].as_str().map(str::trim).filter(|value| !value.is_empty()) else {
            return Err("TickTick API token is missing".to_owned());
        };
        actions::handle(action_id, token, &state)
    }).is_err() {
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests;
