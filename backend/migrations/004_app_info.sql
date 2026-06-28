INSERT INTO app_config (key, value) VALUES
('share_info_windows', '{"active_version": "0.1.0", "app_url": "https://piano-virtual.com/download", "app_description": "Practica piano con lecciones interactivas. Descarga Piano Virtual para Windows y comienza a tocar hoy."}'),
('share_info_android', '{"active_version": "0.1.0", "app_url": "https://piano-virtual.com/download", "app_description": "Practica piano con lecciones interactivas. Descarga Piano Virtual para Android y comienza a tocar hoy."}'),
('share_info_web', '{"active_version": "0.1.0", "app_url": "https://piano-virtual.com", "app_description": "Practica piano con lecciones interactivas. Prueba Piano Virtual en tu navegador."}')
ON CONFLICT (key) DO NOTHING;
