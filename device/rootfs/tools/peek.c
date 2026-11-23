// peek <phys-addr> [count]: read 32-bit words through /dev/mem (needs CONFIG_STRICT_DEVMEM off).
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/mman.h>
#include <unistd.h>

int main(int argc, char **argv)
{
	if (argc < 2) {
		fprintf(stderr, "usage: peek <phys-addr> [count]\n");
		return 2;
	}
	unsigned long addr = strtoul(argv[1], NULL, 0) & ~3UL;
	unsigned long count = argc > 2 ? strtoul(argv[2], NULL, 0) : 1;
	long pg = sysconf(_SC_PAGESIZE);
	unsigned long base = addr & ~(unsigned long)(pg - 1), len = (addr - base) + count * 4;
	int fd = open("/dev/mem", O_RDONLY | O_SYNC);
	if (fd < 0) {
		perror("/dev/mem");
		return 1;
	}
	volatile uint32_t *m = mmap(NULL, len, PROT_READ, MAP_SHARED, fd, base);
	if (m == MAP_FAILED) {
		perror("mmap");
		return 1;
	}
	for (unsigned long i = 0; i < count; i++)
		printf("%#lx: %#010x\n", addr + i * 4, m[(addr - base) / 4 + i]);
	return 0;
}
