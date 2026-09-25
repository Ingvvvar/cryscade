/* Обёртка над официальным xoshiro128starstar.c: задать состояние и взять выход.
   Сборка и источники — в vectors.cpp. */

#include "xoshiro128starstar.c"

void xo_set(uint32_t a, uint32_t b, uint32_t c, uint32_t d) {
	s[0] = a;
	s[1] = b;
	s[2] = c;
	s[3] = d;
}

uint32_t xo_next(void) {
	return next();
}
