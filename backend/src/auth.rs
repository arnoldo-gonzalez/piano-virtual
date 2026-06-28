use axum::{
    extract::{Request, State},
    http::StatusCode,
    middleware::Next,
    response::{IntoResponse, Response},
};
use chrono::Utc;
use jsonwebtoken::{decode, encode, DecodingKey, EncodingKey, Header, Validation};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::AppState;

#[derive(Debug, Serialize, Deserialize)]
pub struct Claims {
    pub sub: Uuid,
    pub role: String,
    pub exp: usize,
    pub iat: usize,
}

fn jwt_secret() -> String {
    std::env::var("JWT_SECRET")
        .unwrap_or_else(|_| "0uOgUgZWlRYVdyIGZXxJSx1MtsGPB7Y6Df42TFUMUFCuKdDltNbVFY9L3jWSlLhWh04TNYSg3WBlMXOilhp7HA==".to_string())
}

pub fn create_token(user_id: Uuid, role: &str) -> Result<String, jsonwebtoken::errors::Error> {
    let secret = jwt_secret();
    let now = Utc::now();
    let claims = Claims {
        sub: user_id,
        role: role.to_string(),
        iat: now.timestamp() as usize,
        exp: (now.timestamp() + 7 * 24 * 3600) as usize,
    };
    encode(
        &Header::default(),
        &claims,
        &EncodingKey::from_secret(secret.as_bytes()),
    )
}

pub fn verify_token(token: &str) -> Result<Claims, jsonwebtoken::errors::Error> {
    let secret = jwt_secret();
    decode::<Claims>(
        token,
        &DecodingKey::from_secret(secret.as_bytes()),
        &Validation::default(),
    )
    .map(|data| data.claims)
}

pub async fn auth_middleware(
    State(state): State<AppState>,
    mut req: Request,
    next: Next,
) -> Response {
    let auth_header = req
        .headers()
        .get("Authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "));

    match auth_header {
        Some(token) => match verify_token(token) {
            Ok(claims) => {
                let db = state.db.clone();
                let uid = claims.sub;
                tokio::spawn(async move {
                    sqlx::query("UPDATE users SET last_active_at = NOW() WHERE id = $1")
                        .bind(uid)
                        .execute(&db)
                        .await
                        .ok();
                });
                req.extensions_mut().insert(claims.sub);
                req.extensions_mut().insert(claims.role);
                next.run(req).await
            }
            Err(_) => (StatusCode::UNAUTHORIZED, "Token inválido").into_response(),
        },
        None => (StatusCode::UNAUTHORIZED, "Token requerido").into_response(),
    }
}

pub async fn require_admin(req: Request, next: Next) -> Response {
    let role = req
        .extensions()
        .get::<String>()
        .cloned()
        .unwrap_or_default();

    if role != "admin" {
        return (
            StatusCode::FORBIDDEN,
            "Se requieren permisos de administrador",
        )
            .into_response();
    }

    next.run(req).await
}
