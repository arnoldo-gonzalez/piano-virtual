use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::{Manager, State};
use tauri_plugin_deep_link::DeepLinkExt;

const API_URL: &str = {
    if let Some(url) = option_env!("API_URL") {
        url
    } else {
        "https://piano-virtual.alwaysdata.net"
    }
};

struct AppToken(Mutex<Option<String>>);

struct PendingDeepLink(Mutex<Option<String>>);

#[derive(Debug, Serialize, Deserialize)]
struct RegisterRequest {
    username: String,
    email: String,
    password: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct LoginRequest {
    email: String,
    password: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct AuthResponse {
    token: String,
    user: UserPublic,
}

#[derive(Debug, Serialize, Deserialize)]
struct MessageResponse {
    message: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct UserPublic {
    id: String,
    username: String,
    email: String,
    email_verified: bool,
}

#[derive(Debug, Serialize, Deserialize)]
struct Lesson {
    id: i32,
    title: String,
    description: String,
    content: serde_json::Value,
    difficulty: String,
    order_index: i32,
}

#[derive(Debug, Serialize, Deserialize)]
struct SaveProgressRequest {
    lesson_id: i32,
    score: f32,
    completed: bool,
}

#[derive(Debug, Serialize, Deserialize)]
struct UserProgress {
    id: i32,
    user_id: String,
    lesson_id: i32,
    score: f32,
    completed: bool,
    completed_at: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
struct ErrorResponse {
    error: String,
}

#[tauri::command]
async fn register(
    username: String,
    email: String,
    password: String,
) -> Result<String, String> {
    let client = reqwest::Client::new();
    let body = RegisterRequest {
        username,
        email,
        password,
    };

    let resp = client
        .post(format!("{API_URL}/api/register"))
        .json(&body)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !resp.status().is_success() {
        let err: ErrorResponse = resp.json().await.map_err(|e| e.to_string())?;
        return Err(err.error);
    }

    let msg: MessageResponse = resp.json().await.map_err(|e| e.to_string())?;
    Ok(msg.message)
}

#[tauri::command]
async fn verify_email(
    email: String,
    code: String,
    token_state: State<'_, AppToken>,
) -> Result<UserPublic, String> {
    let client = reqwest::Client::new();
    let body = serde_json::json!({ "email": email, "code": code });

    let resp = client
        .post(format!("{API_URL}/api/verify-email"))
        .json(&body)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !resp.status().is_success() {
        let err: ErrorResponse = resp.json().await.map_err(|e| e.to_string())?;
        return Err(err.error);
    }

    let auth: AuthResponse = resp.json().await.map_err(|e| e.to_string())?;
    *token_state.0.lock().unwrap() = Some(auth.token);
    Ok(auth.user)
}

#[tauri::command]
async fn resend_code(email: String) -> Result<String, String> {
    let client = reqwest::Client::new();
    let body = serde_json::json!({ "email": email });

    let resp = client
        .post(format!("{API_URL}/api/resend-code"))
        .json(&body)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !resp.status().is_success() {
        let err: ErrorResponse = resp.json().await.map_err(|e| e.to_string())?;
        return Err(err.error);
    }

    let msg: MessageResponse = resp.json().await.map_err(|e| e.to_string())?;
    Ok(msg.message)
}

#[tauri::command]
async fn login(
    email: String,
    password: String,
    token_state: State<'_, AppToken>,
) -> Result<UserPublic, String> {
    let client = reqwest::Client::new();
    let body = LoginRequest { email, password };

    let resp = client
        .post(format!("{API_URL}/api/login"))
        .json(&body)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !resp.status().is_success() {
        let err: ErrorResponse = resp.json().await.map_err(|e| e.to_string())?;
        return Err(err.error);
    }

    let auth: AuthResponse = resp.json().await.map_err(|e| e.to_string())?;
    *token_state.0.lock().unwrap() = Some(auth.token);
    Ok(auth.user)
}

fn get_token(token_state: &State<'_, AppToken>) -> Result<String, String> {
    token_state
        .0
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| "No autenticado".to_string())
}

#[tauri::command]
async fn get_lessons() -> Result<Vec<Lesson>, String> {
    let client = reqwest::Client::new();
    let resp = client
        .get(format!("{API_URL}/api/lessons"))
        .send()
        .await
        .map_err(|e| e.to_string())?;

    resp.json().await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn get_lesson(id: i32) -> Result<Lesson, String> {
    let client = reqwest::Client::new();
    let resp = client
        .get(format!("{API_URL}/api/lessons/{id}"))
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !resp.status().is_success() {
        let err: ErrorResponse = resp.json().await.map_err(|e| e.to_string())?;
        return Err(err.error);
    }

    resp.json().await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn save_progress(
    lesson_id: i32,
    score: f32,
    completed: bool,
    token_state: State<'_, AppToken>,
) -> Result<UserProgress, String> {
    let token = get_token(&token_state)?;
    let client = reqwest::Client::new();
    let body = SaveProgressRequest {
        lesson_id,
        score,
        completed,
    };

    let resp = client
        .post(format!("{API_URL}/api/progress"))
        .header("Authorization", format!("Bearer {token}"))
        .json(&body)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !resp.status().is_success() {
        let err: ErrorResponse = resp.json().await.map_err(|e| e.to_string())?;
        return Err(err.error);
    }

    resp.json().await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn get_progress(
    token_state: State<'_, AppToken>,
) -> Result<Vec<serde_json::Value>, String> {
    let token = get_token(&token_state)?;
    let client = reqwest::Client::new();
    let resp = client
        .get(format!("{API_URL}/api/progress"))
        .header("Authorization", format!("Bearer {token}"))
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !resp.status().is_success() {
        let err: ErrorResponse = resp.json().await.map_err(|e| e.to_string())?;
        return Err(err.error);
    }

    resp.json().await.map_err(|e| e.to_string())
}

#[tauri::command]
fn get_api_url() -> String {
    API_URL.to_string()
}

#[tauri::command]
fn get_pending_deep_link(state: State<'_, PendingDeepLink>) -> Option<String> {
    state.0.lock().unwrap().take()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(AppToken(Mutex::new(None)))
        .manage(PendingDeepLink(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![
            register,
            login,
            verify_email,
            resend_code,
            get_lessons,
            get_lesson,
            save_progress,
            get_progress,
            get_api_url,
            get_pending_deep_link,
        ]);

    #[cfg(mobile)]
    let builder = builder.plugin(tauri_plugin_sharesheet::init());
    #[cfg(mobile)]
    let builder = builder.plugin(tauri_plugin_barcode_scanner::init());
    #[cfg(any(desktop, mobile))]
    let builder = builder.plugin(tauri_plugin_deep_link::init());

    #[cfg(any(desktop, mobile))]
    let builder = builder.setup(|app| {
        let handle = app.handle().clone();
        app.deep_link().on_open_url(move |event| {
            let urls = event.urls();
            if let Some(url) = urls.first() {
                let state = handle.state::<PendingDeepLink>();
                *state.0.lock().unwrap() = Some(url.to_string());
            }
        });
        Ok(())
    });

    builder.run(tauri::generate_context!())
        .expect("error al ejecutar la aplicación");
}
