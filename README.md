# VPN Sunucu V2 - Desktop Client

Burası VPN Sunucu v2 paneline özel olarak hazırlanmış, Windows ve Linux platformlarını destekleyen Electron tabanlı masaüstü VPN istemcisidir.

## Özellikler

* **Çarpan Platform Desteği:** Windows (NSIS Installer, Portable) ve Linux (DEB, AppImage) desteği.
* **Modern Arayüz:** Premium karanlık tema, glassmorphism ve akıcı animasyonlar.
* **Google OAuth Girişi:** Sistem tarayıcısı üzerinden güvenli aktarım ile tek tıkla oturum açma.
* **Tüm Protokoller:** VLESS, VMess, Trojan ve Shadowsocks (WS, gRPC, HTTPUpgrade).
* **Otomatik Proxy Ayarları:** Windows ve Linux/GNOME sistem proxy ayarları otomatik olarak yapılandırılır.
* **İhtiyaç Halinde İndirme:** `sing-box` çekirdeği uygulama ilk açıldığında otomatik olarak GitHub üzerinden indirilir, böylece uygulama boyutu ufak tutulur.

## Geliştirme (Local Dev)

Uygulamayı bilgisayarınızda test etmek için:

```bash
cd client
npm install
npm run dev
```

## Derleme (Build)

Uygulamayı derlemek için `electron-builder` kullanılmaktadır. Paketler `client/dist/` klasörüne çıkarılır.

### Windows
```bash
npm run build:win
```
Çıktı: `dist/VPN Client Setup X.X.X.exe` ve `dist/VPN Client Portable X.X.X.exe`

### Linux
```bash
npm run build:linux
```
Çıktı: `dist/VPN-Client-X.X.X.AppImage` ve `dist/vpn-client_X.X.X_amd64.deb`

## GitHub Actions ile Derleme Otomasyonu

Projeyi GitHub'a yüklediğinizde, uygulamanın Windows ve Linux sürümleri otomatik olarak GitHub sunucularında derlenir.

1. `.github/workflows/build-client.yml` dosyası yapılandırılmıştır.
2. Sürümleri (Release) derlemek için, projede `v1.0.0` gibi bir tag oluşturup GitHub'a pushlayın:
   ```bash
   git tag v1.0.0
   git push origin v1.0.0
   ```
3. GitHub Actions otomatik olarak çalışacak ve `VPN Client` setup dosyalarını derleyip GitHub Releases bölümünde yayınlayacaktır.
