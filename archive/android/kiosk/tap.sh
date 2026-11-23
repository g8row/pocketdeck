#!/system/bin/sh
# tap.sh <landscape_x> <landscape_y> — inject a protocol-A tap into mtk-tpd
# (landscape 1024x600 screen coords → portrait panel coords).
D=/dev/input/event5
PX=$((599 - $2)); PY=$1
sendevent $D 3 57 0; sendevent $D 3 53 $PX; sendevent $D 3 54 $PY; sendevent $D 1 330 1
sendevent $D 0 2 0; sendevent $D 0 0 0
sleep 0.12
sendevent $D 1 330 0; sendevent $D 0 2 0; sendevent $D 0 0 0
