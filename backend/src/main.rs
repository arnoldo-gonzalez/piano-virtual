mod audit;
mod auth;
mod email;
mod handlers;
mod models;

use axum::{
    middleware,
    routing::{get, post},
    Router,
};
use sqlx::PgPool;
use tower_http::cors::{Any, CorsLayer};
use tower_http::services::ServeDir;

use crate::email::MailConfig;
use crate::models::User;

const STATIC_DIR: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/static");

#[derive(Clone)]
pub struct AppState {
    pub db: PgPool,
    pub mail_config: Option<MailConfig>,
}

#[tokio::main]
async fn main() {
    dotenvy::from_filename(
        concat!(env!("CARGO_MANIFEST_DIR"), "/.env"),
    )
    .ok();
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    let database_url = std::env::var("DATABASE_URL")
        .unwrap_or_else(|_| "postgresql://admin:admin@localhost:5433/piano_virtual".to_string());

    println!("DATABASE {}", database_url);
    
    let host = std::env::var("IP").unwrap_or_else(|_| "fd00::7:6953".to_string());
    tracing::info!("HOST NAME (WAS FROM ENV VAR IP OR DEF VALUE {}", host);
    
    let port = std::env::var("PORT").unwrap_or_else(|_| "3000".to_string());
    let bind_addr = format!("{host}:{port}");

    let pool = loop {
        match PgPool::connect(&database_url).await {
            Ok(p) => break p,
            Err(e) => {
                tracing::error!("Error al conectar a la base de datos: {e}. Reintentando en 5s...");
                tokio::time::sleep(std::time::Duration::from_secs(5)).await;
            }
        }
    };

    let migrator = sqlx::migrate!("./migrations");
    for attempt in 1..=5 {
        match migrator.run(&pool).await {
            Ok(_) => break,
            Err(e) => {
                if attempt == 5 {
                    tracing::error!("Error al ejecutar migraciones tras 5 intentos: {e}");
                } else {
                    tracing::warn!("Error en migración (intento {attempt}/5): {e}. Reintentando...");
                    tokio::time::sleep(std::time::Duration::from_secs(3)).await;
                }
            }
        }
    }

    ensure_admin_exists(&pool).await;
    ensure_seed_lessons_public(&pool).await;

    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    let mail_config = MailConfig::from_env();
    if mail_config.is_some() {
        tracing::info!("SMTP configurado correctamente");
    } else {
        tracing::warn!("SMTP no configurado — los códigos de verificación se mostrarán en el log");
    }

    let state = AppState { db: pool, mail_config };

    let public_routes = Router::new()
        .route("/", get(handlers::root))
        .route("/api/register", post(handlers::register))
        .route("/api/login", post(handlers::login))
        .route("/api/lessons", get(handlers::list_lessons))
        .route("/api/lessons/{id}", get(handlers::get_lesson))
        .route("/api/log-error", post(handlers::log_error))
        .route("/api/app-info", get(handlers::get_app_info))
        .route("/api/verify-email", post(handlers::verify_email))
        .route("/api/resend-code", post(handlers::resend_code))
        .route("/api/download/windows", get(handlers::download_windows))
        .route("/api/download/android", get(handlers::download_android))
        .route("/invite/{code}", get(handlers::invite_page))
        .route("/invite", get(handlers::invite_page))
        .route("/.well-known/assetlinks.json", get(handlers::asset_links))
        .route(
            "/.well-known/apple-app-site-association",
            get(handlers::apple_app_site),
        );

    let protected_routes = Router::new()
        .route("/api/progress", post(handlers::save_progress))
        .route("/api/progress", get(handlers::get_progress))
        .route("/api/progress/{lesson_id}", get(handlers::get_lesson_progress))
        .route("/api/change-password", post(handlers::change_password))
        .route("/api/users/search", get(handlers::search_users))
        .route("/api/friends/request", post(handlers::send_friend_request))
        .route("/api/friends/requests", get(handlers::get_pending_requests))
        .route("/api/friends/accept/{request_id}", post(handlers::accept_friend_request))
        .route("/api/friends/reject/{request_id}", post(handlers::reject_friend_request))
        .route("/api/friends", get(handlers::list_friends))
        .route("/api/ping", get(handlers::ping))
        .route("/api/key-mappings", get(handlers::get_key_mappings).put(handlers::save_key_mappings))
        .route("/api/multiplayer/create", post(handlers::create_multiplayer_session))
        .route("/api/multiplayer/join", post(handlers::join_multiplayer_session))
        .route("/api/multiplayer/leave", post(handlers::leave_multiplayer_session))
        .route("/api/multiplayer/start/{session_id}", post(handlers::start_multiplayer_session))
        .route("/api/multiplayer/submit-score", post(handlers::submit_multiplayer_score))
        .route("/api/multiplayer/session/{session_id}", get(handlers::get_multiplayer_session))
        .route("/api/multiplayer/my-sessions", get(handlers::get_my_multiplayer_sessions))
        .route("/api/streaks", get(handlers::get_user_streaks))
        .route("/api/account", axum::routing::delete(handlers::delete_account))
        .route_layer(middleware::from_fn_with_state(state.clone(), auth::auth_middleware));

    let admin_routes = Router::new()
        .route(
            "/api/admin/users",
            get(handlers::admin_list_users).post(handlers::create_admin_user),
        )
        .route("/api/admin/stats", get(handlers::admin_get_stats))
        .route(
            "/api/admin/lessons",
            get(handlers::admin_list_lessons).post(handlers::create_lesson),
        )
        .route(
            "/api/admin/lessons/{id}",
            get(handlers::admin_get_lesson)
                .put(handlers::update_lesson)
                .delete(handlers::delete_lesson),
        )
        .route("/api/admin/lessons/{id}/submit", post(handlers::submit_lesson))
        .route("/api/admin/lessons/{id}/approve", post(handlers::approve_lesson))
        .route("/api/admin/approvals/pending", get(handlers::get_pending_approvals))
        .route(
            "/api/admin/config",
            get(handlers::get_config).put(handlers::update_config),
        )
        .route_layer(middleware::from_fn(auth::require_admin))
        .route_layer(middleware::from_fn_with_state(state.clone(), auth::auth_middleware));

    let app = Router::new()
        .merge(public_routes)
        .merge(protected_routes)
        .merge(admin_routes)
        .layer(middleware::from_fn_with_state(state.clone(), audit::audit_middleware))
        .layer(cors)
        .nest_service("/static", ServeDir::new(STATIC_DIR))
        .with_state(state);

    let listener = tokio::net::TcpListener::bind(&bind_addr)
        .await
        .expect("Error al iniciar servidor");

    tracing::info!("Servidor iniciado en http://{}", bind_addr);
    axum::serve(listener, app)
        .await
        .expect("Error al servir la aplicación");
}

async fn ensure_admin_exists(db: &PgPool) {
    let exists = sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(SELECT 1 FROM users WHERE role = 'admin')",
    )
    .fetch_one(db)
    .await
    .unwrap_or(false);

    if !exists {
        let username = std::env::var("ADMIN_USERNAME")
            .unwrap_or_else(|_| "admin".to_string());
        let email = std::env::var("ADMIN_EMAIL")
            .unwrap_or_else(|_| "admin@pianovirtual.com".to_string());
        let password = std::env::var("ADMIN_PASSWORD")
            .unwrap_or_else(|_| "admin123".to_string());
        let hash = bcrypt::hash(&password, bcrypt::DEFAULT_COST)
            .expect("Error al hashear contraseña de admin");

        sqlx::query(
            "INSERT INTO users (username, email, password_hash, role, email_verified) VALUES ($1, $2, $3, 'admin', true)",
        )
        .bind(&username)
        .bind(&email)
        .bind(&hash)
        .execute(db)
        .await
        .expect("Error al crear admin inicial");

        println!("✅ Admin creado: {}/{} (contraseña: {})", username, email, password);
    }
}

async fn ensure_seed_lessons_public(db: &PgPool) {
    let admin = sqlx::query_as::<_, User>("SELECT * FROM users WHERE role = 'admin' LIMIT 1")
        .fetch_optional(db)
        .await
        .ok()
        .flatten();

    if let Some(admin_user) = admin {
        let unmarked = sqlx::query_as::<_, models::Lesson>(
            "SELECT l.* FROM lessons l \
             LEFT JOIN lesson_status ls ON ls.lesson_id = l.id \
             WHERE ls.id IS NULL",
        )
        .fetch_all(db)
        .await
        .unwrap_or_default();

        for lesson in &unmarked {
            sqlx::query(
                "INSERT INTO lesson_status (lesson_id, status, created_by) VALUES ($1, 'public', $2)",
            )
            .bind(lesson.id)
            .bind(admin_user.id)
            .execute(db)
            .await
            .ok();
        }

        if !unmarked.is_empty() {
            println!("✅ Se marcaron {} lecciones semilla como públicas", unmarked.len());
        }
    }
}
