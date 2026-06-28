param(
    [string]$ApiUrl = "http://localhost:8000",
    [string]$Target = "dev"  # dev, build, android
)

$env:API_URL = $ApiUrl

echo $ApiUrl
echo $Target

switch ($Target) {
    "dev" { cargo tauri dev }
    "build" { cargo tauri build }
    "android" { cargo tauri android build }
    "android dev" { cargo tauri android dev }
    default { cargo tauri dev }
}
