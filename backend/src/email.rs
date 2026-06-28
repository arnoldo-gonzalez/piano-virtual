use lettre::{
    message::header::ContentType,
    transport::smtp::authentication::Credentials,
    transport::smtp::client::{Tls, TlsParameters},
    AsyncSmtpTransport, AsyncTransport, Message, Tokio1Executor,
};
use std::env;

#[derive(Clone)]
pub struct MailConfig {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub password: String,
    pub from: String,
}

impl MailConfig {
    pub fn from_env() -> Option<Self> {
        let host = env::var("SMTP_HOST").ok()?;
        let port = env::var("SMTP_PORT").ok()?.parse().ok()?;
        let username = env::var("SMTP_USERNAME").ok()?;
        let password = env::var("SMTP_PASSWORD").ok()?;
        let from = env::var("SMTP_FROM").ok()?;
        Some(Self { host, port, username, password, from })
    }

    pub async fn send_verification_code(&self, to: &str, code: &str) -> Result<(), String> {
        let creds = Credentials::new(self.username.clone(), self.password.clone());

        let mailer = if self.port == 465 {
            let tls_params = TlsParameters::new(self.host.clone())
                .map_err(|e| format!("Error al crear parámetros TLS: {e}"))?;
            AsyncSmtpTransport::<Tokio1Executor>::builder_dangerous(&self.host)
                .port(self.port)
                .credentials(creds)
                .tls(Tls::Wrapper(tls_params))
                .build()
        } else {
            AsyncSmtpTransport::<Tokio1Executor>::relay(&self.host)
                .map_err(|e| format!("Error al configurar SMTP: {e}"))?
                .port(self.port)
                .credentials(creds)
                .build()
        };

        let html_body = format!(
            r#"<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background-color:#f4f4f4;font-family:'Segoe UI',Arial,sans-serif">
  <table width="100%%" cellpadding="0" cellspacing="0" style="background-color:#f4f4f4;padding:30px 0">
    <tr>
      <td align="center">
        <table width="480" cellpadding="0" cellspacing="0" style="background-color:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.08)">
          <tr>
            <td style="background:linear-gradient(135deg,#667eea,#764ba2);padding:30px;text-align:center">
              <h1 style="margin:0;color:#ffffff;font-size:24px;font-weight:600">🎹 Piano Virtual</h1>
              <p style="margin:8px 0 0;color:#e0d4ff;font-size:14px">Verificación de correo electrónico</p>
            </td>
          </tr>
          <tr>
            <td style="padding:32px">
              <p style="margin:0 0 16px;color:#333;font-size:15px;line-height:1.5">Hola,</p>
              <p style="margin:0 0 20px;color:#333;font-size:15px;line-height:1.5">Tu código de verificación es:</p>
              <div style="background:#f8f6ff;border:2px dashed #667eea;border-radius:10px;padding:16px;text-align:center;margin:0 0 20px">
                <span style="font-size:36px;font-weight:700;letter-spacing:8px;color:#667eea;font-family:monospace">{code}</span>
              </div>
              <p style="margin:0 0 8px;color:#666;font-size:13px">Este código expirará en <strong>10 minutos</strong>.</p>
              <p style="margin:0;color:#999;font-size:12px">Si no solicitaste este código, ignora este mensaje.</p>
            </td>
          </tr>
          <tr>
            <td style="background:#fafafa;padding:16px 32px;text-align:center;border-top:1px solid #eee">
              <p style="margin:0;color:#aaa;font-size:11px">Piano Virtual &copy; 2026 &mdash; Todos los derechos reservados</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>"#,
            code = code
        );

        let email = Message::builder()
            .from(self.from.parse().map_err(|_| "Dirección from inválida".to_string())?)
            .to(to.parse().map_err(|_| "Dirección to inválida".to_string())?)
            .subject("Código de verificación - Piano Virtual")
            .header(ContentType::TEXT_HTML)
            .body(html_body)
            .map_err(|e| format!("Error al crear el mensaje: {e}"))?;

        mailer.send(email).await.map_err(|e| format!("Error al enviar email: {e}"))?;
        Ok(())
    }
}
