use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use uuid::Uuid;

#[derive(Debug, Serialize, Deserialize, FromRow)]
pub struct User {
    pub id: Uuid,
    pub username: String,
    pub email: String,
    pub password_hash: String,
    pub role: String,
    pub created_at: DateTime<Utc>,
    pub email_verified: bool,
}

#[derive(Debug, Serialize, Deserialize, FromRow)]
pub struct Lesson {
    pub id: i32,
    pub title: String,
    pub description: String,
    pub content: serde_json::Value,
    pub difficulty: String,
    pub order_index: i32,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Serialize, Deserialize, FromRow)]
pub struct UserProgress {
    pub id: i32,
    pub user_id: Uuid,
    pub lesson_id: i32,
    pub score: f32,
    pub completed: bool,
    pub completed_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Serialize, Deserialize, FromRow)]
pub struct LessonStatus {
    pub id: i32,
    pub lesson_id: i32,
    pub status: String,
    pub created_by: Uuid,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Serialize, Deserialize, FromRow)]
pub struct LessonApproval {
    pub id: i32,
    pub lesson_id: i32,
    pub admin_id: Uuid,
    pub comment: Option<String>,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Serialize, Deserialize, FromRow)]
pub struct AppConfig {
    pub key: String,
    pub value: serde_json::Value,
}

#[derive(Debug, Deserialize)]
pub struct RegisterRequest {
    pub username: String,
    pub email: String,
    pub password: String,
}

#[derive(Debug, Deserialize)]
pub struct LoginRequest {
    pub email: String,
    pub password: String,
}

#[derive(Debug, Deserialize)]
pub struct VerifyEmailRequest {
    pub email: String,
    pub code: String,
}

#[derive(Debug, Deserialize)]
pub struct ResendCodeRequest {
    pub email: String,
}

#[derive(Debug, Serialize, Deserialize, FromRow)]
pub struct PendingRegistration {
    pub id: Uuid,
    pub email: String,
    pub username: String,
    pub password_hash: String,
    pub code: String,
    pub expires_at: chrono::DateTime<chrono::Utc>,
    pub created_at: chrono::DateTime<chrono::Utc>,
}

#[derive(Debug, Serialize)]
pub struct AuthResponse {
    pub token: String,
    pub user: UserPublic,
}

#[derive(Debug, Serialize)]
pub struct UserPublic {
    pub id: Uuid,
    pub username: String,
    pub email: String,
    pub role: String,
    pub email_verified: bool,
}

#[derive(Debug, Deserialize)]
pub struct SaveProgressRequest {
    pub lesson_id: i32,
    pub score: f32,
    pub completed: bool,
}

#[derive(Debug, Serialize)]
pub struct ProgressWithLesson {
    pub progress: UserProgress,
    pub lesson: Lesson,
}

#[derive(Debug, Serialize)]
pub struct ErrorResponse {
    pub error: String,
}

#[derive(Debug, Deserialize)]
pub struct CreateLessonRequest {
    pub title: String,
    pub description: Option<String>,
    pub content: serde_json::Value,
    pub difficulty: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct UpdateLessonRequest {
    pub title: Option<String>,
    pub description: Option<String>,
    pub content: Option<serde_json::Value>,
    pub difficulty: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct CreateAdminUserRequest {
    pub username: String,
    pub email: String,
    pub password: String,
}

#[derive(Debug, Serialize)]
pub struct LessonWithStatus {
    pub lesson: Lesson,
    pub status: String,
    pub created_by: Uuid,
    pub approval_count: i64,
    pub min_approvals: i64,
}

#[derive(Debug, Serialize)]
pub struct ApprovalResult {
    pub approval: LessonApproval,
    pub new_status: String,
    pub approval_count: i64,
    pub min_approvals: i64,
}

#[derive(Debug, Serialize)]
pub struct ConfigResponse {
    pub min_approvals: i64,
}

#[derive(Debug, Deserialize)]
pub struct ApproveLessonRequest {
    pub comment: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct UpdateConfigRequest {
    pub min_approvals: i64,
}

#[derive(Debug, Serialize)]
pub struct AdminUserResponse {
    pub id: Uuid,
    pub username: String,
    pub email: String,
    pub role: String,
    pub created_at: chrono::DateTime<chrono::Utc>,
    pub lessons_completed: i64,
}

#[derive(Debug, Serialize)]
pub struct LessonCompletionStat {
    pub lesson_id: i32,
    pub title: String,
    pub completions: i64,
}

#[derive(Debug, Serialize)]
pub struct DifficultyStat {
    pub difficulty: String,
    pub completions: i64,
}

#[derive(Debug, Deserialize)]
pub struct ChangePasswordRequest {
    pub current_password: String,
    pub new_password: String,
}

#[derive(Debug, Serialize)]
pub struct MessageResponse {
    pub message: String,
}

#[derive(Debug, Deserialize)]
pub struct LogErrorRequest {
    pub message: String,
    pub page: Option<String>,
    pub version: String,
    pub platform: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct AppInfoResponse {
    pub active_version: String,
    pub app_url: String,
    pub app_description: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct KeyMappingsResponse {
    pub mappings: serde_json::Value,
    pub preferences: serde_json::Value,
}

#[derive(Debug, Deserialize)]
pub struct KeyMappingsPayload {
    pub mappings: serde_json::Value,
    pub preferences: Option<serde_json::Value>,
}

#[derive(Debug, Deserialize)]
pub struct FriendRequestPayload {
    pub username: Option<String>,
    pub user_id: Option<Uuid>,
}

#[derive(Debug, Serialize, FromRow)]
pub struct UserSearchResult {
    pub id: Uuid,
    pub username: String,
}

#[derive(Debug, Serialize, FromRow)]
pub struct FriendWithUser {
    pub friend_id: Uuid,
    pub username: String,
    pub since: DateTime<Utc>,
    pub is_active: bool,
}

#[derive(Debug, Serialize, FromRow)]
pub struct PendingRequest {
    pub id: Uuid,
    pub sender_id: Uuid,
    pub sender_username: String,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Serialize, Deserialize, FromRow)]
pub struct MultiplayerSession {
    pub id: Uuid,
    pub host_id: Uuid,
    pub lesson_id: i32,
    pub code: String,
    pub status: String,
    pub created_at: chrono::DateTime<chrono::Utc>,
    pub started_at: Option<chrono::DateTime<chrono::Utc>>,
    pub finished_at: Option<chrono::DateTime<chrono::Utc>>,
}

#[derive(Debug, Serialize, FromRow)]
pub struct ParticipantWithUser {
    pub user_id: Uuid,
    pub username: String,
    pub score: f32,
    pub perfects: i32,
    pub goods: i32,
    pub lates: i32,
    pub misses: i32,
    pub completed: bool,
    pub joined_at: chrono::DateTime<chrono::Utc>,
    pub finished_at: Option<chrono::DateTime<chrono::Utc>>,
}

#[derive(Debug, Serialize)]
pub struct SessionWithParticipants {
    pub session: MultiplayerSession,
    pub host_username: String,
    pub participants: Vec<ParticipantWithUser>,
}

#[derive(Debug, Deserialize)]
pub struct CreateSessionRequest {
    pub lesson_id: i32,
}

#[derive(Debug, Deserialize)]
pub struct JoinSessionRequest {
    pub code: String,
}

#[derive(Debug, Deserialize)]
#[allow(dead_code)]
pub struct SubmitScoreRequest {
    pub session_id: Uuid,
    pub score: f32,
    pub perfects: i32,
    pub goods: i32,
    pub lates: i32,
    pub misses: i32,
    pub completed: bool,
}

#[derive(Debug, Serialize, Deserialize, FromRow)]
#[allow(dead_code)]
pub struct AuditLog {
    pub id: Uuid,
    pub user_id: Option<Uuid>,
    pub method: String,
    pub path: String,
    pub request_body: Option<String>,
    pub response_status: i32,
    pub response_body: Option<String>,
    pub ip_address: Option<String>,
    pub duration_ms: i32,
    pub created_at: chrono::DateTime<chrono::Utc>,
}

#[derive(Debug, Deserialize)]
pub struct LeaveSessionRequest {
    pub session_id: Uuid,
}

#[derive(Debug, Serialize, FromRow)]
pub struct StreakWithUser {
    pub user_id: Uuid,
    pub username: String,
    pub streak_days: i32,
    pub last_practice_date: chrono::NaiveDate,
}

#[derive(Debug, Serialize)]
pub struct StatsResponse {
    pub total_users: i64,
    pub total_lessons: i64,
    pub total_completions: i64,
    pub completions_by_lesson: Vec<LessonCompletionStat>,
    pub completions_by_difficulty: Vec<DifficultyStat>,
}
