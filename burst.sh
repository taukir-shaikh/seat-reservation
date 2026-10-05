#!/usr/bin/env sh
# Usage: ./burst.sh <BASE_URL>      e.g. ./burst.sh https://seat-reservation.onrender.com
# Needs Node 20+. Set ADMIN_KEY to the deployed admin key.
exec node "$(dirname "$0")/scripts/burst.js" "$@"
