param(
    [string]$ApiUrl = "https://piano-virtual.alwaysdata.net",
    [ValidateSet("dev", "windows-dev", "android-dev", "windows", "android", "both")]
    [string]$Target = "dev"
)

$env:API_URL = $ApiUrl
$appsDir = Join-Path (Resolve-Path "..") "backend\apps"
if (-not (Test-Path $appsDir)) { New-Item -ItemType Directory -Path $appsDir -Force | Out-Null }

Write-Host "API_URL: $ApiUrl"
Write-Host "Target: $Target"
Write-Host "Apps dir: $appsDir"

switch ($Target) {
    "dev" {
        cargo tauri dev
    }
    "windows-dev" {
        cargo tauri dev
    }
    "android-dev" {
        cargo tauri android dev
    }
    "windows" {
        cargo tauri build --bundles msi
        $msi = Get-ChildItem "..\target\release\bundle\msi\*.msi" -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($msi) {
            Copy-Item $msi.FullName "$appsDir\piano-virtual.msi" -Force
            Write-Host "MSI copiado a $appsDir\piano-virtual.msi"
        }
        $exe = "..\target\release\piano-virtual.exe"
        if (Test-Path $exe) {
            Copy-Item $exe "$appsDir\piano-virtual.exe" -Force
            Write-Host "EXE copiado a $appsDir\piano-virtual.exe"
        }
    }
    "android" {
        cargo tauri android build
        $apk = Get-ChildItem "src-tauri\gen\android\app\build\outputs\apk" -Recurse -Filter "*.apk" | Where-Object { $_.Name -like "*universal*release*" } | Select-Object -First 1
        if (-not $apk) { $apk = Get-ChildItem "src-tauri\gen\android\app\build\outputs\apk" -Recurse -Filter "*.apk" | Select-Object -First 1 }
        if ($apk) {
            Copy-Item $apk.FullName "$appsDir\piano-virtual.apk" -Force
            Write-Host "APK copiado a $appsDir\piano-virtual.apk"
        } else {
            Write-Host "No se encontró APK"
        }
    }
    "both" {
        cargo tauri build --bundles msi
        $msi = Get-ChildItem "..\target\release\bundle\msi\*.msi" -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($msi) {
            Copy-Item $msi.FullName "$appsDir\piano-virtual.msi" -Force
            Write-Host "MSI copiado a $appsDir\piano-virtual.msi"
        }
        $exe = "..\target\release\piano-virtual.exe"
        if (Test-Path $exe) {
            Copy-Item $exe "$appsDir\piano-virtual.exe" -Force
            Write-Host "EXE copiado a $appsDir\piano-virtual.exe"
        }

        cargo tauri android build
        $apk = Get-ChildItem "src-tauri\gen\android\app\build\outputs\apk" -Recurse -Filter "*.apk" | Where-Object { $_.Name -like "*universal*release*" } | Select-Object -First 1
        if (-not $apk) { $apk = Get-ChildItem "src-tauri\gen\android\app\build\outputs\apk" -Recurse -Filter "*.apk" | Select-Object -First 1 }
        if ($apk) {
            Copy-Item $apk.FullName "$appsDir\piano-virtual.apk" -Force
            Write-Host "APK copiado a $appsDir\piano-virtual.apk"
        } else {
            Write-Host "No se encontró APK"
        }
    }
}
