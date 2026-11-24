// SPDX-License-Identifier: GPL-2.0
/*
 * memtest: find RAM corruption on the running tablet and say where it is physically.
 *   memtest <MiB> <seconds> <threads>
 * Each thread owns a slice of one big locked buffer and loops: write a pattern that depends on the address and
 * the pass, then verify it. A mismatch prints the physical address (/proc/self/pagemap, needs root), expected
 * and read values, once per bad 4 KiB page. The word is re-read: ok = a CPU/cache error, bad = memory/DMA.
 * Build: aarch64-linux-gnu-gcc -static -O2 -pthread -o memtest memtest.c
 */
#define _GNU_SOURCE
#include <fcntl.h>
#include <pthread.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <time.h>
#include <unistd.h>

static uint64_t *buf;
static size_t words, per;
static int nthr, secs, pagemap;
static volatile int stop;
static volatile unsigned long errors, passes;
static time_t t_start;

static uint64_t phys(const void *v)
{
	uint64_t e;
	off_t off = (uintptr_t)v / 4096 * 8;

	if (pread(pagemap, &e, 8, off) != 8 || !(e >> 63))
		return 0;
	return (e & ((1ULL << 55) - 1)) * 4096 + (uintptr_t)v % 4096;
}

static uint64_t pat(size_t i, unsigned pass)
{
	uint64_t x = i * 0x9e3779b97f4a7c15ULL ^ (uint64_t)pass * 0xd1b54a32d192ed03ULL;

	return x ^ x >> 29;
}

static void *run(void *arg)
{
	size_t t = (size_t)arg, lo = t * per, hi = lo + per, i;
	unsigned pass;

	for (pass = 1; !stop; pass++) {
		for (i = lo; i < hi; i++)
			buf[i] = pat(i, pass);
		for (i = lo; i < hi; i++) {
			uint64_t v = buf[i], want = pat(i, pass);

			if (v != want) {
				uint64_t again = buf[i], ph = phys(&buf[i]);

				__sync_fetch_and_add(&errors, 1);
				/* one line per bad 4 KiB page (the rest of the page is skipped), as `PAGE`, for summaries */
				printf("PAGE t=%ld pass %u phys 0x%09llx want %016llx got %016llx reread %s\n",
				       (long)(time(0) - t_start), pass, (unsigned long long)ph, (unsigned long long)want,
				       (unsigned long long)v, again == want ? "ok" : "bad");
				fflush(stdout);
				i |= 511;	/* next page */
			}
		}
		__sync_fetch_and_add(&passes, 1);
	}
	return NULL;
}

int main(int argc, char **argv)
{
	size_t mb = argc > 1 ? strtoul(argv[1], 0, 0) : 256;
	pthread_t th[16];
	time_t t0 = t_start = time(0);
	uint64_t pmin = ~0ULL, pmax = 0;
	size_t i;
	int t;

	secs = argc > 2 ? atoi(argv[2]) : 60;
	nthr = argc > 3 ? atoi(argv[3]) : 4;
	if (nthr < 1 || nthr > 16)
		return 2;
	words = mb << 17;
	per = words / nthr;
	buf = mmap(0, words * 8, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS | MAP_POPULATE, -1, 0);
	if (buf == MAP_FAILED || mlock(buf, words * 8)) {
		perror("mmap/mlock");
		return 1;
	}
	pagemap = open("/proc/self/pagemap", O_RDONLY);
	for (i = 0; i < words; i += 512) {
		uint64_t p = phys(&buf[i]);

		if (p && p < pmin)
			pmin = p;
		if (p > pmax)
			pmax = p;
	}
	printf("memtest: %zu MiB, %d threads, %d s, phys 0x%llx..0x%llx\n", mb, nthr, secs,
	       (unsigned long long)pmin, (unsigned long long)pmax);
	fflush(stdout);
	for (t = 0; t < nthr; t++)
		pthread_create(&th[t], 0, run, (void *)(size_t)t);
	while (time(0) - t0 < secs)
		sleep(1);
	stop = 1;
	for (t = 0; t < nthr; t++)
		pthread_join(th[t], 0);
	printf("memtest: done, %lu slice passes, %lu errors\n", passes, errors);
	return errors ? 1 : 0;
}
