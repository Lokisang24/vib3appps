#!/usr/bin/env bash
set -e

echo "=========================================="
echo "    NovaStream Android APK Builder        "
echo "=========================================="

echo "1. Syncing Capacitor Android assets..."
npx cap sync android

echo "2. Checking Gradle wrapper..."
chmod +x android/gradlew

echo "3. Building Debug APK..."
cd android
./gradlew assembleDebug

echo ""
echo "=========================================="
echo "Build Successful!"
echo "Your APK is located at:"
echo "android/app/build/outputs/apk/debug/app-debug.apk"
echo "=========================================="
