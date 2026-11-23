// poke <phys-addr> <value>: write a 32-bit word through /dev/mem, print the read-back.
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/mman.h>
#include <unistd.h>

int main(int argc, char **argv)
{
	if (argc != 3) {
		fprintf(stderr, "usage: poke <phys-addr> <value>\n");
		return 2;
	}
	unsigned long addr = strtoul(argv[1], NULL, 0) & ~3UL;
	uint32_t val = strtoul(argv[2], NULL, 0);
	long pg = sysconf(_SC_PAGESIZE);
	unsigned long base = addr & ~(unsigned long)(pg - 1);
	int fd = open("/dev/mem", O_RDWR | O_SYNC);
	if (fd < 0) {
		perror("/dev/mem");
		return 1;
	}
	volatile uint32_t *m = mmap(NULL, pg, PROT_READ | PROT_WRITE, MAP_SHARED, fd, base);
	if (m == MAP_FAILED) {
		perror("mmap");
		return 1;
	}
	m[(addr - base) / 4] = val;
	printf("%#lx <- %#x : %#x\n", addr, val, m[(addr - base) / 4]);
	return 0;
}
