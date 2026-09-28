#version 300 es
// Фон грота: полноэкранный четырёхугольник прямо в координатах отсечения, без матриц Pixi.

in vec2 aPosition;
in vec2 aUV;
out vec2 vUV;

void main() {
  vUV = aUV;
  gl_Position = vec4(aPosition, 0.0, 1.0);
}
