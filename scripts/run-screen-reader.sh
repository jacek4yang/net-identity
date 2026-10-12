#!/usr/bin/env bash
set -euo pipefail
# Run only in an isolated CI Xvfb + D-Bus session. All extension data is synthetic.
output="$(pwd)/artifacts/screen-reader"
mkdir -p "$output"
temporary=$(mktemp -d)
orca_pid=''
wm_pid=''
cleanup() {
  [[ -z "$orca_pid" ]] || kill "$orca_pid" 2>/dev/null || true
  [[ -z "$wm_pid" ]] || kill "$wm_pid" 2>/dev/null || true
  [[ ! -f "$temporary/speechd.pid" ]] || kill "$(cat "$temporary/speechd.pid")" 2>/dev/null || true
}
trap cleanup EXIT
export GNOME_ACCESSIBILITY=1 NO_AT_BRIDGE=0 LC_ALL=C.UTF-8
export ORCA_DEBUG_FILE="$output/orca-debug.log"
export SPEECHD_ADDRESS="unix_socket:$temporary/speechd.sock"
mkdir -p "$temporary/orca" "$temporary/speechd" "$output/speechd"
cp -a /etc/speech-dispatcher/. "$temporary/speechd/"
printf '\nAudioOutputMethod "pulse"\nDefaultModule espeak-ng\n' >> "$temporary/speechd/speechd.conf"
# A null audio sink lets the actual synthesis backend work without host audio hardware.
pulseaudio --start --exit-idle-time=-1
pactl load-module module-null-sink sink_name=ni_ci >/dev/null
pactl set-default-sink ni_ci
speech-dispatcher -d -C "$temporary/speechd" -S "$temporary/speechd.sock" \
  -P "$temporary/speechd.pid" -L "$output/speechd" -t 0
openbox > "$output/openbox.log" 2>&1 &
wm_pid=$!
cat > "$temporary/orca/orca-customizations.py" <<'PY'
from orca import debug, settings
# Only flush genuine Orca output promptly; do not replace speech or AT processing.
if debug.debugFile is not None:
    debug.debugFile.reconfigure(line_buffering=True)
# Deliberately enable ordinary text echo: a silent engine cannot pass password tests.
settings.enableEchoByCharacter = True
PY
orca --user-prefs "$temporary/orca" --speech-system=speechdispatcherfactory --enable=speech --disable=braille,sound \
  --debug-file "$ORCA_DEBUG_FILE" > "$output/orca-startup.log" 2>&1 &
orca_pid=$!
ready=false
{ firefox --version; orca --version; speech-dispatcher --version; } > "$output/versions.txt" 2>&1
for _ in $(seq 1 100); do
  if grep -q 'SPEECH: Using speech server factory:' "$ORCA_DEBUG_FILE" 2>/dev/null && grep -q 'Starting Atspi main event loop' "$ORCA_DEBUG_FILE"; then ready=true; break; fi
  kill -0 "$orca_pid"
  sleep 0.2
done
[[ "$ready" == true ]] || { cat "$output/orca-startup.log"; echo 'Orca speech backend did not start'; exit 1; }
for theme in dark light; do
  args=()
  [[ "$theme" != light ]] || args+=(--light)
  node scripts/e2e-ui.mjs --draft-check --screen-reader --timeout 240 \
    --draft-evidence "$output/$theme" --firefox /usr/bin/firefox "${args[@]}" \
    2>&1 | tee "$output/$theme.log"
done
if grep -q 'SPEECH: Not available' "$ORCA_DEBUG_FILE"; then
  echo 'Orca reported unavailable speech; cannot accept debug-only output'
  exit 1
fi
echo 'PASS: real Orca labels, native Tab, protected password focus and Save announcements in EN/ZH light/dark'
