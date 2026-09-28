// Фон грота (§9) — зеркало cave.vert и cave.frag для WebGPU; паритет держит тест на пикселях обоих рендереров.
// Цена на пиксель: 0 выборок текстур, 0 октав шума; 7 sin/cos, 2 exp, 7 хешей без синуса.

struct CaveUniforms {
  uResolution: vec2<f32>,
  uTime: f32,
  uWarmth: f32,
  uCore: vec4<f32>,
};

@group(0) @binding(0) var<uniform> caveUniforms: CaveUniforms;

struct VertexOut {
  @builtin(position) position: vec4<f32>,
  @location(0) vUV: vec2<f32>,
};

@vertex
fn mainVert(@location(0) aPosition: vec2<f32>, @location(1) aUV: vec2<f32>) -> VertexOut {
  var out: VertexOut;
  out.position = vec4<f32>(aPosition, 0.0, 1.0);
  out.vUV = aUV;
  return out;
}

const CAVE0 = vec3<f32>(0.0196, 0.0314, 0.0784);
const CAVE1 = vec3<f32>(0.0431, 0.0706, 0.1882);
const CAVE2 = vec3<f32>(0.0745, 0.1255, 0.2902);
const GLOW = vec3<f32>(0.2471, 0.8784, 0.8157);
const WARM = vec3<f32>(1.0, 0.7686, 0.4196);

fn hash12(p: vec2<f32>) -> f32 {
  var p3 = fract(vec3<f32>(p.x, p.y, p.x) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

fn hash22(p: vec2<f32>) -> vec2<f32> {
  var p3 = fract(vec3<f32>(p.x, p.y, p.x) * vec3<f32>(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}

fn dust(st: vec2<f32>, density: f32, speed: f32, t: f32) -> f32 {
  let q = st * density + vec2<f32>(0.0, t * speed);
  let cell = floor(q);
  let offset = hash22(cell) - 0.5;
  let presence = step(0.75, hash12(cell + 17.0));
  let d = length(fract(q) - 0.5 - offset * 0.7);
  let twinkle = 0.6 + 0.4 * sin(t * 1.7 + hash12(cell) * 6.2831);
  return presence * twinkle * (1.0 - smoothstep(0.0, 0.09, d));
}

@fragment
fn mainFrag(@location(0) vUV: vec2<f32>) -> @location(0) vec4<f32> {
  let u = caveUniforms;
  let p = vUV * u.uResolution;
  let st = p / min(u.uResolution.x, u.uResolution.y);
  let t = u.uTime;

  var colour = mix(CAVE0, CAVE1, smoothstep(0.0, 0.55, vUV.y));
  colour = mix(colour, CAVE2, smoothstep(0.55, 1.0, vUV.y) * 0.8);

  let d = length(p - u.uCore.xy) / u.uCore.z;
  let glow = exp(-d * d * 1.6) * u.uCore.w;
  let halo = exp(-d * 0.9) * 0.16;
  let light = mix(GLOW, WARM, u.uWarmth);

  var c = st * 5.0;
  let slow = t * 0.12;
  c += 0.6 * vec2<f32>(sin(c.y * 1.3 + slow), cos(c.x * 1.1 - slow));
  c += 0.3 * vec2<f32>(sin(c.y * 2.1 - slow * 1.3), cos(c.x * 1.9 + slow * 0.7));
  var band = 1.0 - abs(sin(c.x + 0.5 * c.y));
  band *= band;
  band *= band;
  band *= band;
  let caustic = band * (0.05 + 0.45 * glow) * smoothstep(0.1, 1.0, vUV.y);

  let motes = dust(st, 14.0, 0.035, t) + 0.6 * dust(st + 3.7, 23.0, 0.02, t);

  colour += light * (glow * 0.5 + halo + caustic + motes * 0.35);
  colour = mix(colour, colour * vec3<f32>(1.12, 0.95, 0.82), u.uWarmth * 0.5);
  let v = vUV - 0.5;
  colour *= 1.0 - dot(v, v) * 0.9;
  colour += (hash12(p) - 0.5) / 255.0;
  return vec4<f32>(colour, 1.0);
}
