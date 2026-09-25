// Эталонные векторы для tests/unit/rng: печатает литералы, которые тесты сверяют с src/core/rng.
//
// Источники — официальные файлы, скачанные с первоисточника (не восстановленные по памяти):
//   https://prng.di.unimi.it/xoshiro128starstar.c   sha256 2e3e540e15e1b1edf6144509ba3a71bc4611e3676d52e03d567a0f230a141a67
//   https://prng.di.unimi.it/f2x.c                  sha256 62e9b22bd882c6dade29a57cabcd079abf83522218415e3e9a95a4e6086dac99
//   https://raw.githubusercontent.com/aappleby/smhasher/master/src/MurmurHash3.cpp
//                                                   sha256 30f121ed155ebf336af398aabb7d8d157afdfafc8d981e7b48d2a1ceb4b63e4e
//   https://raw.githubusercontent.com/aappleby/smhasher/master/src/MurmurHash3.h
//                                                   sha256 9af2003e3885c841fa0ac08cb5d5f31541ee9d793f8a9c4a4f771f43fb0d6f41
//
// splitmix32 у Vigna нет. По §4.7 это шаг Вейля 0x9E3779B9 и официальный fmix32 из MurmurHash3,
// поэтому здесь из своего только сложение счётчика; перемешивание — функция из smhasher.
//
// Сборка (файлы источников в DIR):
//   clang -c -I DIR tests/reference/xoshiro-ref.c -o xoshiro-ref.o
//   clang++ -std=c++17 -I DIR tests/reference/vectors.cpp xoshiro-ref.o -o vectors && ./vectors

#include "MurmurHash3.cpp"

#include <cstdio>

extern "C" void xo_set(uint32_t a, uint32_t b, uint32_t c, uint32_t d);
extern "C" uint32_t xo_next(void);

static uint32_t splitmix_state;

static uint32_t splitmix_next() {
  splitmix_state += 0x9E3779B9u;
  return fmix32(splitmix_state);
}

int main() {
  const uint32_t mixInputs[] = {0u, 1u, 2u, 0x80000000u, 0x9E3779B9u, 0xDEADBEEFu, 0xFFFFFFFFu, 123456789u};
  std::printf("// fmix32: [вход, выход]\n");
  for (uint32_t x : mixInputs) std::printf("[0x%08X, 0x%08X],\n", x, fmix32(x));

  const uint32_t seeds[] = {0u, 1u, 42u, 2026u, 0x9E3779B9u, 0xFFFFFFFFu};

  std::printf("// splitmix32: [сид, первые 6 выходов]\n");
  for (uint32_t seed : seeds) {
    splitmix_state = seed;
    std::printf("[0x%08X, [", seed);
    for (int i = 0; i < 6; i++) std::printf(i ? ", 0x%08X" : "0x%08X", splitmix_next());
    std::printf("]],\n");
  }

  std::printf("// xoshiro128**, состояние — первые 4 выхода splitmix32 от сида: [сид, первые 8 выходов]\n");
  for (uint32_t seed : seeds) {
    splitmix_state = seed;
    const uint32_t a = splitmix_next(), b = splitmix_next(), c = splitmix_next(), d = splitmix_next();
    xo_set(a, b, c, d);
    std::printf("[0x%08X, [", seed);
    for (int i = 0; i < 8; i++) std::printf(i ? ", 0x%08X" : "0x%08X", xo_next());
    std::printf("]],\n");
  }
  return 0;
}
