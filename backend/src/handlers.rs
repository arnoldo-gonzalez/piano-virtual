use axum::{
    extract::{Path, Query, State},
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::Html,
    Extension, Json,
};
use bcrypt::{hash, verify, DEFAULT_COST};
use rand::Rng;
use serde_json::json;
use std::collections::HashMap;
use uuid::Uuid;

use crate::auth;
use crate::models::*;
use crate::AppState;
use chrono::Utc;

static APPS_DIR: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/apps");

// ---- Auth ----

pub async fn register(
    State(state): State<AppState>,
    Json(body): Json<RegisterRequest>,
) -> Result<Json<MessageResponse>, (StatusCode, Json<ErrorResponse>)> {
    let exists = sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(SELECT 1 FROM users WHERE email = $1 OR username = $1)",
    )
    .bind(&body.email)
    .fetch_one(&state.db)
    .await
    .unwrap_or(false);

    if exists {
        return Err((
            StatusCode::CONFLICT,
            Json(ErrorResponse {
                error: "El correo o nombre de usuario ya está registrado".to_string(),
            }),
        ));
    }

    let password_hash = hash(&body.password, DEFAULT_COST).map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: format!("Error al hashear contraseña: {e}"),
            }),
        )
    })?;

    let code: String = rand::thread_rng()
        .gen_range(100_000..999_999)
        .to_string();

    let expires_at = Utc::now() + chrono::Duration::minutes(10);

    sqlx::query("DELETE FROM pending_registrations WHERE email = $1")
        .bind(&body.email)
        .execute(&state.db)
        .await
        .ok();

    sqlx::query(
        "INSERT INTO pending_registrations (email, username, password_hash, code, expires_at) \
         VALUES ($1, $2, $3, $4, $5)",
    )
    .bind(&body.email)
    .bind(&body.username)
    .bind(&password_hash)
    .bind(&code)
    .bind(&expires_at)
    .execute(&state.db)
    .await
    .map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: format!("Error al guardar registro pendiente: {e}"),
            }),
        )
    })?;

    if let Some(mailer) = &state.mail_config {
        if let Err(e) = mailer.send_verification_code(&body.email, &code).await {
            tracing::error!("Error al enviar código de verificación a {}: {}", body.email, e);
            return Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ErrorResponse {
                    error: "No se pudo enviar el código de verificación. Intenta de nuevo.".to_string(),
                }),
            ));
        }
    } else {
        tracing::info!("Código de verificación para {}: {}", body.email, code);
    }

    Ok(Json(MessageResponse {
        message: "Revisa tu correo para el código de verificación.".to_string(),
    }))
}

pub async fn verify_email(
    State(state): State<AppState>,
    Json(body): Json<VerifyEmailRequest>,
) -> Result<Json<AuthResponse>, (StatusCode, Json<ErrorResponse>)> {
    let now = Utc::now();

    let pending = sqlx::query_as::<_, PendingRegistration>(
        "SELECT * FROM pending_registrations \
         WHERE email = $1 AND code = $2 AND expires_at > $3 \
         LIMIT 1",
    )
    .bind(&body.email)
    .bind(&body.code)
    .bind(&now)
    .fetch_optional(&state.db)
    .await
    .map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: format!("Error al verificar código: {e}"),
            }),
        )
    })?
    .ok_or((
        StatusCode::BAD_REQUEST,
        Json(ErrorResponse {
            error: "Código inválido o expirado".to_string(),
        }),
    ))?;

    let user = sqlx::query_as::<_, User>(
        "INSERT INTO users (username, email, password_hash, role, email_verified) \
         VALUES ($1, $2, $3, 'user', true) RETURNING *",
    )
    .bind(&pending.username)
    .bind(&pending.email)
    .bind(&pending.password_hash)
    .fetch_one(&state.db)
    .await
    .map_err(|e| {
        let status = if e.to_string().contains("unique")
            || e.to_string().contains("duplicate")
        {
            StatusCode::CONFLICT
        } else {
            StatusCode::INTERNAL_SERVER_ERROR
        };
        (
            status,
            Json(ErrorResponse {
                error: format!("Error al crear usuario: {e}"),
            }),
        )
    })?;

    sqlx::query("DELETE FROM pending_registrations WHERE id = $1")
        .bind(&pending.id)
        .execute(&state.db)
        .await
        .ok();

    let token = auth::create_token(user.id, &user.role).map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: format!("Error al crear token: {e}"),
            }),
        )
    })?;

    Ok(Json(AuthResponse {
        token,
        user: UserPublic {
            id: user.id,
            username: user.username,
            email: user.email,
            role: user.role,
            email_verified: true,
        },
    }))
}

pub async fn resend_code(
    State(state): State<AppState>,
    Json(body): Json<ResendCodeRequest>,
) -> Result<Json<MessageResponse>, (StatusCode, Json<ErrorResponse>)> {
    let pending = sqlx::query_as::<_, PendingRegistration>(
        "SELECT * FROM pending_registrations WHERE email = $1",
    )
    .bind(&body.email)
    .fetch_optional(&state.db)
    .await
    .map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: format!("Error al buscar registro: {e}"),
            }),
        )
    })?
    .ok_or((
        StatusCode::NOT_FOUND,
        Json(ErrorResponse {
            error: "No hay registro pendiente para este correo".to_string(),
        }),
    ))?;

    let code: String = rand::thread_rng()
        .gen_range(100_000..999_999)
        .to_string();

    let expires_at = Utc::now() + chrono::Duration::minutes(10);

    sqlx::query(
        "UPDATE pending_registrations SET code = $1, expires_at = $2 WHERE id = $3",
    )
    .bind(&code)
    .bind(&expires_at)
    .bind(&pending.id)
    .execute(&state.db)
    .await
    .map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: format!("Error al actualizar código: {e}"),
            }),
        )
    })?;

    if let Some(mailer) = &state.mail_config {
        if let Err(e) = mailer.send_verification_code(&body.email, &code).await {
            tracing::error!("Error al enviar código a {}: {}", body.email, e);
            return Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ErrorResponse {
                    error: "No se pudo enviar el código. Intenta de nuevo.".to_string(),
                }),
            ));
        }
    } else {
        tracing::info!("Código reenviado para {}: {}", body.email, code);
    }

    Ok(Json(MessageResponse {
        message: "Código reenviado. Revisa tu correo.".to_string(),
    }))
}

pub async fn login(
    State(state): State<AppState>,
    Json(body): Json<LoginRequest>,
) -> Result<Json<AuthResponse>, (StatusCode, Json<ErrorResponse>)> {
    let user = sqlx::query_as::<_, User>("SELECT * FROM users WHERE email = $1")
        .bind(&body.email)
        .fetch_optional(&state.db)
        .await
        .map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ErrorResponse {
                    error: format!("Error al buscar usuario: {e}"),
                }),
            )
        })?
        .ok_or((
            StatusCode::UNAUTHORIZED,
            Json(ErrorResponse {
                error: "Credenciales inválidas".to_string(),
            }),
        ))?;

    let valid = verify(&body.password, &user.password_hash).map_err(|_| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: "Error al verificar contraseña".to_string(),
            }),
        )
    })?;

    if !valid {
        return Err((
            StatusCode::UNAUTHORIZED,
            Json(ErrorResponse {
                error: "Credenciales inválidas".to_string(),
            }),
        ));
    }

    if !user.email_verified {
        return Err((
            StatusCode::FORBIDDEN,
            Json(ErrorResponse {
                error: "Debes verificar tu correo electrónico antes de iniciar sesión. Revisa tu bandeja de entrada o solicita un nuevo código.".to_string(),
            }),
        ));
    }

    let token = auth::create_token(user.id, &user.role).map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: format!("Error al crear token: {e}"),
            }),
        )
    })?;

    Ok(Json(AuthResponse {
        token,
        user: UserPublic {
            id: user.id,
            username: user.username,
            email: user.email,
            role: user.role,
            email_verified: true,
        },
    }))
}

// ---- Public Lessons ----

pub async fn list_lessons(
    State(state): State<AppState>,
) -> Result<Json<Vec<Lesson>>, (StatusCode, Json<ErrorResponse>)> {
    let lessons = sqlx::query_as::<_, Lesson>(
        "SELECT l.* FROM lessons l \
         INNER JOIN lesson_status ls ON ls.lesson_id = l.id \
         WHERE ls.status = 'public' \
         ORDER BY l.order_index ASC",
    )
    .fetch_all(&state.db)
    .await
    .map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: format!("Error al obtener lecciones: {e}"),
            }),
        )
    })?;

    Ok(Json(lessons))
}

pub async fn get_lesson(
    State(state): State<AppState>,
    Path(id): Path<i32>,
) -> Result<Json<Lesson>, (StatusCode, Json<ErrorResponse>)> {
    let lesson = sqlx::query_as::<_, Lesson>(
        "SELECT l.* FROM lessons l \
         INNER JOIN lesson_status ls ON ls.lesson_id = l.id \
         WHERE l.id = $1 AND ls.status = 'public'",
    )
    .bind(id)
    .fetch_optional(&state.db)
    .await
    .map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: format!("Error al obtener lección: {e}"),
            }),
        )
    })?
    .ok_or((
        StatusCode::NOT_FOUND,
        Json(ErrorResponse {
            error: "Lección no encontrada".to_string(),
        }),
    ))?;

    Ok(Json(lesson))
}

// ---- Progress ----

pub async fn save_progress(
    State(state): State<AppState>,
    Extension(user_id): Extension<Uuid>,
    Json(body): Json<SaveProgressRequest>,
) -> Result<Json<UserProgress>, (StatusCode, Json<ErrorResponse>)> {
    let progress = sqlx::query_as::<_, UserProgress>(
        r#"INSERT INTO user_progress (user_id, lesson_id, score, completed, completed_at)
        VALUES ($1, $2, $3, $4, CASE WHEN $4 THEN NOW() ELSE NULL END)
        ON CONFLICT (user_id, lesson_id)
        DO UPDATE SET
            score = GREATEST(user_progress.score, $3),
            completed = CASE WHEN $4 THEN TRUE ELSE user_progress.completed END,
            completed_at = CASE WHEN $4 THEN NOW() ELSE user_progress.completed_at END,
            updated_at = NOW()
        RETURNING *"#,
    )
    .bind(user_id)
    .bind(body.lesson_id)
    .bind(body.score)
    .bind(body.completed)
    .fetch_one(&state.db)
    .await
    .map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: format!("Error al guardar progreso: {e}"),
            }),
        )
    })?;

    Ok(Json(progress))
}

pub async fn get_progress(
    State(state): State<AppState>,
    Extension(user_id): Extension<Uuid>,
) -> Result<Json<Vec<ProgressWithLesson>>, (StatusCode, Json<ErrorResponse>)> {
    let progress = sqlx::query_as::<_, UserProgress>(
        "SELECT * FROM user_progress WHERE user_id = $1 ORDER BY lesson_id ASC",
    )
    .bind(user_id)
    .fetch_all(&state.db)
    .await
    .map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: format!("Error al obtener progreso: {e}"),
            }),
        )
    })?;

    let mut result = Vec::new();
    for prog in progress {
        if let Ok(lesson) = sqlx::query_as::<_, Lesson>("SELECT * FROM lessons WHERE id = $1")
            .bind(prog.lesson_id)
            .fetch_one(&state.db)
            .await
        {
            result.push(ProgressWithLesson {
                progress: prog,
                lesson,
            });
        }
    }

    Ok(Json(result))
}

pub async fn get_lesson_progress(
    State(state): State<AppState>,
    Extension(user_id): Extension<Uuid>,
    Path(lesson_id): Path<i32>,
) -> Result<Json<UserProgress>, (StatusCode, Json<ErrorResponse>)> {
    let progress = sqlx::query_as::<_, UserProgress>(
        "SELECT * FROM user_progress WHERE user_id = $1 AND lesson_id = $2",
    )
    .bind(user_id)
    .bind(lesson_id)
    .fetch_optional(&state.db)
    .await
    .map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: format!("Error al obtener progreso: {e}"),
            }),
        )
    })?;

    match progress {
        Some(p) => Ok(Json(p)),
        None => Err((
            StatusCode::NOT_FOUND,
            Json(ErrorResponse {
                error: "Progreso no encontrado".to_string(),
            }),
        )),
    }
}

// ---- Admin: Users ----

pub async fn create_admin_user(
    State(state): State<AppState>,
    Extension(_admin_id): Extension<Uuid>,
    Json(body): Json<CreateAdminUserRequest>,
) -> Result<Json<UserPublic>, (StatusCode, Json<ErrorResponse>)> {
    let password_hash = hash(&body.password, DEFAULT_COST).map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: format!("Error al hashear contraseña: {e}"),
            }),
        )
    })?;

    let user = sqlx::query_as::<_, User>(
        "INSERT INTO users (username, email, password_hash, role, email_verified) VALUES ($1, $2, $3, 'admin', true) RETURNING *",
    )
    .bind(&body.username)
    .bind(&body.email)
    .bind(&password_hash)
    .fetch_one(&state.db)
    .await
    .map_err(|e| {
        let status = if e.to_string().contains("unique")
            || e.to_string().contains("duplicate")
        {
            StatusCode::CONFLICT
        } else {
            StatusCode::INTERNAL_SERVER_ERROR
        };
        (
            status,
            Json(ErrorResponse {
                error: format!("Error al crear administrador: {e}"),
            }),
        )
    })?;

    Ok(Json(UserPublic {
        id: user.id,
        username: user.username,
        email: user.email,
        role: user.role,
        email_verified: true,
    }))
}

// ---- Admin: Lessons ----

pub async fn admin_list_lessons(
    State(state): State<AppState>,
) -> Result<Json<Vec<LessonWithStatus>>, (StatusCode, Json<ErrorResponse>)> {
    let min_approvals = get_min_approvals(&state.db).await.unwrap_or(2);

    let lessons = sqlx::query_as::<_, Lesson>("SELECT * FROM lessons ORDER BY order_index ASC")
        .fetch_all(&state.db)
        .await
        .map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ErrorResponse {
                    error: format!("Error al obtener lecciones: {e}"),
                }),
            )
        })?;

    let mut result = Vec::new();
    for lesson in lessons {
        let st = sqlx::query_as::<_, LessonStatus>(
            "SELECT * FROM lesson_status WHERE lesson_id = $1",
        )
        .bind(lesson.id)
        .fetch_optional(&state.db)
        .await
        .unwrap_or(None);

        let approval_count: (i64,) = sqlx::query_as(
            "SELECT COUNT(*) FROM lesson_approvals WHERE lesson_id = $1",
        )
        .bind(lesson.id)
        .fetch_one(&state.db)
        .await
        .unwrap_or((0,));

        result.push(LessonWithStatus {
            lesson,
            status: st.as_ref().map(|s| s.status.clone()).unwrap_or_else(|| "draft".to_string()),
            created_by: st.map(|s| s.created_by).unwrap_or_else(Uuid::nil),
            approval_count: approval_count.0,
            min_approvals,
        });
    }

    Ok(Json(result))
}

pub async fn admin_get_lesson(
    State(state): State<AppState>,
    Path(id): Path<i32>,
) -> Result<Json<LessonWithStatus>, (StatusCode, Json<ErrorResponse>)> {
    let lesson = sqlx::query_as::<_, Lesson>("SELECT * FROM lessons WHERE id = $1")
        .bind(id)
        .fetch_optional(&state.db)
        .await
        .map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ErrorResponse {
                    error: format!("Error al obtener lección: {e}"),
                }),
            )
        })?
        .ok_or((
            StatusCode::NOT_FOUND,
            Json(ErrorResponse {
                error: "Lección no encontrada".to_string(),
            }),
        ))?;

    let status = sqlx::query_as::<_, LessonStatus>(
        "SELECT * FROM lesson_status WHERE lesson_id = $1",
    )
    .bind(lesson.id)
    .fetch_optional(&state.db)
    .await
    .map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: format!("Error al obtener estado: {e}"),
            }),
        )
    })?;

    let config = sqlx::query_as::<_, AppConfig>(
        "SELECT * FROM app_config WHERE key = 'min_approvals'",
    )
    .fetch_optional(&state.db)
    .await
    .map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: format!("Error al obtener configuración: {e}"),
            }),
        )
    })?;

    let min_approvals = config.and_then(|c| c.value.as_i64()).unwrap_or(2);
    let current_status = status
        .as_ref()
        .map(|s| s.status.clone())
        .unwrap_or_else(|| "draft".to_string());
    let created_by = status
        .map(|s| s.created_by)
        .unwrap_or_else(Uuid::nil);

    let approval_count: (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM lesson_approvals WHERE lesson_id = $1",
    )
    .bind(lesson.id)
    .fetch_one(&state.db)
    .await
    .unwrap_or((0,));

    Ok(Json(LessonWithStatus {
        lesson,
        status: current_status,
        created_by,
        approval_count: approval_count.0,
        min_approvals,
    }))
}

pub async fn create_lesson(
    State(state): State<AppState>,
    Extension(admin_id): Extension<Uuid>,
    Json(body): Json<CreateLessonRequest>,
) -> Result<Json<LessonWithStatus>, (StatusCode, Json<ErrorResponse>)> {
    let max_order: (Option<i32>,) =
        sqlx::query_as("SELECT MAX(order_index) FROM lessons")
            .fetch_one(&state.db)
            .await
            .map_err(|e| {
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(ErrorResponse {
                        error: format!("Error al obtener orden: {e}"),
                    }),
                )
            })?;

    let next_order = max_order.0.unwrap_or(0) + 1;

    let lesson = sqlx::query_as::<_, Lesson>(
        "INSERT INTO lessons (title, description, content, difficulty, order_index) \
         VALUES ($1, $2, $3, $4, $5) RETURNING *",
    )
    .bind(&body.title)
    .bind(&body.description.unwrap_or_default())
    .bind(&body.content)
    .bind(&body.difficulty.unwrap_or_else(|| "beginner".to_string()))
    .bind(next_order)
    .fetch_one(&state.db)
    .await
    .map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: format!("Error al crear lección: {e}"),
            }),
        )
    })?;

    sqlx::query(
        "INSERT INTO lesson_status (lesson_id, status, created_by) VALUES ($1, 'draft', $2)",
    )
    .bind(lesson.id)
    .bind(admin_id)
    .execute(&state.db)
    .await
    .map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: format!("Error al crear estado de lección: {e}"),
            }),
        )
    })?;

    let config = sqlx::query_as::<_, AppConfig>(
        "SELECT * FROM app_config WHERE key = 'min_approvals'",
    )
    .fetch_optional(&state.db)
    .await
    .ok()
    .flatten()
    .and_then(|c| c.value.as_i64())
    .unwrap_or(2);

    Ok(Json(LessonWithStatus {
        lesson,
        status: "draft".to_string(),
        created_by: admin_id,
        approval_count: 0,
        min_approvals: config,
    }))
}

pub async fn update_lesson(
    State(state): State<AppState>,
    Path(id): Path<i32>,
    Extension(_): Extension<Uuid>,
    Json(body): Json<UpdateLessonRequest>,
) -> Result<Json<Lesson>, (StatusCode, Json<ErrorResponse>)> {
    let existing: Option<Lesson> =
        sqlx::query_as("SELECT * FROM lessons WHERE id = $1")
            .bind(id)
            .fetch_optional(&state.db)
            .await
            .map_err(|e| {
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(ErrorResponse {
                        error: format!("Error al buscar lección: {e}"),
                    }),
                )
            })?;

    let lesson = match existing {
        Some(l) => l,
        None => {
            return Err((
                StatusCode::NOT_FOUND,
                Json(ErrorResponse {
                    error: "Lección no encontrada".to_string(),
                }),
            ))
        }
    };

    let new_title = body.title.unwrap_or(lesson.title);
    let new_desc = body.description.unwrap_or(lesson.description);
    let new_content = body.content.unwrap_or(lesson.content);
    let new_diff = body.difficulty.unwrap_or(lesson.difficulty);

    let updated = sqlx::query_as::<_, Lesson>(
        "UPDATE lessons SET title = $1, description = $2, content = $3, difficulty = $4 WHERE id = $5 RETURNING *",
    )
    .bind(&new_title)
    .bind(&new_desc)
    .bind(&new_content)
    .bind(&new_diff)
    .bind(id)
    .fetch_one(&state.db)
    .await
    .map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: format!("Error al actualizar lección: {e}"),
            }),
        )
    })?;

    Ok(Json(updated))
}

pub async fn delete_lesson(
    State(state): State<AppState>,
    Path(id): Path<i32>,
    Extension(_): Extension<Uuid>,
) -> Result<StatusCode, (StatusCode, Json<ErrorResponse>)> {
    let result = sqlx::query("DELETE FROM lessons WHERE id = $1")
        .bind(id)
        .execute(&state.db)
        .await
        .map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ErrorResponse {
                    error: format!("Error al eliminar lección: {e}"),
                }),
            )
        })?;

    if result.rows_affected() == 0 {
        return Err((
            StatusCode::NOT_FOUND,
            Json(ErrorResponse {
                error: "Lección no encontrada".to_string(),
            }),
        ));
    }

    Ok(StatusCode::NO_CONTENT)
}

// ---- Admin: Approval Workflow ----

pub async fn submit_lesson(
    State(state): State<AppState>,
    Path(id): Path<i32>,
    Extension(admin_id): Extension<Uuid>,
) -> Result<Json<LessonStatus>, (StatusCode, Json<ErrorResponse>)> {
    let status = sqlx::query_as::<_, LessonStatus>(
        "SELECT * FROM lesson_status WHERE lesson_id = $1",
    )
    .bind(id)
    .fetch_optional(&state.db)
    .await
    .map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: format!("Error al buscar estado: {e}"),
            }),
        )
    })?
    .ok_or((
        StatusCode::NOT_FOUND,
        Json(ErrorResponse {
            error: "Lección no encontrada".to_string(),
        }),
    ))?;

    if status.created_by != admin_id {
        return Err((
            StatusCode::FORBIDDEN,
            Json(ErrorResponse {
                error: "Solo el creador puede enviar la lección a revisión".to_string(),
            }),
        ));
    }

    if status.status != "draft" {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(ErrorResponse {
                error: format!(
                    "No se puede enviar una lección en estado '{}'",
                    status.status
                ),
            }),
        ));
    }

    let updated = sqlx::query_as::<_, LessonStatus>(
        "UPDATE lesson_status SET status = 'pending_approval', updated_at = NOW() WHERE lesson_id = $1 RETURNING *",
    )
    .bind(id)
    .fetch_one(&state.db)
    .await
    .map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: format!("Error al actualizar estado: {e}"),
            }),
        )
    })?;

    Ok(Json(updated))
}

pub async fn approve_lesson(
    State(state): State<AppState>,
    Path(id): Path<i32>,
    Extension(admin_id): Extension<Uuid>,
    Json(body): Json<ApproveLessonRequest>,
) -> Result<Json<ApprovalResult>, (StatusCode, Json<ErrorResponse>)> {
    let status = sqlx::query_as::<_, LessonStatus>(
        "SELECT * FROM lesson_status WHERE lesson_id = $1",
    )
    .bind(id)
    .fetch_optional(&state.db)
    .await
    .map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: format!("Error al buscar estado: {e}"),
            }),
        )
    })?
    .ok_or((
        StatusCode::NOT_FOUND,
        Json(ErrorResponse {
            error: "Lección no encontrada".to_string(),
        }),
    ))?;

    if status.status != "pending_approval" {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(ErrorResponse {
                error: "La lección no está pendiente de aprobación".to_string(),
            }),
        ));
    }

    if status.created_by == admin_id {
        return Err((
            StatusCode::FORBIDDEN,
            Json(ErrorResponse {
                error: "No puedes aprobar tu propia lección".to_string(),
            }),
        ));
    }

    let approval = sqlx::query_as::<_, LessonApproval>(
        "INSERT INTO lesson_approvals (lesson_id, admin_id, comment) VALUES ($1, $2, $3) \
         ON CONFLICT (lesson_id, admin_id) DO UPDATE SET comment = $3 RETURNING *",
    )
    .bind(id)
    .bind(admin_id)
    .bind(&body.comment)
    .fetch_one(&state.db)
    .await
    .map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: format!("Error al aprobar lección: {e}"),
            }),
        )
    })?;

    let config = sqlx::query_as::<_, AppConfig>(
        "SELECT * FROM app_config WHERE key = 'min_approvals'",
    )
    .fetch_optional(&state.db)
    .await
    .ok()
    .flatten()
    .and_then(|c| c.value.as_i64())
    .unwrap_or(2);

    let approval_count: (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM lesson_approvals WHERE lesson_id = $1",
    )
    .bind(id)
    .fetch_one(&state.db)
    .await
    .unwrap_or((0,));

    let new_status = if approval_count.0 >= config {
        sqlx::query(
            "UPDATE lesson_status SET status = 'public', updated_at = NOW() WHERE lesson_id = $1",
        )
        .bind(id)
        .execute(&state.db)
        .await
        .ok();

        "public"
    } else {
        "pending_approval"
    };

    Ok(Json(ApprovalResult {
        approval,
        new_status: new_status.to_string(),
        approval_count: approval_count.0,
        min_approvals: config,
    }))
}

// ---- Admin: Config ----

pub async fn get_config(
    State(state): State<AppState>,
) -> Result<Json<ConfigResponse>, (StatusCode, Json<ErrorResponse>)> {
    let config = sqlx::query_as::<_, AppConfig>(
        "SELECT * FROM app_config WHERE key = 'min_approvals'",
    )
    .fetch_optional(&state.db)
    .await
    .map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: format!("Error al obtener configuración: {e}"),
            }),
        )
    })?;

    let min_approvals = config
        .and_then(|c| c.value.as_i64())
        .unwrap_or(2);

    Ok(Json(ConfigResponse { min_approvals }))
}

pub async fn update_config(
    State(state): State<AppState>,
    Json(body): Json<UpdateConfigRequest>,
) -> Result<Json<ConfigResponse>, (StatusCode, Json<ErrorResponse>)> {
    if body.min_approvals < 1 {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(ErrorResponse {
                error: "El mínimo de aprobaciones debe ser al menos 1".to_string(),
            }),
        ));
    }

    sqlx::query(
        "INSERT INTO app_config (key, value) VALUES ('min_approvals', $1::jsonb) \
         ON CONFLICT (key) DO UPDATE SET value = $1::jsonb",
    )
    .bind(serde_json::json!(body.min_approvals).to_string())
    .execute(&state.db)
    .await
    .map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: format!("Error al actualizar configuración: {e}"),
            }),
        )
    })?;

    Ok(Json(ConfigResponse {
        min_approvals: body.min_approvals,
    }))
}

pub async fn get_pending_approvals(
    State(state): State<AppState>,
) -> Result<Json<Vec<LessonWithStatus>>, (StatusCode, Json<ErrorResponse>)> {
    let min_approvals = get_min_approvals(&state.db).await.unwrap_or(2);

    let pending = sqlx::query_as::<_, Lesson>(
        "SELECT l.* FROM lessons l \
         INNER JOIN lesson_status ls ON ls.lesson_id = l.id \
         WHERE ls.status = 'pending_approval' \
         ORDER BY ls.updated_at ASC",
    )
    .fetch_all(&state.db)
    .await
    .map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: format!("Error al obtener aprobaciones pendientes: {e}"),
            }),
        )
    })?;

    let mut result = Vec::new();
    for lesson in pending {
        let st = sqlx::query_as::<_, LessonStatus>(
            "SELECT * FROM lesson_status WHERE lesson_id = $1",
        )
        .bind(lesson.id)
        .fetch_optional(&state.db)
        .await
        .unwrap_or(None);

        let approval_count: (i64,) = sqlx::query_as(
            "SELECT COUNT(*) FROM lesson_approvals WHERE lesson_id = $1",
        )
        .bind(lesson.id)
        .fetch_one(&state.db)
        .await
        .unwrap_or((0,));

        result.push(LessonWithStatus {
            lesson,
            status: "pending_approval".to_string(),
            created_by: st.map(|s| s.created_by).unwrap_or_else(Uuid::nil),
            approval_count: approval_count.0,
            min_approvals,
        });
    }

    Ok(Json(result))
}

// ---- Admin: Users list ----

pub async fn admin_list_users(
    State(state): State<AppState>,
) -> Result<Json<Vec<AdminUserResponse>>, (StatusCode, Json<ErrorResponse>)> {
    let users = sqlx::query_as::<_, (Uuid, String, String, String, chrono::DateTime<chrono::Utc>)>(
        "SELECT id, username, email, role, created_at FROM users ORDER BY created_at DESC",
    )
    .fetch_all(&state.db)
    .await
    .map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: format!("Error al obtener usuarios: {e}"),
            }),
        )
    })?;

    let mut result = Vec::new();
    for (id, username, email, role, created_at) in users {
        let completed: (i64,) = sqlx::query_as(
            "SELECT COUNT(*) FROM user_progress WHERE user_id = $1 AND completed = true",
        )
        .bind(id)
        .fetch_one(&state.db)
        .await
        .unwrap_or((0,));

        result.push(AdminUserResponse {
            id,
            username,
            email,
            role,
            created_at,
            lessons_completed: completed.0,
        });
    }

    Ok(Json(result))
}

// ---- Change Password ----

pub async fn change_password(
    State(state): State<AppState>,
    Extension(user_id): Extension<Uuid>,
    Json(body): Json<ChangePasswordRequest>,
) -> Result<Json<MessageResponse>, (StatusCode, Json<ErrorResponse>)> {
    if body.new_password.len() < 4 {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(ErrorResponse {
                error: "La nueva contraseña debe tener al menos 4 caracteres".to_string(),
            }),
        ));
    }

    let user = sqlx::query_as::<_, User>("SELECT * FROM users WHERE id = $1")
        .bind(user_id)
        .fetch_optional(&state.db)
        .await
        .map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ErrorResponse {
                    error: format!("Error al buscar usuario: {e}"),
                }),
            )
        })?
        .ok_or((
            StatusCode::NOT_FOUND,
            Json(ErrorResponse {
                error: "Usuario no encontrado".to_string(),
            }),
        ))?;

    let valid = verify(&body.current_password, &user.password_hash).map_err(|_| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: "Error al verificar contraseña".to_string(),
            }),
        )
    })?;

    if !valid {
        return Err((
            StatusCode::UNAUTHORIZED,
            Json(ErrorResponse {
                error: "La contraseña actual no es correcta".to_string(),
            }),
        ));
    }

    let new_hash = hash(&body.new_password, DEFAULT_COST).map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: format!("Error al hashear contraseña: {e}"),
            }),
        )
    })?;

    sqlx::query("UPDATE users SET password_hash = $1 WHERE id = $2")
        .bind(&new_hash)
        .bind(user_id)
        .execute(&state.db)
        .await
        .map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ErrorResponse {
                    error: format!("Error al actualizar contraseña: {e}"),
                }),
            )
        })?;

    Ok(Json(MessageResponse {
        message: "Contraseña actualizada correctamente".to_string(),
    }))
}

// ---- Admin: Stats ----

pub async fn admin_get_stats(
    State(state): State<AppState>,
) -> Result<Json<StatsResponse>, (StatusCode, Json<ErrorResponse>)> {
    let total_users: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM users")
        .fetch_one(&state.db)
        .await
        .unwrap_or((0,));

    let total_lessons: (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM lessons l \
         INNER JOIN lesson_status ls ON ls.lesson_id = l.id \
         WHERE ls.status = 'public'",
    )
    .fetch_one(&state.db)
    .await
    .unwrap_or((0,));

    let total_completions: (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM user_progress WHERE completed = true",
    )
    .fetch_one(&state.db)
    .await
    .unwrap_or((0,));

    let completions_by_lesson = sqlx::query_as::<_, (i32, String, i64)>(
        "SELECT l.id, l.title, COUNT(up.id)::bigint \
         FROM lessons l \
         LEFT JOIN user_progress up ON up.lesson_id = l.id AND up.completed = true \
         GROUP BY l.id, l.title \
         ORDER BY COUNT(up.id) DESC",
    )
    .fetch_all(&state.db)
    .await
    .unwrap_or_default()
    .into_iter()
    .map(|(id, title, count)| LessonCompletionStat {
        lesson_id: id,
        title,
        completions: count,
    })
    .collect();

    let completions_by_difficulty = sqlx::query_as::<_, (String, i64)>(
        "SELECT l.difficulty, COUNT(up.id)::bigint \
         FROM lessons l \
         LEFT JOIN user_progress up ON up.lesson_id = l.id AND up.completed = true \
         GROUP BY l.difficulty \
         ORDER BY l.difficulty",
    )
    .fetch_all(&state.db)
    .await
    .unwrap_or_default()
    .into_iter()
    .map(|(difficulty, count)| DifficultyStat {
        difficulty,
        completions: count,
    })
    .collect();

    Ok(Json(StatsResponse {
        total_users: total_users.0,
        total_lessons: total_lessons.0,
        total_completions: total_completions.0,
        completions_by_lesson,
        completions_by_difficulty,
    }))
}

async fn get_min_approvals(db: &sqlx::PgPool) -> Option<i64> {
    sqlx::query_as::<_, AppConfig>("SELECT * FROM app_config WHERE key = 'min_approvals'")
        .fetch_optional(db)
        .await
        .ok()
        .flatten()
        .and_then(|c| c.value.as_i64())
}

pub async fn log_error(
    State(state): State<AppState>,
    Json(body): Json<LogErrorRequest>,
) -> Result<Json<MessageResponse>, (StatusCode, Json<ErrorResponse>)> {
    sqlx::query(
        "INSERT INTO error_logs (message, page, version, platform) VALUES ($1, $2, $3, $4)",
    )
    .bind(&body.message)
    .bind(&body.page)
    .bind(&body.version)
    .bind(&body.platform)
    .execute(&state.db)
    .await
    .map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: format!("Error al guardar log: {e}"),
            }),
        )
    })?;

    Ok(Json(MessageResponse {
        message: "ok".to_string(),
    }))
}

pub async fn root() -> Html<&'static str> {
    Html(include_str!("../static/index.html"))
}

pub async fn invite_page() -> Html<&'static str> {
    Html(include_str!("../static/invite.html"))
}

pub async fn asset_links() -> (HeaderMap, &'static str) {
    let mut headers = HeaderMap::new();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json"),
    );
    (headers, include_str!("../static/.well-known/assetlinks.json"))
}

pub async fn apple_app_site() -> (HeaderMap, &'static str) {
    let mut headers = HeaderMap::new();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json"),
    );
    (
        headers,
        include_str!("../static/.well-known/apple-app-site-association"),
    )
}

pub async fn download_windows() -> (StatusCode, HeaderMap, Vec<u8>) {
    serve_app_file("piano-virtual.msi", "application/x-msdownload").await
}

pub async fn download_android() -> (StatusCode, HeaderMap, Vec<u8>) {
    serve_app_file("piano-virtual.apk", "application/vnd.android.package-archive").await
}

async fn serve_app_file(filename: &str, mime: &str) -> (StatusCode, HeaderMap, Vec<u8>) {
    let path = format!("{APPS_DIR}/{filename}");
    println!("path {}", path);
    match tokio::fs::read(&path).await {
        Ok(bytes) => {
            let mut headers = HeaderMap::new();
            headers.insert(header::CONTENT_TYPE, HeaderValue::from_str(mime).unwrap());
            let disposition = format!("attachment; filename=\"{filename}\"");
            headers.insert(header::CONTENT_DISPOSITION, HeaderValue::from_str(&disposition).unwrap());
            (StatusCode::OK, headers, bytes)
        }
        Err(_) => {
            let mut headers = HeaderMap::new();
            headers.insert(header::CONTENT_TYPE, HeaderValue::from_static("text/plain; charset=utf-8"));
            (StatusCode::NOT_FOUND, headers, Vec::from("Archivo no disponible"))
        }
    }
}

pub async fn get_app_info(
    State(state): State<AppState>,
    Query(params): Query<HashMap<String, String>>,
) -> Result<Json<AppInfoResponse>, (StatusCode, Json<ErrorResponse>)> {
    let platform = params.get("platform").map(|s| s.as_str()).unwrap_or("windows");
    let key = format!("share_info_{}", platform);

    let config = sqlx::query_as::<_, AppConfig>(
        "SELECT * FROM app_config WHERE key = $1",
    )
    .bind(&key)
    .fetch_optional(&state.db)
    .await
    .map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: format!("Error al obtener info: {e}"),
            }),
        )
    })?
    .ok_or((
        StatusCode::NOT_FOUND,
        Json(ErrorResponse {
            error: "No hay información disponible para esta plataforma".to_string(),
        }),
    ))?;

    let info: AppInfoResponse = serde_json::from_value(config.value).map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: format!("Error al parsear info: {e}"),
            }),
        )
    })?;

    Ok(Json(info))
}

// ---- Friends ----

pub async fn search_users(
    State(state): State<AppState>,
    Extension(user_id): Extension<Uuid>,
    Query(params): Query<HashMap<String, String>>,
) -> Result<Json<Vec<UserSearchResult>>, (StatusCode, Json<ErrorResponse>)> {
    let q = params.get("q").map(|s| s.as_str()).unwrap_or("");
    if q.is_empty() {
        return Ok(Json(vec![]));
    }

    let users = sqlx::query_as::<_, UserSearchResult>(
        "SELECT id, username FROM users WHERE username ILIKE $1 AND id != $2 LIMIT 10",
    )
    .bind(format!("%{}%", q))
    .bind(user_id)
    .fetch_all(&state.db)
    .await
    .map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: format!("Error al buscar usuarios: {e}"),
            }),
        )
    })?;

    Ok(Json(users))
}

pub async fn send_friend_request(
    State(state): State<AppState>,
    Extension(user_id): Extension<Uuid>,
    Json(body): Json<FriendRequestPayload>,
) -> Result<Json<MessageResponse>, (StatusCode, Json<ErrorResponse>)> {
    let receiver = if let Some(id) = body.user_id {
        sqlx::query_as::<_, User>("SELECT * FROM users WHERE id = $1")
            .bind(id)
            .fetch_optional(&state.db)
            .await
            .map_err(|e| {
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(ErrorResponse { error: format!("Error: {e}") }),
                )
            })?
            .ok_or((
                StatusCode::NOT_FOUND,
                Json(ErrorResponse {
                    error: "Usuario no encontrado".to_string(),
                }),
            ))?
    } else if let Some(ref username) = body.username {
        sqlx::query_as::<_, User>("SELECT * FROM users WHERE username = $1")
            .bind(username)
            .fetch_optional(&state.db)
            .await
            .map_err(|e| {
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(ErrorResponse { error: format!("Error: {e}") }),
                )
            })?
            .ok_or((
                StatusCode::NOT_FOUND,
                Json(ErrorResponse {
                    error: "Usuario no encontrado".to_string(),
                }),
            ))?
    } else {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(ErrorResponse {
                error: "Debes proporcionar username o user_id".to_string(),
            }),
        ));
    };

    if receiver.id == user_id {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(ErrorResponse {
                error: "No puedes enviarte solicitud a ti mismo".to_string(),
            }),
        ));
    }

    // Check latest request to this user
    let existing = sqlx::query_as::<_, (Uuid, String)>(
        "SELECT id, status FROM friend_requests WHERE sender_id = $1 AND receiver_id = $2 ORDER BY created_at DESC LIMIT 1",
    )
    .bind(user_id)
    .bind(receiver.id)
    .fetch_optional(&state.db)
    .await
    .map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse { error: format!("Error: {e}") }),
        )
    })?;

    if let Some((req_id, status)) = existing {
        match status.as_str() {
            "pending" | "accepted" => {
                return Err((
                    StatusCode::CONFLICT,
                    Json(ErrorResponse {
                        error: "Ya enviaste una solicitud a este usuario".to_string(),
                    }),
                ));
            }
            "rejected" => {
                let today_count = sqlx::query_scalar::<_, i64>(
                    "SELECT COUNT(*) FROM friend_requests WHERE sender_id = $1 AND receiver_id = $2 AND created_at::date = CURRENT_DATE",
                )
                .bind(user_id)
                .bind(receiver.id)
                .fetch_one(&state.db)
                .await
                .map_err(|e| {
                    (
                        StatusCode::INTERNAL_SERVER_ERROR,
                        Json(ErrorResponse { error: format!("Error: {e}") }),
                    )
                })?;

                if today_count >= 3 {
                    return Err((
                        StatusCode::CONFLICT,
                        Json(ErrorResponse {
                            error: "Solo puedes enviar 3 solicitudes por día a este usuario".to_string(),
                        }),
                    ));
                }

                // Re-activate the most recent rejected request
                sqlx::query(
                    "UPDATE friend_requests SET status = 'pending', created_at = NOW(), updated_at = NOW() WHERE id = $1",
                )
                .bind(req_id)
                .execute(&state.db)
                .await
                .map_err(|e| {
                    (
                        StatusCode::INTERNAL_SERVER_ERROR,
                        Json(ErrorResponse { error: format!("Error: {e}") }),
                    )
                })?;

                return Ok(Json(MessageResponse {
                    message: "Solicitud enviada".to_string(),
                }));
            }
            _ => {}
        }
    }

    let reverse = sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM friend_requests WHERE sender_id = $1 AND receiver_id = $2",
    )
    .bind(receiver.id)
    .bind(user_id)
    .fetch_one(&state.db)
    .await
    .map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse { error: format!("Error: {e}") }),
        )
    })?;

    if reverse > 0 {
        return Err((
            StatusCode::CONFLICT,
            Json(ErrorResponse {
                error: "Este usuario ya te envió una solicitud".to_string(),
            }),
        ));
    }

    sqlx::query(
        "INSERT INTO friend_requests (sender_id, receiver_id) VALUES ($1, $2)",
    )
    .bind(user_id)
    .bind(receiver.id)
    .execute(&state.db)
    .await
    .map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse { error: format!("Error: {e}") }),
        )
    })?;

    Ok(Json(MessageResponse {
        message: "Solicitud enviada".to_string(),
    }))
}

pub async fn get_pending_requests(
    State(state): State<AppState>,
    Extension(user_id): Extension<Uuid>,
) -> Result<Json<Vec<PendingRequest>>, (StatusCode, Json<ErrorResponse>)> {
    let requests = sqlx::query_as::<_, PendingRequest>(
        r#"SELECT fr.id, fr.sender_id, u.username AS sender_username, fr.created_at
           FROM friend_requests fr
           JOIN users u ON u.id = fr.sender_id
           WHERE fr.receiver_id = $1 AND fr.status = 'pending'
           ORDER BY fr.created_at DESC"#,
    )
    .bind(user_id)
    .fetch_all(&state.db)
    .await
    .map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: format!("Error al obtener solicitudes: {e}"),
            }),
        )
    })?;

    Ok(Json(requests))
}

pub async fn accept_friend_request(
    State(state): State<AppState>,
    Extension(user_id): Extension<Uuid>,
    Path(request_id): Path<Uuid>,
) -> Result<Json<MessageResponse>, (StatusCode, Json<ErrorResponse>)> {
    let result = sqlx::query(
        "UPDATE friend_requests SET status = 'accepted', updated_at = NOW() WHERE id = $1 AND receiver_id = $2 AND status = 'pending'",
    )
    .bind(request_id)
    .bind(user_id)
    .execute(&state.db)
    .await
    .map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse { error: format!("Error: {e}") }),
        )
    })?;

    if result.rows_affected() == 0 {
        return Err((
            StatusCode::NOT_FOUND,
            Json(ErrorResponse {
                error: "Solicitud no encontrada".to_string(),
            }),
        ));
    }

    Ok(Json(MessageResponse {
        message: "Solicitud aceptada".to_string(),
    }))
}

pub async fn reject_friend_request(
    State(state): State<AppState>,
    Extension(user_id): Extension<Uuid>,
    Path(request_id): Path<Uuid>,
) -> Result<Json<MessageResponse>, (StatusCode, Json<ErrorResponse>)> {
    let result = sqlx::query(
        "UPDATE friend_requests SET status = 'rejected', updated_at = NOW() WHERE id = $1 AND receiver_id = $2 AND status = 'pending'",
    )
    .bind(request_id)
    .bind(user_id)
    .execute(&state.db)
    .await
    .map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse { error: format!("Error: {e}") }),
        )
    })?;

    if result.rows_affected() == 0 {
        return Err((
            StatusCode::NOT_FOUND,
            Json(ErrorResponse {
                error: "Solicitud no encontrada".to_string(),
            }),
        ));
    }

    Ok(Json(MessageResponse {
        message: "Solicitud rechazada".to_string(),
    }))
}

pub async fn list_friends(
    State(state): State<AppState>,
    Extension(user_id): Extension<Uuid>,
) -> Result<Json<Vec<FriendWithUser>>, (StatusCode, Json<ErrorResponse>)> {
    let friends = sqlx::query_as::<_, FriendWithUser>(
        r#"SELECT
            CASE WHEN fr.sender_id = $1 THEN fr.receiver_id ELSE fr.sender_id END AS friend_id,
            u.username,
            GREATEST(fr.created_at, fr.updated_at) AS since,
            COALESCE(u.last_active_at > NOW() - INTERVAL '2 minutes', false) AS is_active
           FROM friend_requests fr
           JOIN users u ON u.id = CASE WHEN fr.sender_id = $1 THEN fr.receiver_id ELSE fr.sender_id END
           WHERE (fr.sender_id = $1 OR fr.receiver_id = $1) AND fr.status = 'accepted'
           ORDER BY since DESC"#,
    )
    .bind(user_id)
    .fetch_all(&state.db)
    .await
    .map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: format!("Error al obtener amigos: {e}"),
            }),
        )
    })?;

    Ok(Json(friends))
}

pub async fn ping() -> Result<Json<serde_json::Value>, (StatusCode, Json<ErrorResponse>)> {
    Ok(Json(json!({"ok": true})))
}

pub async fn get_key_mappings(
    State(state): State<AppState>,
    Extension(user_id): Extension<Uuid>,
) -> Result<Json<KeyMappingsResponse>, (StatusCode, Json<ErrorResponse>)> {
    let row = sqlx::query_as::<_, (serde_json::Value, serde_json::Value)>(
        "SELECT mappings, preferences FROM key_mappings WHERE user_id = $1",
    )
    .bind(user_id)
    .fetch_optional(&state.db)
    .await
    .map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse { error: format!("Error: {e}") }),
        )
    })?;

    let (mappings, preferences) = row.map(|r| (r.0, r.1)).unwrap_or((json!({}), json!({})));
    Ok(Json(KeyMappingsResponse { mappings, preferences }))
}

pub async fn save_key_mappings(
    State(state): State<AppState>,
    Extension(user_id): Extension<Uuid>,
    Json(body): Json<KeyMappingsPayload>,
) -> Result<Json<MessageResponse>, (StatusCode, Json<ErrorResponse>)> {
    let preferences = body.preferences.unwrap_or(json!({}));
    sqlx::query(
        r#"INSERT INTO key_mappings (user_id, mappings, preferences, updated_at)
           VALUES ($1, $2, $3, NOW())
           ON CONFLICT (user_id)
           DO UPDATE SET mappings = $2, preferences = $3, updated_at = NOW()"#,
    )
    .bind(user_id)
    .bind(&body.mappings)
    .bind(&preferences)
    .execute(&state.db)
    .await
    .map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse { error: format!("Error: {e}") }),
        )
    })?;

    Ok(Json(MessageResponse {
        message: "Mapeo guardado".to_string(),
    }))
}

fn generate_session_code() -> String {
    let chars: Vec<char> = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789".chars().collect();
    let mut rng = rand::thread_rng();
    (0..6).map(|_| chars[rng.gen_range(0..chars.len())]).collect()
}

async fn are_friends(db: &sqlx::PgPool, user_a: Uuid, user_b: Uuid) -> Result<bool, sqlx::Error> {
    let count = sqlx::query_scalar::<_, i64>(
        r#"SELECT COUNT(*) FROM friend_requests
           WHERE ((sender_id = $1 AND receiver_id = $2) OR (sender_id = $2 AND receiver_id = $1))
           AND status = 'accepted'"#,
    )
    .bind(user_a)
    .bind(user_b)
    .fetch_one(db)
    .await?;
    Ok(count > 0)
}

pub async fn create_multiplayer_session(
    State(state): State<AppState>,
    Extension(user_id): Extension<Uuid>,
    Json(body): Json<CreateSessionRequest>,
) -> Result<Json<SessionWithParticipants>, (StatusCode, Json<ErrorResponse>)> {
    let lesson = sqlx::query_as::<_, Lesson>("SELECT * FROM lessons WHERE id = $1")
        .bind(body.lesson_id)
        .fetch_optional(&state.db)
        .await
        .map_err(|e| internal_error(e))?
        .ok_or(not_found("Lección no encontrada"))?;

    let mut code;
    let mut attempts = 0;
    loop {
        code = generate_session_code();
        let exists = sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*) FROM multiplayer_sessions WHERE code = $1",
        )
        .bind(&code)
        .fetch_one(&state.db)
        .await
        .map_err(|e| internal_error(e))?;
        if exists == 0 {
            break;
        }
        attempts += 1;
        if attempts > 10 {
            return Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ErrorResponse {
                    error: "Error al generar código".to_string(),
                }),
            ));
        }
    }

    let session = sqlx::query_as::<_, MultiplayerSession>(
        r#"INSERT INTO multiplayer_sessions (host_id, lesson_id, code)
           VALUES ($1, $2, $3) RETURNING *"#,
    )
    .bind(user_id)
    .bind(lesson.id)
    .bind(&code)
    .fetch_one(&state.db)
    .await
    .map_err(|e| internal_error(e))?;

    sqlx::query(
        "INSERT INTO multiplayer_participants (session_id, user_id) VALUES ($1, $2)",
    )
    .bind(session.id)
    .bind(user_id)
    .execute(&state.db)
    .await
    .map_err(|e| internal_error(e))?;

    let host = sqlx::query_as::<_, User>("SELECT * FROM users WHERE id = $1")
        .bind(user_id)
        .fetch_one(&state.db)
        .await
        .map_err(|e| internal_error(e))?;

    let host_username = host.username.clone();

    let participants = vec![ParticipantWithUser {
        user_id,
        username: host.username,
        score: 0.0,
        perfects: 0,
        goods: 0,
        lates: 0,
        misses: 0,
        completed: false,
        joined_at: chrono::Utc::now(),
        finished_at: None,
    }];

    Ok(Json(SessionWithParticipants {
        session,
        host_username,
        participants,
    }))
}

pub async fn join_multiplayer_session(
    State(state): State<AppState>,
    Extension(user_id): Extension<Uuid>,
    Json(body): Json<JoinSessionRequest>,
) -> Result<Json<SessionWithParticipants>, (StatusCode, Json<ErrorResponse>)> {
    let session = sqlx::query_as::<_, MultiplayerSession>(
        "SELECT * FROM multiplayer_sessions WHERE code = $1",
    )
    .bind(&body.code)
    .fetch_optional(&state.db)
    .await
    .map_err(|e| internal_error(e))?
    .ok_or(not_found("Sesión no encontrada"))?;

    if session.status != "waiting" {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(ErrorResponse {
                error: "La sesión ya ha comenzado o ha finalizado".to_string(),
            }),
        ));
    }

    if session.host_id == user_id {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(ErrorResponse {
                error: "Eres el anfitrión de esta sesión".to_string(),
            }),
        ));
    }

    let friends = are_friends(&state.db, user_id, session.host_id)
        .await
        .map_err(|e| internal_error(e))?;
    if !friends {
        return Err((
            StatusCode::FORBIDDEN,
            Json(ErrorResponse {
                error: "Debes ser amigo del anfitrión para unirte".to_string(),
            }),
        ));
    }

    let existing = sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM multiplayer_participants WHERE session_id = $1 AND user_id = $2",
    )
    .bind(session.id)
    .bind(user_id)
    .fetch_one(&state.db)
    .await
    .map_err(|e| internal_error(e))?;

    if existing == 0 {
        sqlx::query(
            "INSERT INTO multiplayer_participants (session_id, user_id) VALUES ($1, $2)",
        )
        .bind(session.id)
        .bind(user_id)
        .execute(&state.db)
        .await
        .map_err(|e| internal_error(e))?;
    }

    let host = sqlx::query_as::<_, User>("SELECT * FROM users WHERE id = $1")
        .bind(session.host_id)
        .fetch_one(&state.db)
        .await
        .map_err(|e| internal_error(e))?;

    let participants = sqlx::query_as::<_, ParticipantWithUser>(
        r#"SELECT mp.user_id, u.username, mp.score, mp.perfects, mp.goods, mp.lates,
                  mp.misses, mp.completed, mp.joined_at, mp.finished_at
           FROM multiplayer_participants mp
           JOIN users u ON u.id = mp.user_id
           WHERE mp.session_id = $1
           ORDER BY mp.joined_at ASC"#,
    )
    .bind(session.id)
    .fetch_all(&state.db)
    .await
    .map_err(|e| internal_error(e))?;

    Ok(Json(SessionWithParticipants {
        session,
        host_username: host.username,
        participants,
    }))
}

pub async fn leave_multiplayer_session(
    State(state): State<AppState>,
    Extension(user_id): Extension<Uuid>,
    Json(body): Json<LeaveSessionRequest>,
) -> Result<Json<MessageResponse>, (StatusCode, Json<ErrorResponse>)> {
    let session = sqlx::query_as::<_, MultiplayerSession>(
        "SELECT * FROM multiplayer_sessions WHERE id = $1",
    )
    .bind(body.session_id)
    .fetch_optional(&state.db)
    .await
    .map_err(|e| internal_error(e))?
    .ok_or(not_found("Sesión no encontrada"))?;

    if session.host_id == user_id {
        sqlx::query("UPDATE multiplayer_sessions SET status = 'cancelled' WHERE id = $1")
            .bind(session.id)
            .execute(&state.db)
            .await
            .map_err(|e| internal_error(e))?;
    } else {
        sqlx::query(
            "DELETE FROM multiplayer_participants WHERE session_id = $1 AND user_id = $2",
        )
        .bind(session.id)
        .bind(user_id)
        .execute(&state.db)
        .await
        .map_err(|e| internal_error(e))?;
    }

    Ok(Json(MessageResponse {
        message: "Has abandonado la sesión".to_string(),
    }))
}

pub async fn start_multiplayer_session(
    State(state): State<AppState>,
    Extension(user_id): Extension<Uuid>,
    Path(session_id): Path<Uuid>,
) -> Result<Json<SessionWithParticipants>, (StatusCode, Json<ErrorResponse>)> {
    let session = sqlx::query_as::<_, MultiplayerSession>(
        "SELECT * FROM multiplayer_sessions WHERE id = $1",
    )
    .bind(session_id)
    .fetch_optional(&state.db)
    .await
    .map_err(|e| internal_error(e))?
    .ok_or(not_found("Sesión no encontrada"))?;

    if session.host_id != user_id {
        return Err((
            StatusCode::FORBIDDEN,
            Json(ErrorResponse {
                error: "Solo el anfitrión puede iniciar la sesión".to_string(),
            }),
        ));
    }

    if session.status != "waiting" {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(ErrorResponse {
                error: "La sesión ya ha comenzado o finalizado".to_string(),
            }),
        ));
    }

    sqlx::query(
        "UPDATE multiplayer_sessions SET status = 'playing', started_at = NOW() WHERE id = $1",
    )
    .bind(session.id)
    .execute(&state.db)
    .await
    .map_err(|e| internal_error(e))?;

    let updated = sqlx::query_as::<_, MultiplayerSession>(
        "SELECT * FROM multiplayer_sessions WHERE id = $1",
    )
    .bind(session.id)
    .fetch_one(&state.db)
    .await
    .map_err(|e| internal_error(e))?;

    let host = sqlx::query_as::<_, User>("SELECT * FROM users WHERE id = $1")
        .bind(updated.host_id)
        .fetch_one(&state.db)
        .await
        .map_err(|e| internal_error(e))?;

    let participants = sqlx::query_as::<_, ParticipantWithUser>(
        r#"SELECT mp.user_id, u.username, mp.score, mp.perfects, mp.goods, mp.lates,
                  mp.misses, mp.completed, mp.joined_at, mp.finished_at
           FROM multiplayer_participants mp
           JOIN users u ON u.id = mp.user_id
           WHERE mp.session_id = $1
           ORDER BY mp.joined_at ASC"#,
    )
    .bind(updated.id)
    .fetch_all(&state.db)
    .await
    .map_err(|e| internal_error(e))?;

    Ok(Json(SessionWithParticipants {
        session: updated,
        host_username: host.username,
        participants,
    }))
}

pub async fn submit_multiplayer_score(
    State(state): State<AppState>,
    Extension(user_id): Extension<Uuid>,
    Json(body): Json<SubmitScoreRequest>,
) -> Result<Json<SessionWithParticipants>, (StatusCode, Json<ErrorResponse>)> {
    let result = sqlx::query(
        r#"UPDATE multiplayer_participants
           SET score = $1, perfects = $2, goods = $3, lates = $4, misses = $5,
               completed = TRUE, finished_at = NOW()
           WHERE session_id = $6 AND user_id = $7"#,
    )
    .bind(body.score)
    .bind(body.perfects)
    .bind(body.goods)
    .bind(body.lates)
    .bind(body.misses)
    .bind(body.session_id)
    .bind(user_id)
    .execute(&state.db)
    .await
    .map_err(|e| internal_error(e))?;

    if result.rows_affected() == 0 {
        return Err(not_found("No eres participante de esta sesión"));
    }

    // Check if all participants have finished
    let session = sqlx::query_as::<_, MultiplayerSession>(
        "SELECT * FROM multiplayer_sessions WHERE id = $1",
    )
    .bind(body.session_id)
    .fetch_optional(&state.db)
    .await
    .map_err(|e| internal_error(e))?
    .ok_or(not_found("Sesión no encontrada"))?;

    if session.status == "playing" {
        let remaining = sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*) FROM multiplayer_participants WHERE session_id = $1 AND completed = FALSE",
        )
        .bind(body.session_id)
        .fetch_one(&state.db)
        .await
        .map_err(|e| internal_error(e))?;

        if remaining == 0 {
            sqlx::query(
                "UPDATE multiplayer_sessions SET status = 'finished', finished_at = NOW() WHERE id = $1",
            )
            .bind(body.session_id)
            .execute(&state.db)
            .await
            .map_err(|e| internal_error(e))?;

            // Update streaks for all participant pairs
            let participant_ids = sqlx::query_scalar::<_, Uuid>(
                "SELECT user_id FROM multiplayer_participants WHERE session_id = $1 AND completed = TRUE ORDER BY user_id",
            )
            .bind(body.session_id)
            .fetch_all(&state.db)
            .await
            .map_err(|e| internal_error(e))?;

            for i in 0..participant_ids.len() {
                for j in (i + 1)..participant_ids.len() {
                    let uid1 = participant_ids[i];
                    let uid2 = participant_ids[j];
                    sqlx::query(
                        r#"INSERT INTO user_streaks (first_user_id, second_user_id, streak_days, last_practice_date)
                           VALUES ($1, $2, 1, CURRENT_DATE)
                           ON CONFLICT (first_user_id, second_user_id) DO UPDATE SET
                               streak_days = CASE
                                   WHEN user_streaks.last_practice_date = CURRENT_DATE - 1 THEN user_streaks.streak_days + 1
                                   WHEN user_streaks.last_practice_date = CURRENT_DATE THEN user_streaks.streak_days
                                   ELSE 1
                               END,
                               last_practice_date = CURRENT_DATE"#,
                    )
                    .bind(uid1)
                    .bind(uid2)
                    .execute(&state.db)
                    .await
                    .map_err(|e| internal_error(e))?;
                }
            }
        }
    }

    // Re-fetch session with updated status
    let updated = sqlx::query_as::<_, MultiplayerSession>(
        "SELECT * FROM multiplayer_sessions WHERE id = $1",
    )
    .bind(body.session_id)
    .fetch_one(&state.db)
    .await
    .map_err(|e| internal_error(e))?;

    let host = sqlx::query_as::<_, User>("SELECT * FROM users WHERE id = $1")
        .bind(updated.host_id)
        .fetch_one(&state.db)
        .await
        .map_err(|e| internal_error(e))?;

    let participants = sqlx::query_as::<_, ParticipantWithUser>(
        r#"SELECT mp.user_id, u.username, mp.score, mp.perfects, mp.goods, mp.lates,
                  mp.misses, mp.completed, mp.joined_at, mp.finished_at
           FROM multiplayer_participants mp
           JOIN users u ON u.id = mp.user_id
           WHERE mp.session_id = $1
           ORDER BY mp.score DESC, mp.joined_at ASC"#,
    )
    .bind(updated.id)
    .fetch_all(&state.db)
    .await
    .map_err(|e| internal_error(e))?;

    Ok(Json(SessionWithParticipants {
        session: updated,
        host_username: host.username,
        participants,
    }))
}

pub async fn get_multiplayer_session(
    State(state): State<AppState>,
    Extension(user_id): Extension<Uuid>,
    Path(session_id): Path<Uuid>,
) -> Result<Json<SessionWithParticipants>, (StatusCode, Json<ErrorResponse>)> {
    let session = sqlx::query_as::<_, MultiplayerSession>(
        "SELECT * FROM multiplayer_sessions WHERE id = $1",
    )
    .bind(session_id)
    .fetch_optional(&state.db)
    .await
    .map_err(|e| internal_error(e))?
    .ok_or(not_found("Sesión no encontrada"))?;

    let participant = sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM multiplayer_participants WHERE session_id = $1 AND user_id = $2",
    )
    .bind(session_id)
    .bind(user_id)
    .fetch_one(&state.db)
    .await
    .map_err(|e| internal_error(e))?;

    if participant == 0 && session.host_id != user_id {
        return Err((
            StatusCode::FORBIDDEN,
            Json(ErrorResponse {
                error: "No eres participante de esta sesión".to_string(),
            }),
        ));
    }

    let host = sqlx::query_as::<_, User>("SELECT * FROM users WHERE id = $1")
        .bind(session.host_id)
        .fetch_one(&state.db)
        .await
        .map_err(|e| internal_error(e))?;

    let participants = sqlx::query_as::<_, ParticipantWithUser>(
        r#"SELECT mp.user_id, u.username, mp.score, mp.perfects, mp.goods, mp.lates,
                  mp.misses, mp.completed, mp.joined_at, mp.finished_at
           FROM multiplayer_participants mp
           JOIN users u ON u.id = mp.user_id
           WHERE mp.session_id = $1
           ORDER BY mp.score DESC, mp.joined_at ASC"#,
    )
    .bind(session_id)
    .fetch_all(&state.db)
    .await
    .map_err(|e| internal_error(e))?;

    Ok(Json(SessionWithParticipants {
        session,
        host_username: host.username,
        participants,
    }))
}

pub async fn get_user_streaks(
    State(state): State<AppState>,
    Extension(user_id): Extension<Uuid>,
) -> Result<Json<Vec<StreakWithUser>>, (StatusCode, Json<ErrorResponse>)> {
    let streaks = sqlx::query_as::<_, StreakWithUser>(
        r#"SELECT
               CASE WHEN us.first_user_id = $1 THEN us.second_user_id ELSE us.first_user_id END AS user_id,
               u.username,
               us.streak_days,
               us.last_practice_date
           FROM user_streaks us
           JOIN users u ON u.id = CASE WHEN us.first_user_id = $1 THEN us.second_user_id ELSE us.first_user_id END
           WHERE us.first_user_id = $1 OR us.second_user_id = $1
           ORDER BY us.streak_days DESC, u.username ASC"#,
    )
    .bind(user_id)
    .fetch_all(&state.db)
    .await
    .map_err(|e| internal_error(e))?;

    Ok(Json(streaks))
}

pub async fn get_my_multiplayer_sessions(
    State(state): State<AppState>,
    Extension(user_id): Extension<Uuid>,
) -> Result<Json<Vec<SessionWithParticipants>>, (StatusCode, Json<ErrorResponse>)> {
    let sessions = sqlx::query_as::<_, MultiplayerSession>(
        r#"SELECT ms.* FROM multiplayer_sessions ms
           INNER JOIN multiplayer_participants mp ON mp.session_id = ms.id
           WHERE mp.user_id = $1 AND ms.status IN ('waiting', 'playing')
           ORDER BY ms.created_at DESC"#,
    )
    .bind(user_id)
    .fetch_all(&state.db)
    .await
    .map_err(|e| internal_error(e))?;

    let mut result = Vec::new();
    for session in sessions {
        let host = sqlx::query_as::<_, User>("SELECT * FROM users WHERE id = $1")
            .bind(session.host_id)
            .fetch_one(&state.db)
            .await
            .map_err(|e| internal_error(e))?;

        let participants = sqlx::query_as::<_, ParticipantWithUser>(
            r#"SELECT mp.user_id, u.username, mp.score, mp.perfects, mp.goods, mp.lates,
                      mp.misses, mp.completed, mp.joined_at, mp.finished_at
               FROM multiplayer_participants mp
               JOIN users u ON u.id = mp.user_id
               WHERE mp.session_id = $1
               ORDER BY mp.joined_at ASC"#,
        )
        .bind(session.id)
        .fetch_all(&state.db)
        .await
        .map_err(|e| internal_error(e))?;

        result.push(SessionWithParticipants {
            session,
            host_username: host.username,
            participants,
        });
    }

    Ok(Json(result))
}

pub async fn delete_account(
    State(state): State<AppState>,
    Extension(user_id): Extension<Uuid>,
) -> Result<Json<MessageResponse>, (StatusCode, Json<ErrorResponse>)> {
    let db = &state.db;

    for q in [
        "DELETE FROM user_progress WHERE user_id = $1",
        "DELETE FROM friend_requests WHERE sender_id = $1 OR receiver_id = $1",
        "DELETE FROM friends WHERE user_id = $1 OR friend_id = $1",
        "DELETE FROM multiplayer_participants WHERE user_id = $1",
        "DELETE FROM multiplayer_sessions WHERE host_id = $1",
        "DELETE FROM user_streaks WHERE first_user_id = $1 OR second_user_id = $1",
        "DELETE FROM key_mappings WHERE user_id = $1",
        "DELETE FROM user_preferences WHERE user_id = $1",
        "DELETE FROM lesson_status WHERE created_by = $1",
        "DELETE FROM audit_logs WHERE user_id = $1",
    ] {
        sqlx::query(q).bind(&user_id).execute(db).await.ok();
    }

    sqlx::query("DELETE FROM users WHERE id = $1")
        .bind(&user_id)
        .execute(db)
        .await
        .map_err(|e| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ErrorResponse {
                    error: format!("Error al eliminar cuenta: {e}"),
                }),
            )
        })?;

    Ok(Json(MessageResponse {
        message: "Cuenta eliminada correctamente.".to_string(),
    }))
}

fn internal_error<E: std::fmt::Display>(e: E) -> (StatusCode, Json<ErrorResponse>) {
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(ErrorResponse {
            error: format!("Error interno: {e}"),
        }),
    )
}

fn not_found(msg: &str) -> (StatusCode, Json<ErrorResponse>) {
    (
        StatusCode::NOT_FOUND,
        Json(ErrorResponse {
            error: msg.to_string(),
        }),
    )
}

