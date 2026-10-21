# NovaStream Android Package & Installable PWA

Convert the uploaded NovaStream streaming application into a complete Android Capacitor project (configured with camera and audio recording hardware permissions, Gradle build scripts, and Android Studio structure) while preserving the exact original application code and providing an installable Android PWA with live local server support.

---

## User Review & Critical Decisions

> [!IMPORTANT]
> The original NovaStream codebase and client assets (`app.js`, `style.css`, `index.html`, `social.js`, `admin.js`, etc.) will remain completely intact without alterations, matching the directive *"do not change anything, just create an android apk version of this app"*.

- **Backend Target (Confirmed)**: Running local mock/in-memory server mode to enable self-contained streaming, chat, moderation, and early-bird pins.
- **Delivery Mode (Confirmed)**: Complete Android Capacitor project structure with native Android build files, alongside a fully compliant installable Progressive Web App (PWA).
- **Hardware Permissions (Confirmed)**: AndroidManifest configured with camera (`android.permission.CAMERA`), microphone audio recording (`android.permission.RECORD_AUDIO`), and audio routing (`android.permission.MODIFY_AUDIO_SETTINGS`).

---

## 1. Overview & Core Concept

- **What It Does**: NovaStream is a live streaming platform designed for teens and young adults with human-sized rooms, interactive live video feeds, real-time chat, moderation controls, early bird badges, polls, and chat replay.
- **Target Audience**: Mobile and desktop users streaming and watching live feeds, with native Android installation capability.
- **Key Value**: Delivers the exact NovaStream experience in two production-grade Android distribution channels: a native Capacitor Android Studio project ready for building `.apk` / `.aab` packages with hardware camera/mic access, and an installable PWA for one-tap home screen installation on Android devices.

---

## 2. User Experience & Visual Design

- **Visual Preservation**: Retain NovaStream's custom dark theme, neon stream accents, responsive layout for phones, tablets, and desktop, skip link, and keyboard accessibility.
- **Mobile Ergonomics**:
  - Touch targets for chat input, stream controls, camera flip, and moderation actions conform to mobile hitboxes ($\ge 44 \times 44\text{px}$).
  - Fullscreen video feed viewing and natural thumb-reach navigation tabs on mobile screens.
- **PWA Installation Flow**:
  - Web App Manifest configured with high-resolution icons (192x192, 512x512, SVG), standalone display mode, and theme color `#0f172a`.
  - Non-intrusive install action allowing any Android browser to install NovaStream to the home screen with launcher icon and splash screen.

---

## 3. Key Product Decisions & Trade-Offs

- **Capacitor Android Structure (`android/`)**:
  - *Chosen Approach*: Generate the full Capacitor Android native directory with `MainActivity.java`, `AndroidManifest.xml`, `build.gradle`, `settings.gradle`, and resource icons.
  - *Why*: Enables immediate compilation in Android Studio or automated CI/CD workflows to output debug/release `.apk` files without modifying web source code.
  - *Permissions*: Camera and microphone permissions declared in `AndroidManifest.xml` with `android:required="false"` camera features so devices without autofocus can still install.
- **Local Server & WebSocket Signaling**:
  - *Chosen Approach*: Run NovaStream's Express + Socket.IO server directly in the environment with SQLite/in-memory state, WebSockets, and static asset serving from `public/`.
  - *Why*: Allows live testing of streaming, chat, and admin features directly in the workspace preview while keeping the client code 100% untouched.
- **Automated GitHub Actions APK Builder**:
  - *Chosen Approach*: Include a complete `.github/workflows/build-apk.yml` and a helper build script so the user can build the unsigned `.apk` with a single command or GitHub push.

---

## 4. Technical Architecture & Data Strategy

```
┌─────────────────────────────────────────────────────────────┐
│                    NovaStream Android App                   │
├──────────────────────────────┬──────────────────────────────┤
│      Android Native Shell    │    Installable Web PWA       │
│  (Capacitor BridgeActivity)  │  (Standalone Manifest & SW)  │
├──────────────────────────────┴──────────────────────────────┤
│               NovaStream Client Web Engine                  │
│       index.html · app.js · style.css · social.js · etc.    │
├─────────────────────────────────────────────────────────────┤
│         Hardware Bridge & Device Permissions                │
│       CAMERA · RECORD_AUDIO · MODIFY_AUDIO_SETTINGS         │
├─────────────────────────────────────────────────────────────┤
│               Local NovaStream Backend Server               │
│          Express · Socket.IO · SQLite Storage · WebRTC      │
└─────────────────────────────────────────────────────────────┘
```

- **File Architecture**:
  - `public/`: Exact extracted NovaStream frontend (HTML, JS, CSS, PWA assets, icons).
  - `server.js`, `admin.js`, `social.js`, `replay.js`: Backend streaming signaling and room management.
  - `capacitor.config.json`: Capacitor project configuration pointing to local web assets and permissions.
  - `android/`: Native Android Studio project structure with `app/src/main/AndroidManifest.xml` and Gradle scripts.
  - `package.json`: Dependencies needed to run the server and Capacitor CLI tooling.
- **Build Verification**:
  - Verify server start and preview compilation.
  - Verify Android manifest permission declarations and asset paths.
