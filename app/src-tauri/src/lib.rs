use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::State;

const API_URL: &str = {
    if let Some(url) = option_env!("API_URL") {
        url
    } else {
        "http://localhost:8000"
    }
};

struct AppToken(Mutex<Option<String>>);

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
struct UserPublic {
    id: String,
    username: String,
    email: String,
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
    token_state: State<'_, AppToken>,
) -> Result<UserPublic, String> {
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

    let auth: AuthResponse = resp.json().await.map_err(|e| e.to_string())?;
    *token_state.0.lock().unwrap() = Some(auth.token);
    Ok(auth.user)
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(AppToken(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![
            register,
            login,
            get_lessons,
            get_lesson,
            save_progress,
            get_progress,
            get_api_url,
        ]);

    #[cfg(mobile)]
    let builder = builder.plugin(tauri_plugin_sharesheet::init());
    #[cfg(mobile)]
    let builder = builder.plugin(tauri_plugin_barcode_scanner::init());
    #[cfg(any(desktop, mobile))]
    let builder = builder.plugin(tauri_plugin_deep_link::init());

    builder.run(tauri::generate_context!())
        .expect("error al ejecutar la aplicación");
}
