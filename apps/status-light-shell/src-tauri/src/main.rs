#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod status_runtime;

use status_runtime::{
    codex_log_path, read_status_snapshot as read_live_status_snapshot, write_snapshot_file,
    StatusSnapshot,
};
use std::{
    env,
    path::Path,
    process::Command,
    sync::{Arc, Mutex},
    thread,
    time::{Duration, Instant},
};
use tauri::{
    image::Image,
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, WindowEvent, Wry,
};

#[derive(Clone, Default)]
struct SnapshotStore {
    current: Arc<Mutex<Option<StatusSnapshot>>>,
}

impl SnapshotStore {
    fn read(&self) -> Option<StatusSnapshot> {
        self.current.lock().ok().and_then(|snapshot| snapshot.clone())
    }

    fn write(&self, snapshot: StatusSnapshot) {
        if let Ok(mut current) = self.current.lock() {
            *current = Some(snapshot);
        }
    }
}

fn push_snapshot_to_window(app: &AppHandle<Wry>, snapshot: &StatusSnapshot) -> Result<(), String> {
    let payload = serde_json::to_string(snapshot)
        .map_err(|error| format!("failed to serialize live snapshot for webview: {error}"))?;
    let script = format!(
        "window.__STATUS_LIGHT_LAST_SNAPSHOT__ = {payload};\
         window.dispatchEvent(new CustomEvent('status-light:snapshot', {{ detail: {payload} }}));"
    );

    if let Some(window) = app.get_webview_window("main") {
        window
            .eval(&script)
            .map_err(|error| format!("failed to push snapshot into webview: {error}"))?;
    }

    Ok(())
}

fn open_path(path: &Path) -> Result<(), String> {
    let target = if path.exists() {
        path.to_path_buf()
    } else if let Some(parent) = path.parent() {
        parent.to_path_buf()
    } else {
        path.to_path_buf()
    };

    #[cfg(target_os = "macos")]
    let status = Command::new("open")
        .arg(&target)
        .status()
        .map_err(|error| format!("failed to launch open for {}: {error}", target.display()))?;

    #[cfg(target_os = "windows")]
    let status = Command::new("cmd")
        .args(["/C", "start", ""])
        .arg(&target)
        .status()
        .map_err(|error| format!("failed to launch start for {}: {error}", target.display()))?;

    #[cfg(all(unix, not(target_os = "macos")))]
    let status = Command::new("xdg-open")
        .arg(&target)
        .status()
        .map_err(|error| format!("failed to launch xdg-open for {}: {error}", target.display()))?;

    if status.success() {
        Ok(())
    } else {
        Err(format!("failed to open {}", target.display()))
    }
}

fn tooltip_for(snapshot: &StatusSnapshot) -> String {
    format!(
        "Codex 状态灯\n{}\n{}\n{}",
        menu_label_for(snapshot),
        state_line_for(snapshot),
        snapshot.reason
    )
}

fn menu_label_for(snapshot: &StatusSnapshot) -> String {
    format!(
        "当前状态：{} · {}",
        color_label_for(&snapshot.color),
        event_label_for(&snapshot.last_event_kind)
    )
}

fn color_label_for(color: &str) -> &str {
    match color {
        "green" => "绿灯",
        "yellow" => "黄灯",
        "red" => "红灯",
        _ => "灰灯",
    }
}

fn state_label_for(state: &str) -> &str {
    match state {
        "idle" => "就绪",
        "running" => "运行中",
        "attention" => "需处理",
        _ => "不可用",
    }
}

fn state_line_for(snapshot: &StatusSnapshot) -> String {
    format!("状态：{}", state_label_for(&snapshot.state))
}

fn event_label_for(kind: &str) -> &str {
    match kind {
        "startup" => "启动中",
        "unavailable" => "不可用",
        "cooldown" => "收尾中",
        "turn_completed" => "已完成",
        "turn_started" => "已开始",
        "thinking" => "读取中",
        "tool_running" => "工具处理中",
        "replying" => "回复中",
        "network_retry" => "重试中",
        "approval_required" => "等待授权",
        "interrupt" => "已中断",
        "auth_error" => "认证错误",
        "rate_limited" => "速率受限",
        "turn_error" => "轮次错误",
        "attention_cleared" => "已恢复",
        "stalled" => "已卡住",
        "running" => "运行中",
        _ => kind,
    }
}

#[cfg(target_os = "macos")]
fn icon_bytes_for_color(color: &str) -> &'static [u8] {
    match color {
        "green" => include_bytes!("../icons/state-macos/green.png"),
        "yellow" => include_bytes!("../icons/state-macos/yellow.png"),
        "yellow_dim" => include_bytes!("../icons/state-macos/yellow_dim.png"),
        "red" => include_bytes!("../icons/state-macos/red.png"),
        _ => include_bytes!("../icons/state-macos/neutral.png"),
    }
}

#[cfg(not(target_os = "macos"))]
fn icon_bytes_for_color(color: &str) -> &'static [u8] {
    match color {
        "green" => include_bytes!("../icons/state/green.png"),
        "yellow" => include_bytes!("../icons/state/yellow.png"),
        "yellow_dim" => include_bytes!("../icons/state/yellow_dim.png"),
        "red" => include_bytes!("../icons/state/red.png"),
        _ => include_bytes!("../icons/state/neutral.png"),
    }
}

fn tray_image_for_color(color: &str) -> Result<Image<'static>, String> {
    Image::from_bytes(icon_bytes_for_color(color))
        .map_err(|error| format!("failed to create tray icon image: {error}"))
}

const DEFAULT_ACTIVE_POLL_MS: u64 = 400;
const DEFAULT_APPROVAL_POLL_MS: u64 = 500;
const DEFAULT_IDLE_POLL_MS: u64 = 900;
const DEFAULT_UNAVAILABLE_GRACE_MS: u64 = 4_000;
const MIN_POLL_MS: u64 = 250;
const MAX_POLL_MS: u64 = 5_000;

fn poll_ms_from_env(key: &str, default_ms: u64) -> u64 {
    env::var(key)
        .ok()
        .and_then(|value| value.trim().parse::<u64>().ok())
        .map(|value| value.clamp(MIN_POLL_MS, MAX_POLL_MS))
        .unwrap_or(default_ms)
}

fn tray_poll_interval(snapshot: &StatusSnapshot) -> Duration {
    let poll_ms = if snapshot.last_event_kind == "approval_required" {
        poll_ms_from_env(
            "CODEX_STATUS_LIGHT_APPROVAL_POLL_MS",
            DEFAULT_APPROVAL_POLL_MS,
        )
    } else if snapshot.state == "running" || snapshot.state == "attention" {
        poll_ms_from_env("CODEX_STATUS_LIGHT_ACTIVE_POLL_MS", DEFAULT_ACTIVE_POLL_MS)
    } else {
        poll_ms_from_env("CODEX_STATUS_LIGHT_IDLE_POLL_MS", DEFAULT_IDLE_POLL_MS)
    };

    Duration::from_millis(poll_ms)
}

fn unavailable_grace_duration() -> Duration {
    Duration::from_millis(poll_ms_from_env(
        "CODEX_STATUS_LIGHT_UNAVAILABLE_GRACE_MS",
        DEFAULT_UNAVAILABLE_GRACE_MS,
    ))
}

fn snapshot_signature(snapshot: &StatusSnapshot) -> String {
    format!(
        "{}|{}|{}|{}|{}|{}",
        snapshot.state,
        snapshot.color,
        snapshot.reason,
        snapshot.last_event_kind,
        snapshot.last_event_at,
        snapshot.thread_id.as_deref().unwrap_or("")
    )
}

fn tray_icon_variant(snapshot: &StatusSnapshot, flash_on: bool) -> &str {
    if snapshot.last_event_kind == "approval_required" && !flash_on {
        "yellow_dim"
    } else {
        &snapshot.color
    }
}

fn apply_snapshot_to_tray(
    app: &AppHandle<Wry>,
    state_item: &MenuItem<Wry>,
    snapshot: &StatusSnapshot,
    icon_color: &str,
    last_signature: &mut Option<String>,
    last_icon_color: &mut Option<String>,
) -> Result<(), String> {
    let signature = snapshot_signature(snapshot);

    if last_signature.as_ref() != Some(&signature) {
        state_item
            .set_text(menu_label_for(snapshot))
            .map_err(|error| format!("failed to update tray menu state label: {error}"))?;
    }

    if let Some(tray) = app.tray_by_id("main") {
        tray.set_icon(Some(tray_image_for_color(icon_color)?))
            .map_err(|error| format!("failed to update tray icon: {error}"))?;
        if last_signature.as_ref() != Some(&signature) {
            tray.set_tooltip(Some(tooltip_for(snapshot)))
                .map_err(|error| format!("failed to update tray tooltip: {error}"))?;
        }
    }

    if last_signature.as_ref() != Some(&signature) {
        let _ = write_snapshot_file(snapshot);
        let _ = push_snapshot_to_window(app, snapshot);
    }

    *last_signature = Some(signature);
    *last_icon_color = Some(icon_color.to_string());
    Ok(())
}

fn sync_tray_state(
    app: &AppHandle<Wry>,
    state_item: &MenuItem<Wry>,
    flash_on: bool,
    last_signature: &mut Option<String>,
    last_icon_color: &mut Option<String>,
    snapshot_store: &SnapshotStore,
) -> Result<StatusSnapshot, String> {
    let snapshot = read_live_status_snapshot()?;
    snapshot_store.write(snapshot.clone());
    let icon_color = tray_icon_variant(&snapshot, flash_on).to_string();

    if last_signature.as_ref() == Some(&snapshot_signature(&snapshot))
        && last_icon_color.as_ref() == Some(&icon_color)
    {
        return Ok(snapshot);
    }

    apply_snapshot_to_tray(
        app,
        state_item,
        &snapshot,
        &icon_color,
        last_signature,
        last_icon_color,
    )?;
    Ok(snapshot)
}

fn spawn_tray_sync(
    app: AppHandle<Wry>,
    state_item: MenuItem<Wry>,
    initial_signature: Option<String>,
    initial_snapshot: Option<StatusSnapshot>,
    snapshot_store: SnapshotStore,
) {
    thread::spawn(move || {
        let mut last_signature = initial_signature;
        let mut last_icon_color = None;
        let mut last_good_snapshot = initial_snapshot;
        let mut last_success_at = last_good_snapshot.as_ref().map(|_| Instant::now());
        let mut flash_on = true;
        let unavailable_grace = unavailable_grace_duration();

        loop {
            let next_interval = match sync_tray_state(
                &app,
                &state_item,
                flash_on,
                &mut last_signature,
                &mut last_icon_color,
                &snapshot_store,
            ) {
                Ok(snapshot) => {
                    last_good_snapshot = Some(snapshot.clone());
                    last_success_at = Some(Instant::now());
                    flash_on = if snapshot.last_event_kind == "approval_required" {
                        !flash_on
                    } else {
                        true
                    };
                    tray_poll_interval(&snapshot)
                }
                Err(error) => {
                    if let (Some(snapshot), Some(last_success_at)) =
                        (last_good_snapshot.as_ref(), last_success_at)
                    {
                        if last_success_at.elapsed() <= unavailable_grace {
                            let retained_icon_color =
                                tray_icon_variant(snapshot, flash_on).to_string();
                            let _ = apply_snapshot_to_tray(
                                &app,
                                &state_item,
                                snapshot,
                                &retained_icon_color,
                                &mut last_signature,
                                &mut last_icon_color,
                            );
                            flash_on = if snapshot.last_event_kind == "approval_required" {
                                !flash_on
                            } else {
                                true
                            };
                            thread::sleep(tray_poll_interval(snapshot));
                            continue;
                        }
                    }

                    let snapshot = StatusSnapshot::unavailable(format!(
                        "状态暂时不可用：{error}"
                    ));
                    snapshot_store.write(snapshot.clone());
                    let _ = apply_snapshot_to_tray(
                        &app,
                        &state_item,
                        &snapshot,
                        "neutral",
                        &mut last_signature,
                        &mut last_icon_color,
                    );
                    flash_on = true;
                    Duration::from_millis(DEFAULT_IDLE_POLL_MS)
                }
            };

            thread::sleep(next_interval);
        }
    });
}

fn should_open_window_on_launch() -> bool {
    env::var("CODEX_STATUS_LIGHT_OPEN_ON_LAUNCH")
        .ok()
        .map(|value| {
            matches!(
                value.trim().to_ascii_lowercase().as_str(),
                "1" | "true" | "yes" | "on"
            )
        })
        .unwrap_or(false)
}

#[tauri::command]
fn read_status_snapshot(
    app: AppHandle<Wry>,
    snapshot_store: tauri::State<'_, SnapshotStore>,
) -> Result<StatusSnapshot, String> {
    if let Some(snapshot) = snapshot_store.read() {
        return Ok(snapshot);
    }

    let snapshot = read_live_status_snapshot()?;
    snapshot_store.write(snapshot.clone());
    let _ = write_snapshot_file(&snapshot);
    let _ = push_snapshot_to_window(&app, &snapshot);
    Ok(snapshot)
}

fn show_main_window(app: &AppHandle<Wry>) {
    let snapshot = app
        .state::<SnapshotStore>()
        .read()
        .or_else(|| read_live_status_snapshot().ok());

    if let Some(snapshot) = snapshot {
        let _ = push_snapshot_to_window(app, &snapshot);
    }

    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn main() {
    tauri::Builder::default()
        .manage(SnapshotStore::default())
        .invoke_handler(tauri::generate_handler![read_status_snapshot])
        .setup(|app| {
            let snapshot_store = app.state::<SnapshotStore>().inner().clone();
            let state_item =
                MenuItem::with_id(app, "state", "当前状态：启动中", false, None::<&str>)?;
            let open_item = MenuItem::with_id(app, "open", "打开状态灯", true, None::<&str>)?;
            let open_snapshot_item =
                MenuItem::with_id(app, "open_snapshot", "打开快照", true, None::<&str>)?;
            let open_codex_log_item =
                MenuItem::with_id(app, "open_codex_log", "打开 Codex 日志", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let tray_menu = Menu::with_items(
                app,
                &[
                    &state_item,
                    &open_item,
                    &open_snapshot_item,
                    &open_codex_log_item,
                    &quit_item,
                ],
            )?;

            let _tray = TrayIconBuilder::with_id("main")
                .icon(tray_image_for_color("neutral")?)
                .tooltip("Codex 状态灯")
                .menu(&tray_menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open" => show_main_window(app),
                    "open_snapshot" => {
                        let snapshot = app
                            .state::<SnapshotStore>()
                            .read()
                            .or_else(|| read_live_status_snapshot().ok());

                        if let Some(snapshot) = snapshot {
                            if let Ok(path) = write_snapshot_file(&snapshot) {
                                if let Err(error) = open_path(&path) {
                                    eprintln!("{error}");
                                }
                            }
                        }
                    }
                    "open_codex_log" => {
                        if let Err(error) = open_path(&codex_log_path()) {
                            eprintln!("{error}");
                        }
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| match event {
                    TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } => {
                        show_main_window(tray.app_handle());
                    }
                    _ => {}
                })
                .build(app)?;

            let app_handle = app.app_handle().clone();
            let mut last_signature = None;
            let mut last_icon_color = None;
            let initial_snapshot = sync_tray_state(
                &app_handle,
                &state_item,
                true,
                &mut last_signature,
                &mut last_icon_color,
                &snapshot_store,
            )
            .ok();
            spawn_tray_sync(
                app_handle.clone(),
                state_item.clone(),
                last_signature,
                initial_snapshot,
                snapshot_store,
            );
            if should_open_window_on_launch() {
                show_main_window(&app_handle);
            }

            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() == "main" {
                if let WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running Codex Status Light");
}
