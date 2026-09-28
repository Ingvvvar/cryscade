#version 300 es
precision highp float;
// Фон грота (§9): градиент глубины, бирюзовый свет ядра под сеткой, каустики, медленная пыль.
// Та же математика — в cave.wgsl; паритет держит тест на пикселях обоих рендереров.
// Цена на пиксель: 0 выборок текстур, 0 октав шума; 7 sin/cos (каустики 5, мерцание пыли 2), 2 exp,
// 7 хешей без синуса (пыль 6, дизеринг 1). Координаты — CSS-пиксели через vUV, а не gl_FragCoord:
// у WebGL и WebGPU разная ось y у gl_FragCoord.

in vec2 vUV;
out vec4 finalColor;

uniform vec2 uResolution;
uniform float uTime;
uniform float uWarmth;
uniform vec4 uCore;

const vec3 CAVE0 = vec3(0.0196, 0.0314, 0.0784);
const vec3 CAVE1 = vec3(0.0431, 0.0706, 0.1882);
const vec3 CAVE2 = vec3(0.0745, 0.1255, 0.2902);
const vec3 GLOW = vec3(0.2471, 0.8784, 0.8157);
const vec3 WARM = vec3(1.0, 0.7686, 0.4196);

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.x, p.y, p.x) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

vec2 hash22(vec2 p) {
  vec3 p3 = fract(vec3(p.x, p.y, p.x) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}

// Пылинка на ячейку: есть в четверти ячеек, смещена внутри неё, мерцает. Сетка ячеек ползёт вверх.
float dust(vec2 st, float density, float speed, float t) {
  vec2 q = st * density + vec2(0.0, t * speed);
  vec2 cell = floor(q);
  vec2 offset = hash22(cell) - 0.5;
  float presence = step(0.75, hash12(cell + 17.0));
  float d = length(fract(q) - 0.5 - offset * 0.7);
  float twinkle = 0.6 + 0.4 * sin(t * 1.7 + hash12(cell) * 6.2831);
  return presence * twinkle * (1.0 - smoothstep(0.0, 0.09, d));
}

void main() {
  vec2 p = vUV * uResolution;
  vec2 st = p / min(uResolution.x, uResolution.y);
  float t = uTime;

  vec3 colour = mix(CAVE0, CAVE1, smoothstep(0.0, 0.55, vUV.y));
  colour = mix(colour, CAVE2, smoothstep(0.55, 1.0, vUV.y) * 0.8);

  float d = length(p - uCore.xy) / uCore.z;
  float glow = exp(-d * d * 1.6) * uCore.w;
  float halo = exp(-d * 0.9) * 0.16;
  vec3 light = mix(GLOW, WARM, uWarmth);

  // Каустики: две итерации синусного искажения; светлые жилы там, где полоса близка к нулю.
  vec2 c = st * 5.0;
  float slow = t * 0.12;
  c += 0.6 * vec2(sin(c.y * 1.3 + slow), cos(c.x * 1.1 - slow));
  c += 0.3 * vec2(sin(c.y * 2.1 - slow * 1.3), cos(c.x * 1.9 + slow * 0.7));
  float band = 1.0 - abs(sin(c.x + 0.5 * c.y));
  band *= band;
  band *= band;
  band *= band;
  float caustic = band * (0.05 + 0.45 * glow) * smoothstep(0.1, 1.0, vUV.y);

  float motes = dust(st, 14.0, 0.035, t) + 0.6 * dust(st + 3.7, 23.0, 0.02, t);

  colour += light * (glow * 0.5 + halo + caustic + motes * 0.35);
  colour = mix(colour, colour * vec3(1.12, 0.95, 0.82), uWarmth * 0.5);
  vec2 v = vUV - 0.5;
  colour *= 1.0 - dot(v, v) * 0.9;
  colour += (hash12(p) - 0.5) / 255.0;
  finalColor = vec4(colour, 1.0);
}
