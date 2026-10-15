#!/bin/sh
set -e

DATA_DIR="${DATA_DIR:-/data}"
CUPS_DIR="$DATA_DIR/cups"
mkdir -p "$DATA_DIR" /run/cups "$CUPS_DIR/etc" "$CUPS_DIR/spool/tmp"

if [ -z "$ADMIN_PASSWORD" ]; then
  echo "WARNING: ADMIN_PASSWORD is not set — the admin page will refuse all logins."
fi

# Keep CUPS config and spool on the data volume so queues and pending jobs
# survive container rebuilds. Defaults are seeded once; cupsd.conf always comes from the image.
cp -an /etc/cups/. "$CUPS_DIR/etc/"
cp /etc/cups/cupsd.conf "$CUPS_DIR/etc/cupsd.conf"
grep -v '^\(ServerRoot\|RequestRoot\)' /etc/cups/cups-files.conf > "$CUPS_DIR/etc/cups-files.conf"
printf 'ServerRoot %s\nRequestRoot %s\n' "$CUPS_DIR/etc" "$CUPS_DIR/spool" >> "$CUPS_DIR/etc/cups-files.conf"
chown root:lp "$CUPS_DIR/spool" "$CUPS_DIR/spool/tmp"
chmod 0710 "$CUPS_DIR/spool"
chmod 1770 "$CUPS_DIR/spool/tmp"
rm -f /run/cups/cupsd.pid

# Keep CUPS running; restart it if it ever exits.
(
  while true; do
    /usr/sbin/cupsd -f -c "$CUPS_DIR/etc/cupsd.conf" -s "$CUPS_DIR/etc/cups-files.conf" || true
    echo "cupsd exited, restarting in 2s" >&2
    sleep 2
  done
) &

# Wait for the scheduler to accept connections.
for i in $(seq 1 150); do
  lpstat -r >/dev/null 2>&1 && break
  sleep 0.2
done
lpstat -r || echo "WARNING: CUPS did not start" >&2

exec node server.js
