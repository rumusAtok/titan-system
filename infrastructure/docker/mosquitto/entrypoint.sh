#!/bin/sh
# Generates the broker's credential and ACL files from the environment at
# start, so no credential is stored in the repository or the image.
set -eu

: "${MQTT_SIMULATOR_USER:?}" "${MQTT_SIMULATOR_PASSWORD:?}" "${MQTT_TELEMETRY_USER:?}" "${MQTT_TELEMETRY_PASSWORD:?}"

PASSWD=/mosquitto/config/passwd
ACL=/mosquitto/config/acl

: > "$PASSWD"
chmod 0600 "$PASSWD"
mosquitto_passwd -b "$PASSWD" "$MQTT_SIMULATOR_USER" "$MQTT_SIMULATOR_PASSWORD"
mosquitto_passwd -b "$PASSWD" "$MQTT_TELEMETRY_USER" "$MQTT_TELEMETRY_PASSWORD"

# Least privilege: devices may only publish telemetry; the ingestion service
# may only read it. In production each device has its own credential and is
# restricted to its own topic (see docs/architecture/iot-architecture.md).
cat > "$ACL" <<EOF
user $MQTT_SIMULATOR_USER
topic write titan/+/devices/+/telemetry

user $MQTT_TELEMETRY_USER
topic read titan/+/devices/+/telemetry
topic read \$SYS/broker/uptime
EOF
chmod 0600 "$ACL"
chown mosquitto:mosquitto "$PASSWD" "$ACL" 2>/dev/null || true

exec /usr/sbin/mosquitto -c /titan/mosquitto.conf
