[Unit]
Description=AetherDroid Runtime Host (real Android emulator + WebRTC bridge)
After=network.target
[Service]
Type=simple
WorkingDirectory=/opt/aetherdroid/runtime-host
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=5
User=root
Environment=NODE_ENV=production
Environment=PORT=8090
Environment=RUNTIME_HOST_DATA_DIR=/var/lib/aetherdroid
Environment=ANDROID_SDK_ROOT=/opt/android-sdk
# Optional overrides:
# Environment=ADB_PATH=/opt/android-sdk/platform-tools/adb
# Environment=EMULATOR_CMD=/opt/android-sdk/emulator/emulator
# Environment=PUBLIC_URL=http://your-host-ip:8090
[Install]
WantedBy=multi-user.target
