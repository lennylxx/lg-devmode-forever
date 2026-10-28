#!/bin/bash

set -e
cd "$(dirname "$0")"
inkscape icon.svg -w 80 -h 80 -o ../app/icon.png
inkscape icon.svg -w 130 -h 130 -o ../app/largeIcon.png
echo "icons: app/icon.png, app/largeIcon.png"
