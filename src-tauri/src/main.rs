// Kairos desktop shell (Tauri). The window is only a view of the page the local engine serves;
// monitoring lives in the detached engine process, so closing or quitting the window never stops it.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde_json::{json, Value};
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::thread;
use std::time::Duration;
use tauri::image::Image;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent, Wry};
use tauri_plugin_notification::NotificationExt;

const ENGINE: &str = "http://127.0.0.1:2790";

// Runs on every page the window loads (boot page and the engine's page): tells the UI that this
// shell shows OS notifications itself and draws a native frame.
const INIT: &str = r#"
window.kairos = { notifies: true };
document.addEventListener('DOMContentLoaded', () => document.documentElement.classList.add('native-frame'));
"#;

struct TrayState {
    status: MenuItem<Wry>,
    pause: MenuItem<Wry>,
    paused: Mutex<bool>,
}

// --- paths + engine API -------------------------------------------------------------------------

fn home() -> PathBuf {
    PathBuf::from(std::env::var("HOME").or_else(|_| std::env::var("USERPROFILE")).unwrap_or_default())
}

fn data_dir() -> PathBuf {
    if let Ok(d) = std::env::var("KAIROS_DATA") {
        return PathBuf::from(d); // same override the engine honours (tests, dev)
    }
    if cfg!(target_os = "macos") {
        home().join("Library/Application Support/Kairos")
    } else {
        PathBuf::from(std::env::var("APPDATA").unwrap_or_default()).join("Kairos")
    }
}

fn token() -> Option<String> {
    let raw = std::fs::read_to_string(data_dir().join("config.json")).ok()?;
    serde_json::from_str::<Value>(&raw).ok()?["token"].as_str().map(String::from)
}

fn health() -> Option<Value> {
    ureq::get(&format!("{ENGINE}/health")).timeout(Duration::from_millis(1500)).call().ok()?.into_json().ok()
}

// Kairos 1.0.0 engines answered {ok, pid} without the "app" marker; treat those as Kairos too.
fn is_kairos(h: &Option<Value>) -> bool {
    h.as_ref().map(|h| h["app"] == "kairos" || (h["ok"] == true && h["app"].is_null() && h["pid"].is_number())).unwrap_or(false)
}

fn api(method: &str, path: &str, body: Value) -> Option<Value> {
    let tok = token()?;
    ureq::request(method, &format!("{ENGINE}{path}"))
        .set("Authorization", &format!("Bearer {tok}"))
        .timeout(Duration::from_secs(10))
        .send_json(body)
        .ok()?
        .into_json()
        .ok()
}

// --- runtime + engine (Windows: unpacked from the installer; Mac: installed by install.sh) ------

#[cfg(windows)]
fn runtime_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let version = app.package_info().version.to_string();
    let base = PathBuf::from(std::env::var("LOCALAPPDATA").map_err(|e| e.to_string())?).join("Kairos").join("runtime");
    let dir = base.join(&version);
    if dir.join("VERSION").exists() {
        return Ok(dir);
    }
    boot(app, "Setting up Kairos…", "Unpacking the WhatsApp engine. This happens once after installing or updating and takes about a minute.", false);
    let tar = app.path().resource_dir().map_err(|e| e.to_string())?.join("runtime.tar");
    let tar = PathBuf::from(tar.to_string_lossy().trim_start_matches(r"\\?\"));
    let tmp = base.join(format!("{version}.partial"));
    let _ = std::fs::remove_dir_all(&tmp);
    std::fs::create_dir_all(&tmp).map_err(|e| e.to_string())?;
    let sys_tar = PathBuf::from(std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".into())).join(r"System32\tar.exe");
    let ok = no_window(Command::new(sys_tar).arg("-xf").arg(&tar).arg("-C").arg(&tmp))
        .status()
        .map(|s| s.success())
        .unwrap_or(false);
    if !ok {
        return Err(format!("Could not unpack {}", tar.display()));
    }
    std::fs::rename(&tmp, &dir).map_err(|e| e.to_string())?;
    // Older versions are dead weight once this one is unpacked (their engine was stopped first).
    if let Ok(entries) = std::fs::read_dir(&base) {
        for e in entries.flatten() {
            if e.path() != dir {
                let _ = std::fs::remove_dir_all(e.path());
            }
        }
    }
    Ok(dir)
}

#[cfg(windows)]
fn no_window(cmd: &mut Command) -> &mut Command {
    use std::os::windows::process::CommandExt;
    cmd.creation_flags(0x0800_0000) // CREATE_NO_WINDOW
}

#[cfg(windows)]
fn start_engine(app: &AppHandle) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    // Debug builds (npm start) run the engine straight from the repository.
    let (root, vendor) = if cfg!(debug_assertions) {
        let repo = PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().unwrap().to_path_buf();
        (repo.clone(), repo.join("vendor"))
    } else {
        let rt = runtime_dir(app)?;
        (rt.join("app"), rt.join("vendor"))
    };
    let docs = app.path().document_dir().map_err(|e| e.to_string())?.join("Kairos");
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    Command::new(vendor.join(r"node\node.exe"))
        .arg(root.join(r"engine\index.js"))
        .current_dir(&root)
        .env("KAIROS_VENDOR", &vendor)
        .env("KAIROS_DOCS", &docs)
        .env("KAIROS_SHELL", "tauri")
        .env("KAIROS_UI", json!({ "cmd": exe, "args": [] }).to_string())
        .env_remove("ELECTRON_RUN_AS_NODE")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        // CREATE_NO_WINDOW | DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP: outlives the window.
        .creation_flags(0x0800_0000 | 0x0000_0008 | 0x0000_0200)
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

#[cfg(target_os = "macos")]
fn start_engine(_app: &AppHandle) -> Result<(), String> {
    // The LaunchAgent written by install.sh owns the engine.
    let uid = Command::new("id").arg("-u").output().map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string()).unwrap_or_default();
    let kick = Command::new("launchctl").args(["kickstart", &format!("gui/{uid}/app.kairos.engine")]).status();
    if !kick.map(|s| s.success()).unwrap_or(false) {
        let agent = home().join("Library/LaunchAgents/app.kairos.engine.plist");
        if !agent.exists() {
            return Err("The Kairos background service is not installed. Run the Kairos installer again.".into());
        }
        let _ = Command::new("launchctl").arg("bootstrap").arg(format!("gui/{uid}")).arg(agent).status();
    }
    Ok(())
}

#[cfg(not(any(windows, target_os = "macos")))]
fn start_engine(_app: &AppHandle) -> Result<(), String> {
    Err("Start the engine with: node engine/index.js".into())
}

// Makes sure the engine of *this* version answers on its port.
fn ensure_engine(app: &AppHandle) -> Result<(), String> {
    let want = app.package_info().version.to_string();
    let h = health();
    if let Some(h) = &h {
        if !is_kairos(&Some(h.clone())) {
            return Err("Another program is using port 2790, which Kairos needs. Close it and open Kairos again.".into());
        }
        // On Mac the installer replaces the engine and restarts it; there any running engine is fine.
        if h["version"] == want.as_str() || cfg!(target_os = "macos") {
            return Ok(());
        }
        // An older engine survived an update: stop it so the new code runs.
        boot(app, "Updating Kairos…", "Restarting the background service with the new version.", false);
        api("POST", "/api/shutdown", json!({}));
        for _ in 0..60 {
            if health().is_none() {
                break;
            }
            thread::sleep(Duration::from_millis(250));
        }
        thread::sleep(Duration::from_secs(2)); // let it stop OpenWA before files are swapped
    }
    start_engine(app)?;
    for _ in 0..240 {
        if is_kairos(&health()) {
            return Ok(());
        }
        thread::sleep(Duration::from_millis(250));
    }
    Err(format!("The background service did not start. Logs are in <code>{}</code>", data_dir().join("logs").display()))
}

// --- window --------------------------------------------------------------------------------------

fn boot(app: &AppHandle, title: &str, msg: &str, error: bool) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.eval(&format!("window.kairosBoot && window.kairosBoot({}, {}, {})", json!(title), json!(msg), error));
        if error {
            let _ = w.show();
        }
    }
}

fn show(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

fn notify(app: &AppHandle, title: &str, body: &str) {
    let _ = app.notification().builder().title(title).body(body).show();
}

fn create_window(app: &AppHandle, hidden: bool) -> tauri::Result<()> {
    let hint = data_dir().join("ui").join(".hinted");
    let handle = app.clone();
    let win = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
        .title("Kairos")
        .inner_size(1220.0, 800.0)
        .min_inner_size(980.0, 640.0)
        .visible(!hidden)
        .initialization_script(INIT)
        // Only the boot page and the engine's page may load in this window.
        .on_navigation(|url| url.as_str().starts_with(ENGINE) || url.scheme() == "tauri" || url.host_str() == Some("tauri.localhost"))
        .build()?;
    win.on_window_event(move |e| {
        if let WindowEvent::CloseRequested { api, .. } = e {
            api.prevent_close();
            if let Some(w) = handle.get_webview_window("main") {
                let _ = w.hide();
            }
            if !hint.exists() {
                let _ = std::fs::create_dir_all(hint.parent().unwrap());
                let _ = std::fs::write(&hint, "1");
                let place = if cfg!(target_os = "macos") { "menu bar" } else { "system tray" };
                notify(&handle, "Kairos is still watching", &format!("Monitoring continues in the background. Find Kairos in the {place}."));
            }
        }
    });
    Ok(())
}

// --- tray + engine events ------------------------------------------------------------------------

fn wa_label(status: &str) -> &'static str {
    match status {
        "ready" => "Connected",
        "qr_ready" => "Waiting for QR scan",
        "initializing" | "authenticating" => "Connecting…",
        "disconnected" => "Disconnected",
        "failed" => "Connection failed",
        "created" => "Not connected",
        _ => "Starting…",
    }
}

fn update_tray(app: &AppHandle, status: Option<&str>, paused: Option<bool>) {
    let t = app.state::<TrayState>();
    if let Some(p) = paused {
        *t.paused.lock().unwrap() = p;
        let _ = t.pause.set_text(if p { "Resume monitoring" } else { "Pause monitoring" });
    }
    if let Some(s) = status {
        let _ = t.status.set_text(format!("WhatsApp: {}", wa_label(s)));
        if let Some(tray) = app.tray_by_id("main") {
            let p = *t.paused.lock().unwrap();
            let _ = tray.set_tooltip(Some(format!("Kairos — WhatsApp: {}{}", wa_label(s), if p { " · paused" } else { "" })));
        }
    }
}

fn on_event(app: &AppHandle, kind: &str, d: &Value) {
    match kind {
        "state" => update_tray(app, d["wa"]["status"].as_str(), d["paused"].as_bool()),
        "wa" => update_tray(app, d["status"].as_str(), None),
        "health" => update_tray(app, None, d["paused"].as_bool()),
        "relogin" => {
            show(app);
            notify(app, "Kairos needs you", "Your WhatsApp session ended. Scan the QR code to keep monitoring.");
        }
        "activity" => {
            let label = match d["kind"].as_str().unwrap_or("") {
                "meeting" => "Meeting request",
                "document" => "Document",
                "order" => "Order",
                _ => return,
            };
            notify(app, &format!("{label} · {}", d["name"].as_str().unwrap_or("")), d["title"].as_str().unwrap_or(""));
        }
        "digest" => notify(app, "Kairos · Today", d["text"].as_str().unwrap_or("")),
        _ => {}
    }
}

// Follows the engine's event stream; if the engine dies, brings it back (Windows) and reconnects.
fn listen(app: AppHandle) {
    loop {
        if let Some(tok) = token() {
            if let Ok(res) = ureq::get(&format!("{ENGINE}/events?token={tok}")).call() {
                let mut kind = String::new();
                for line in BufReader::new(res.into_reader()).lines() {
                    let Ok(line) = line else { break };
                    if let Some(k) = line.strip_prefix("event: ") {
                        kind = k.to_string();
                    } else if let Some(data) = line.strip_prefix("data: ") {
                        if let Ok(v) = serde_json::from_str::<Value>(data) {
                            on_event(&app, &kind, &v);
                        }
                    }
                }
            }
        }
        update_tray(&app, Some("booting"), None);
        thread::sleep(Duration::from_secs(3));
        if cfg!(windows) && !is_kairos(&health()) {
            let _ = ensure_engine(&app);
        }
    }
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Open Kairos", true, None::<&str>)?;
    let status = MenuItem::with_id(app, "status", "WhatsApp: Starting…", false, None::<&str>)?;
    let pause = MenuItem::with_id(app, "pause", "Pause monitoring", true, None::<&str>)?;
    let close = MenuItem::with_id(app, "close", "Close window (keep monitoring)", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit and stop monitoring", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &status, &PredefinedMenuItem::separator(app)?, &pause, &PredefinedMenuItem::separator(app)?, &close, &quit])?;
    app.manage(TrayState { status, pause, paused: Mutex::new(false) });
    TrayIconBuilder::with_id("main")
        .icon(Image::from_bytes(include_bytes!("../../app/ui/assets/tray.png"))?)
        .tooltip("Kairos")
        .menu(&menu)
        .show_menu_on_left_click(cfg!(target_os = "macos"))
        .on_menu_event(|app, e| match e.id().as_ref() {
            "open" => show(app),
            "pause" => {
                let now = *app.state::<TrayState>().paused.lock().unwrap();
                if let Some(r) = api("POST", "/api/pause", json!({ "paused": !now })) {
                    update_tray(app, None, r["paused"].as_bool());
                }
            }
            "close" => app.exit(0),
            "quit" => {
                api("POST", "/api/shutdown", json!({}));
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, e| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = e {
                show(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

fn main() {
    let hidden = std::env::args().any(|a| a == "--hidden");
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, _| {
            if !args.iter().any(|a| a == "--hidden") {
                show(app);
            }
        }))
        .plugin(tauri_plugin_notification::init())
        .setup(move |app| {
            let handle = app.handle().clone();
            build_tray(&handle)?;
            create_window(&handle, hidden)?;
            thread::spawn(move || match ensure_engine(&handle) {
                Ok(()) => {
                    if let Some(w) = handle.get_webview_window("main") {
                        let _ = w.navigate(ENGINE.parse().unwrap());
                    }
                    listen(handle);
                }
                Err(e) => boot(&handle, "Kairos could not start", &e, true),
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to start Kairos")
        .run(|_, e| {
            // Closing the last window must not end the tray app.
            if let tauri::RunEvent::ExitRequested { api, code: None, .. } = e {
                api.prevent_exit();
            }
        });
}
