import { describe, expect, it } from 'vitest';
import { SOFTWARE_RENDERERS, isSoftwareRenderer } from '../../../src/render/software-renderer.ts';

// Программный рендер (§10, эконом-режим) по строке рендерера — литералами, как их отдают браузеры. Свои: Chromium
// --disable-gpu и headless shell на этой машине (UNMASKED_RENDERER_WEBGL, 2026-10-09), Chromium с GPU (M4), WebKit
// (маскирует — «Apple GPU»). Чужие платформы — по формату их драйверов: Mesa пишет «llvmpipe (LLVM …, 256 bits)» и
// «softpipe», WARP в Windows — «Microsoft Basic Render Driver», ANGLE оборачивает имя в «ANGLE (вендор, имя, API)».

describe('SOFTWARE_RENDERERS', () => {
  it('список — пять имён литералами, в нижнем регистре', () => {
    expect(SOFTWARE_RENDERERS).toStrictEqual(['swiftshader', 'llvmpipe', 'softpipe', 'microsoft basic render driver', 'software']);
  });
});

describe('isSoftwareRenderer', () => {
  it.each([
    'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (LLVM 10.0.0) (0x0000C0DE)), SwiftShader driver)',
    'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)',
    'Google SwiftShader',
    'llvmpipe (LLVM 15.0.7, 256 bits)',
    'ANGLE (Mesa, llvmpipe (LLVM 15.0.7, 256 bits), OpenGL 4.5)',
    'softpipe',
    'ANGLE (Microsoft, Microsoft Basic Render Driver Direct3D11 vs_5_0 ps_5_0, D3D11)',
    'Microsoft Basic Render Driver',
    'Software Rasterizer',
  ])('программный: %s', (gpu) => {
    expect(isSoftwareRenderer(gpu)).toBe(true);
  });

  it.each([
    'ANGLE (Apple, ANGLE Metal Renderer: Apple M4, Unspecified Version)',
    'Apple GPU',
    'apple metal-3',
    'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 (0x00002503) Direct3D11 vs_5_0 ps_5_0, D3D11)',
    'ANGLE (Intel, Mesa Intel(R) UHD Graphics 620 (KBL GT2), OpenGL 4.6)',
    'ANGLE (AMD, AMD Radeon Pro 5500M OpenGL Engine, OpenGL 4.1)',
    'ANGLE (Microsoft, Microsoft Remote Display Adapter Direct3D11 vs_5_0 ps_5_0, D3D11)',
    'SVGA3D; build: RELEASE; LLVM;',
  ])('аппаратный: %s', (gpu) => {
    expect(isSoftwareRenderer(gpu)).toBe(false);
  });
});
