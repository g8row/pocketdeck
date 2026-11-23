# WMT userspace for the TB-7304X (static, runs on the Alpine rootfs). Built by scripts/build-in-docker.sh.
CC ?= gcc
CFLAGS ?= -O2
CFLAGS += -D_GNU_SOURCE -DSTATIC_BUILD -static -Wno-format
all: stp_uart_launcher wmt_loader
stp_uart_launcher: stp_uart_launcher.c
	$(CC) $(CFLAGS) $< -lpthread -o $@
wmt_loader: wmt_loader.c
	$(CC) $(CFLAGS) $< -o $@
clean:
	rm -f stp_uart_launcher wmt_loader
.PHONY: all clean
