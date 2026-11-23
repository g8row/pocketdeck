// swipe [dev] [l|r] [count] [gap_ms]: inject horizontal swipes (landscape UI) into the Goodix touchscreen's evdev
// node; readers of the node (the kiosk) see them as touches. One contact, panel x 300, panel y 850 -> 170 (l) or
// 170 -> 850 (r) in 12 steps of 16 ms. Defaults: /dev/input/event2 l 1 300.
#include <fcntl.h>
#include <linux/input.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/time.h>
#include <unistd.h>

static int fd;

static void ev(int type, int code, int value)
{
	struct input_event e;

	memset(&e, 0, sizeof(e));
	gettimeofday(&e.time, NULL);
	e.type = type;
	e.code = code;
	e.value = value;
	if (write(fd, &e, sizeof(e)) != sizeof(e))
		perror("write");
}

int main(int argc, char **argv)
{
	const char *dev = argc > 1 ? argv[1] : "/dev/input/event2";
	int left = argc > 2 ? argv[2][0] != 'r' : 1;
	int n = argc > 3 ? atoi(argv[3]) : 1, gap = argc > 4 ? atoi(argv[4]) : 300;
	int from = left ? 850 : 170, to = left ? 170 : 850;

	fd = open(dev, O_WRONLY);
	if (fd < 0) {
		perror(dev);
		return 1;
	}
	for (int s = 0; s < n; s++) {
		ev(EV_ABS, ABS_MT_TRACKING_ID, 100 + s);
		ev(EV_ABS, ABS_MT_POSITION_X, 300);
		ev(EV_ABS, ABS_MT_POSITION_Y, from);
		ev(EV_KEY, BTN_TOUCH, 1);
		ev(EV_SYN, SYN_REPORT, 0);
		for (int k = 1; k <= 12; k++) {
			usleep(16000);
			ev(EV_ABS, ABS_MT_POSITION_Y, from + (to - from) * k / 12);
			ev(EV_SYN, SYN_REPORT, 0);
		}
		usleep(16000);
		ev(EV_ABS, ABS_MT_TRACKING_ID, -1);
		ev(EV_KEY, BTN_TOUCH, 0);
		ev(EV_SYN, SYN_REPORT, 0);
		if (s + 1 < n)
			usleep(gap * 1000);
	}
	return 0;
}
