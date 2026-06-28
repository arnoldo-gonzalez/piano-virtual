use axum::{
    body::Body,
    extract::{Request, State},
    middleware::Next,
    response::Response,
};
use bytes::Bytes;

use crate::auth;
use crate::AppState;

const MAX_BODY_SIZE: usize = 10_240;

pub async fn audit_middleware(
    State(state): State<AppState>,
    req: Request,
    next: Next,
) -> Response {
    let start = std::time::Instant::now();

    let method = req.method().to_string();
    let path = req.uri().path().to_string();

    let user_id = req
        .headers()
        .get("Authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .and_then(|token| auth::verify_token(token).ok())
        .map(|claims| claims.sub);

    let ip_address = req
        .headers()
        .get("X-Forwarded-For")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.split(',').next().unwrap_or(s).trim().to_string())
        .or_else(|| {
            req.headers()
                .get("X-Real-IP")
                .and_then(|v| v.to_str().ok())
                .map(|s| s.to_string())
        });

    let (parts, body) = req.into_parts();
    let (request_body, body) = match axum::body::to_bytes(body, MAX_BODY_SIZE).await {
        Ok(bytes) => {
            let text = (!bytes.is_empty())
                .then(|| {
                    let s = String::from_utf8_lossy(&bytes).to_string();
                    if s.len() > MAX_BODY_SIZE {
                        format!("{}...", &s[..MAX_BODY_SIZE])
                    } else {
                        s
                    }
                });
            (text, Body::from(bytes))
        }
        Err(_) => (None, Body::from(Bytes::new())),
    };

    let req = Request::from_parts(parts, body);
    let response = next.run(req).await;

    let status = response.status().as_u16() as i32;
    let (parts, body) = response.into_parts();
    let (response_body, body) = match axum::body::to_bytes(body, MAX_BODY_SIZE).await {
        Ok(bytes) => {
            let text = (!bytes.is_empty())
                .then(|| {
                    let s = String::from_utf8_lossy(&bytes).to_string();
                    if s.len() > MAX_BODY_SIZE {
                        format!("{}...", &s[..MAX_BODY_SIZE])
                    } else {
                        s
                    }
                });
            (text, Body::from(bytes))
        }
        Err(_) => (None, Body::from(Bytes::new())),
    };
    let response = Response::from_parts(parts, body);

    let duration_ms = start.elapsed().as_millis() as i32;

    let db = state.db.clone();
    tokio::spawn(async move {
        if let Err(e) = sqlx::query(
            r#"INSERT INTO audit_logs (user_id, method, path, request_body, response_status, response_body, ip_address, duration_ms)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8)"#,
        )
        .bind(user_id)
        .bind(&method)
        .bind(&path)
        .bind(&request_body)
        .bind(status)
        .bind(&response_body)
        .bind(&ip_address)
        .bind(duration_ms)
        .execute(&db)
        .await
        {
            tracing::error!("Error al insertar audit_log: {e}");
        }
    });

    response
}
