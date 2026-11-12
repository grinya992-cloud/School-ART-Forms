'use strict';

(() => {
  const canvas = document.querySelector('.fluid-cursor-canvas');
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  if (!canvas || reducedMotion.matches) return;

  const params = {
    downsample: 1,
    densityDissipation: 0.975,
    velocityDissipation: 0.985,
    pressureDissipation: 0.8,
    pressureIterations: 16,
    curl: 24,
    splatRadius: 0.0055,
    idleDelay: 1800
  };
  const contextOptions = {
    alpha: true,
    depth: false,
    stencil: false,
    antialias: false,
    premultipliedAlpha: false
  };
  const gl = canvas.getContext('webgl2', contextOptions)
    || canvas.getContext('webgl', contextOptions);

  if (!gl) {
    console.warn('Эффект жидкого курсора отключен: WebGL недоступен.');
    return;
  }

  const isWebGL2 = typeof WebGL2RenderingContext !== 'undefined'
    && gl instanceof WebGL2RenderingContext;
  let textureWidth = 0;
  let textureHeight = 0;
  let density;
  let velocity;
  let divergence;
  let curl;
  let pressure;
  let framebuffers = [];
  let animationFrame = 0;
  let lastFrameTime = 0;
  let lastInputTime = 0;
  let lastPointer = null;
  let pointerMoved = false;

  function getTextureFormats() {
    if (isWebGL2 && gl.getExtension('EXT_color_buffer_float')) {
      const linear = Boolean(gl.getExtension('OES_texture_float_linear'));
      return {
        type: gl.HALF_FLOAT,
        linear,
        rgba: getSupportedFormat(gl.RGBA16F, gl.RGBA),
        rg: getSupportedFormat(gl.RG16F, gl.RG),
        r: getSupportedFormat(gl.R16F, gl.RED)
      };
    }

    const halfFloat = gl.getExtension('OES_texture_half_float');
    const renderableHalfFloat = halfFloat
      && gl.getExtension('EXT_color_buffer_half_float');

    return {
      type: renderableHalfFloat ? halfFloat.HALF_FLOAT_OES : gl.UNSIGNED_BYTE,
      linear: Boolean(renderableHalfFloat
        && gl.getExtension('OES_texture_half_float_linear')),
      rgba: { internalFormat: gl.RGBA, format: gl.RGBA },
      rg: { internalFormat: gl.RGBA, format: gl.RGBA },
      r: { internalFormat: gl.RGBA, format: gl.RGBA }
    };
  }

  function getSupportedFormat(internalFormat, format) {
    if (supportsRenderTextureFormat(internalFormat, format)) {
      return { internalFormat, format };
    }

    if (internalFormat === gl.R16F) return getSupportedFormat(gl.RG16F, gl.RG);
    if (internalFormat === gl.RG16F) return getSupportedFormat(gl.RGBA16F, gl.RGBA);
    return null;
  }

  function supportsRenderTextureFormat(internalFormat, format) {
    const texture = gl.createTexture();
    const framebuffer = gl.createFramebuffer();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      internalFormat,
      4,
      4,
      0,
      format,
      isWebGL2 ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE,
      null
    );
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER,
      gl.COLOR_ATTACHMENT0,
      gl.TEXTURE_2D,
      texture,
      0
    );
    const supported = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    gl.deleteFramebuffer(framebuffer);
    gl.deleteTexture(texture);
    return supported;
  }

  const formats = getTextureFormats();
  if (!formats.rgba || !formats.rg || !formats.r) {
    console.warn('Эффект жидкого курсора отключен: WebGL-форматы текстур не поддерживаются.');
    return;
  }

  function compileShader(type, source) {
    let shaderSource = source;
    if (isWebGL2) {
      shaderSource = shaderSource
        .replace(/\battribute\b/g, 'in')
        .replace(/\bvarying\b/g, type === gl.VERTEX_SHADER ? 'out' : 'in')
        .replace(/\btexture2D\b/g, 'texture')
        .replace(/\bgl_FragColor\b/g, 'fragColor');
      if (type === gl.FRAGMENT_SHADER) {
        shaderSource = `precision highp float;\nout vec4 fragColor;\n${shaderSource}`;
      }
      shaderSource = `#version 300 es\n${shaderSource}`;
    }

    const shader = gl.createShader(type);
    gl.shaderSource(shader, shaderSource);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const error = gl.getShaderInfoLog(shader);
      gl.deleteShader(shader);
      throw new Error(error || 'Не удалось скомпилировать WebGL-шейдер.');
    }
    return shader;
  }

  function createProgram(vertexShader, fragmentShader) {
    const program = gl.createProgram();
    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fragmentShader);
    gl.bindAttribLocation(program, 0, 'aPosition');
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const error = gl.getProgramInfoLog(program);
      gl.deleteProgram(program);
      throw new Error(error || 'Не удалось связать WebGL-шейдеры.');
    }

    const uniforms = {};
    const count = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < count; i++) {
      const name = gl.getActiveUniform(program, i).name;
      uniforms[name] = gl.getUniformLocation(program, name);
    }
    return {
      bind() {
        gl.useProgram(program);
      },
      uniforms
    };
  }

  function createShaderProgram(fragmentSource) {
    const vertex = compileShader(gl.VERTEX_SHADER, vertexSource);
    const fragment = compileShader(gl.FRAGMENT_SHADER, fragmentSource);
    const program = createProgram(vertex, fragment);
    gl.deleteShader(vertex);
    gl.deleteShader(fragment);
    return program;
  }

  const vertexSource = `
    precision highp float;
    attribute vec2 aPosition;
    varying vec2 vUv;
    varying vec2 vL;
    varying vec2 vR;
    varying vec2 vT;
    varying vec2 vB;
    uniform vec2 texelSize;
    void main() {
      vUv = aPosition * 0.5 + 0.5;
      vL = vUv - vec2(texelSize.x, 0.0);
      vR = vUv + vec2(texelSize.x, 0.0);
      vT = vUv + vec2(0.0, texelSize.y);
      vB = vUv - vec2(0.0, texelSize.y);
      gl_Position = vec4(aPosition, 0.0, 1.0);
    }
  `;
  const fragments = {
    clear: `
      precision highp float;
      varying vec2 vUv;
      uniform sampler2D uTexture;
      uniform float value;
      void main() { gl_FragColor = value * texture2D(uTexture, vUv); }
    `,
    display: `
      precision highp float;
      varying vec2 vUv;
      uniform sampler2D uTexture;
      void main() {
        vec3 dye = texture2D(uTexture, vUv).rgb;
        float amount = max(max(dye.r, dye.g), dye.b);
        vec3 color = dye / max(amount, 0.0001);
        float alpha = clamp(amount * 3.3, 0.0, 1.0);
        gl_FragColor = vec4(color, alpha);
      }
    `,
    splat: `
      precision highp float;
      varying vec2 vUv;
      uniform sampler2D uTarget;
      uniform float aspectRatio;
      uniform vec3 color;
      uniform vec2 point;
      uniform float radius;
      void main() {
        vec2 p = vUv - point;
        p.x *= aspectRatio;
        vec3 splat = exp(-dot(p, p) / radius) * color;
        gl_FragColor = vec4(texture2D(uTarget, vUv).xyz + splat, 1.0);
      }
    `,
    advection: `
      precision highp float;
      varying vec2 vUv;
      uniform sampler2D uVelocity;
      uniform sampler2D uSource;
      uniform vec2 texelSize;
      uniform float dt;
      uniform float dissipation;
      void main() {
        vec2 coord = vUv - dt * texture2D(uVelocity, vUv).xy * texelSize;
        gl_FragColor = dissipation * texture2D(uSource, coord);
        gl_FragColor.a = 1.0;
      }
    `,
    divergence: `
      precision highp float;
      varying vec2 vL;
      varying vec2 vR;
      varying vec2 vT;
      varying vec2 vB;
      uniform sampler2D uVelocity;
      vec2 sampleVelocity(vec2 uv) {
        vec2 multiplier = vec2(1.0);
        if (uv.x < 0.0) { uv.x = 0.0; multiplier.x = -1.0; }
        if (uv.x > 1.0) { uv.x = 1.0; multiplier.x = -1.0; }
        if (uv.y < 0.0) { uv.y = 0.0; multiplier.y = -1.0; }
        if (uv.y > 1.0) { uv.y = 1.0; multiplier.y = -1.0; }
        return multiplier * texture2D(uVelocity, uv).xy;
      }
      void main() {
        float L = sampleVelocity(vL).x;
        float R = sampleVelocity(vR).x;
        float T = sampleVelocity(vT).y;
        float B = sampleVelocity(vB).y;
        gl_FragColor = vec4(0.5 * (R - L + T - B), 0.0, 0.0, 1.0);
      }
    `,
    curl: `
      precision highp float;
      varying vec2 vUv;
      varying vec2 vL;
      varying vec2 vR;
      varying vec2 vT;
      varying vec2 vB;
      uniform sampler2D uVelocity;
      void main() {
        float L = texture2D(uVelocity, vL).y;
        float R = texture2D(uVelocity, vR).y;
        float T = texture2D(uVelocity, vT).x;
        float B = texture2D(uVelocity, vB).x;
        gl_FragColor = vec4(R - L - T + B, 0.0, 0.0, 1.0);
      }
    `,
    vorticity: `
      precision highp float;
      varying vec2 vUv;
      varying vec2 vT;
      varying vec2 vB;
      uniform sampler2D uVelocity;
      uniform sampler2D uCurl;
      uniform float curl;
      uniform float dt;
      void main() {
        float T = texture2D(uCurl, vT).x;
        float B = texture2D(uCurl, vB).x;
        float C = texture2D(uCurl, vUv).x;
        vec2 force = vec2(abs(T) - abs(B), 0.0);
        force *= 1.0 / length(force + 0.00001) * curl * C;
        vec2 vel = texture2D(uVelocity, vUv).xy + force * dt;
        gl_FragColor = vec4(vel, 0.0, 1.0);
      }
    `,
    pressure: `
      precision highp float;
      varying vec2 vUv;
      varying vec2 vL;
      varying vec2 vR;
      varying vec2 vT;
      varying vec2 vB;
      uniform sampler2D uPressure;
      uniform sampler2D uDivergence;
      vec2 boundary(vec2 uv) { return min(max(uv, 0.0), 1.0); }
      void main() {
        float L = texture2D(uPressure, boundary(vL)).x;
        float R = texture2D(uPressure, boundary(vR)).x;
        float T = texture2D(uPressure, boundary(vT)).x;
        float B = texture2D(uPressure, boundary(vB)).x;
        float d = texture2D(uDivergence, vUv).x;
        gl_FragColor = vec4((L + R + B + T - d) * 0.25, 0.0, 0.0, 1.0);
      }
    `,
    gradient: `
      precision highp float;
      varying vec2 vUv;
      varying vec2 vL;
      varying vec2 vR;
      varying vec2 vT;
      varying vec2 vB;
      uniform sampler2D uPressure;
      uniform sampler2D uVelocity;
      vec2 boundary(vec2 uv) { return min(max(uv, 0.0), 1.0); }
      void main() {
        float L = texture2D(uPressure, boundary(vL)).x;
        float R = texture2D(uPressure, boundary(vR)).x;
        float T = texture2D(uPressure, boundary(vT)).x;
        float B = texture2D(uPressure, boundary(vB)).x;
        vec2 vel = texture2D(uVelocity, vUv).xy - vec2(R - L, T - B);
        gl_FragColor = vec4(vel, 0.0, 1.0);
      }
    `
  };

  const programs = {};
  const blit = (() => {
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, -1, 1, 1, 1, 1, -1]),
      gl.STATIC_DRAW
    );
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(
      gl.ELEMENT_ARRAY_BUFFER,
      new Uint16Array([0, 1, 2, 0, 2, 3]),
      gl.STATIC_DRAW
    );
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.enableVertexAttribArray(0);
    return framebuffer => {
      gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
      gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0);
    };
  })();

  function createFramebuffer(textureId, width, height, format, filtering) {
    gl.activeTexture(gl.TEXTURE0 + textureId);
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filtering);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filtering);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(
      gl.TEXTURE_2D, 0, format.internalFormat, width, height, 0,
      format.format, formats.type, null
    );
    const framebuffer = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0
    );
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
      gl.deleteFramebuffer(framebuffer);
      gl.deleteTexture(texture);
      throw new Error('Не удалось создать WebGL framebuffer.');
    }
    gl.viewport(0, 0, width, height);
    gl.clear(gl.COLOR_BUFFER_BIT);
    const target = { texture, framebuffer, textureId };
    framebuffers.push(target);
    return target;
  }

  function createDoubleFramebuffer(textureId, width, height, format, filtering) {
    let read = createFramebuffer(textureId, width, height, format, filtering);
    let write = createFramebuffer(textureId + 1, width, height, format, filtering);
    return {
      get read() { return read; },
      get write() { return write; },
      swap() { [read, write] = [write, read]; }
    };
  }

  function destroyFramebuffers() {
    for (const target of framebuffers) {
      gl.deleteFramebuffer(target.framebuffer);
      gl.deleteTexture(target.texture);
    }
    framebuffers = [];
  }

  function initFramebuffers() {
    destroyFramebuffers();
    textureWidth = Math.max(1, gl.drawingBufferWidth >> params.downsample);
    textureHeight = Math.max(1, gl.drawingBufferHeight >> params.downsample);
    const filtering = formats.linear ? gl.LINEAR : gl.NEAREST;
    density = createDoubleFramebuffer(2, textureWidth, textureHeight, formats.rgba, filtering);
    velocity = createDoubleFramebuffer(0, textureWidth, textureHeight, formats.rg, filtering);
    divergence = createFramebuffer(4, textureWidth, textureHeight, formats.r, gl.NEAREST);
    curl = createFramebuffer(5, textureWidth, textureHeight, formats.r, gl.NEAREST);
    pressure = createDoubleFramebuffer(6, textureWidth, textureHeight, formats.r, gl.NEAREST);
  }

  function clear(target, value) {
    const program = programs.clear;
    program.bind();
    gl.activeTexture(gl.TEXTURE0 + target.read.textureId);
    gl.bindTexture(gl.TEXTURE_2D, target.read.texture);
    gl.uniform1i(program.uniforms.uTexture, target.read.textureId);
    gl.uniform1f(program.uniforms.value, value);
    blit(target.write.framebuffer);
    target.swap();
  }

  function randomColor() {
    const hue = Math.random() * 6;
    const chroma = 0.8;
    const secondary = chroma * (1 - Math.abs(hue % 2 - 1));
    const match = 0.18;
    let color;

    if (hue < 1) color = [chroma, secondary, 0];
    else if (hue < 2) color = [secondary, chroma, 0];
    else if (hue < 3) color = [0, chroma, secondary];
    else if (hue < 4) color = [0, secondary, chroma];
    else if (hue < 5) color = [secondary, 0, chroma];
    else color = [chroma, 0, secondary];

    return color.map(channel => channel + match);
  }

  function splat(x, y, dx, dy, color) {
    const program = programs.splat;
    program.bind();
    gl.uniform1i(program.uniforms.uTarget, velocity.read.textureId);
    gl.uniform1f(program.uniforms.aspectRatio, canvas.width / canvas.height);
    gl.uniform2f(program.uniforms.point, x / canvas.width, 1 - y / canvas.height);
    gl.uniform1f(program.uniforms.radius, params.splatRadius);
    gl.uniform3f(program.uniforms.color, dx, -dy, 1);
    gl.activeTexture(gl.TEXTURE0 + velocity.read.textureId);
    gl.bindTexture(gl.TEXTURE_2D, velocity.read.texture);
    blit(velocity.write.framebuffer);
    velocity.swap();

    gl.uniform1i(program.uniforms.uTarget, density.read.textureId);
    gl.uniform3f(program.uniforms.color, color[0] * 0.3, color[1] * 0.3, color[2] * 0.3);
    gl.activeTexture(gl.TEXTURE0 + density.read.textureId);
    gl.bindTexture(gl.TEXTURE_2D, density.read.texture);
    blit(density.write.framebuffer);
    density.swap();
  }

  function passDivergence() {
    const program = programs.divergence;
    program.bind();
    gl.uniform2f(program.uniforms.texelSize, 1 / textureWidth, 1 / textureHeight);
    gl.uniform1i(program.uniforms.uVelocity, velocity.read.textureId);
    gl.activeTexture(gl.TEXTURE0 + velocity.read.textureId);
    gl.bindTexture(gl.TEXTURE_2D, velocity.read.texture);
    blit(divergence.framebuffer);
  }

  function passCurl() {
    const program = programs.curl;
    program.bind();
    gl.uniform2f(program.uniforms.texelSize, 1 / textureWidth, 1 / textureHeight);
    gl.uniform1i(program.uniforms.uVelocity, velocity.read.textureId);
    gl.activeTexture(gl.TEXTURE0 + velocity.read.textureId);
    gl.bindTexture(gl.TEXTURE_2D, velocity.read.texture);
    blit(curl.framebuffer);
  }

  function render(now) {
    animationFrame = 0;
    if (document.hidden) return;
    const dt = Math.min((now - (lastFrameTime || now)) / 1000, 0.016);
    lastFrameTime = now;
    gl.disable(gl.BLEND);
    gl.viewport(0, 0, textureWidth, textureHeight);

    const advect = programs.advection;
    advect.bind();
    gl.uniform2f(advect.uniforms.texelSize, 1 / textureWidth, 1 / textureHeight);
    gl.uniform1i(advect.uniforms.uVelocity, velocity.read.textureId);
    gl.uniform1i(advect.uniforms.uSource, velocity.read.textureId);
    gl.uniform1f(advect.uniforms.dt, dt);
    gl.uniform1f(advect.uniforms.dissipation, params.velocityDissipation);
    gl.activeTexture(gl.TEXTURE0 + velocity.read.textureId);
    gl.bindTexture(gl.TEXTURE_2D, velocity.read.texture);
    blit(velocity.write.framebuffer);
    velocity.swap();

    advect.bind();
    gl.uniform2f(advect.uniforms.texelSize, 1 / textureWidth, 1 / textureHeight);
    gl.uniform1i(advect.uniforms.uVelocity, velocity.read.textureId);
    gl.uniform1i(advect.uniforms.uSource, density.read.textureId);
    gl.uniform1f(advect.uniforms.dt, dt);
    gl.uniform1f(advect.uniforms.dissipation, params.densityDissipation);
    gl.activeTexture(gl.TEXTURE0 + velocity.read.textureId);
    gl.bindTexture(gl.TEXTURE_2D, velocity.read.texture);
    gl.activeTexture(gl.TEXTURE0 + density.read.textureId);
    gl.bindTexture(gl.TEXTURE_2D, density.read.texture);
    blit(density.write.framebuffer);
    density.swap();

    if (pointerMoved && lastPointer) {
      splat(lastPointer.x, lastPointer.y, lastPointer.dx, lastPointer.dy, lastPointer.color);
      pointerMoved = false;
    }

    passCurl();
    const vorticity = programs.vorticity;
    vorticity.bind();
    gl.uniform2f(vorticity.uniforms.texelSize, 1 / textureWidth, 1 / textureHeight);
    gl.uniform1i(vorticity.uniforms.uVelocity, velocity.read.textureId);
    gl.uniform1i(vorticity.uniforms.uCurl, curl.textureId);
    gl.uniform1f(vorticity.uniforms.curl, params.curl);
    gl.uniform1f(vorticity.uniforms.dt, dt);
    gl.activeTexture(gl.TEXTURE0 + velocity.read.textureId);
    gl.bindTexture(gl.TEXTURE_2D, velocity.read.texture);
    gl.activeTexture(gl.TEXTURE0 + curl.textureId);
    gl.bindTexture(gl.TEXTURE_2D, curl.texture);
    blit(velocity.write.framebuffer);
    velocity.swap();

    passDivergence();
    clear(pressure, params.pressureDissipation);

    const solvePressure = programs.pressure;
    solvePressure.bind();
    gl.uniform2f(solvePressure.uniforms.texelSize, 1 / textureWidth, 1 / textureHeight);
    gl.uniform1i(solvePressure.uniforms.uDivergence, divergence.textureId);
    gl.uniform1i(solvePressure.uniforms.uPressure, pressure.read.textureId);
    gl.activeTexture(gl.TEXTURE0 + divergence.textureId);
    gl.bindTexture(gl.TEXTURE_2D, divergence.texture);
    for (let i = 0; i < params.pressureIterations; i++) {
      gl.uniform1i(solvePressure.uniforms.uPressure, pressure.read.textureId);
      gl.activeTexture(gl.TEXTURE0 + pressure.read.textureId);
      gl.bindTexture(gl.TEXTURE_2D, pressure.read.texture);
      blit(pressure.write.framebuffer);
      pressure.swap();
    }

    const gradient = programs.gradient;
    gradient.bind();
    gl.uniform2f(gradient.uniforms.texelSize, 1 / textureWidth, 1 / textureHeight);
    gl.uniform1i(gradient.uniforms.uPressure, pressure.read.textureId);
    gl.uniform1i(gradient.uniforms.uVelocity, velocity.read.textureId);
    gl.activeTexture(gl.TEXTURE0 + pressure.read.textureId);
    gl.bindTexture(gl.TEXTURE_2D, pressure.read.texture);
    gl.activeTexture(gl.TEXTURE0 + velocity.read.textureId);
    gl.bindTexture(gl.TEXTURE_2D, velocity.read.texture);
    blit(velocity.write.framebuffer);
    velocity.swap();

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    const display = programs.display;
    display.bind();
    gl.uniform1i(display.uniforms.uTexture, density.read.textureId);
    gl.activeTexture(gl.TEXTURE0 + density.read.textureId);
    gl.bindTexture(gl.TEXTURE_2D, density.read.texture);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    blit(null);
    gl.disable(gl.BLEND);

    if (now - lastInputTime < params.idleDelay) {
      animationFrame = requestAnimationFrame(render);
    } else {
      lastFrameTime = 0;
    }
  }

  function startRendering() {
    if (!animationFrame && !document.hidden) {
      lastFrameTime = 0;
      animationFrame = requestAnimationFrame(render);
    }
  }

  function resizeCanvas() {
    const pixelRatio = Math.min(window.devicePixelRatio || 1, 1.5);
    const width = Math.max(1, Math.round(canvas.clientWidth * pixelRatio));
    const height = Math.max(1, Math.round(canvas.clientHeight * pixelRatio));
    if (canvas.width === width && canvas.height === height) return;
    canvas.width = width;
    canvas.height = height;
    initFramebuffers();
  }

  function onPointerMove(event) {
    if (event.pointerType === 'touch' && event.buttons === 0) return;
    const rect = canvas.getBoundingClientRect();
    const x = (event.clientX - rect.left) * canvas.width / rect.width;
    const y = (event.clientY - rect.top) * canvas.height / rect.height;

    if (lastPointer && lastPointer.id === event.pointerId) {
      const scaleX = canvas.width / rect.width;
      const scaleY = canvas.height / rect.height;
      lastPointer = {
        id: event.pointerId,
        x,
        y,
        dx: Math.max(-1200, Math.min(1200, (event.clientX - lastPointer.clientX) * scaleX * 7)),
        dy: Math.max(-1200, Math.min(1200, (event.clientY - lastPointer.clientY) * scaleY * 7)),
        color: randomColor(),
        clientX: event.clientX,
        clientY: event.clientY
      };
      pointerMoved = true;
      lastInputTime = performance.now();
      startRendering();
    } else {
      lastPointer = {
        id: event.pointerId,
        x,
        y,
        dx: 0,
        dy: 0,
        color: randomColor(),
        clientX: event.clientX,
        clientY: event.clientY
      };
    }
  }

  function initialize() {
    try {
      resizeCanvas();
      for (const [name, source] of Object.entries(fragments)) {
        programs[name] = createShaderProgram(source);
      }
      gl.clearColor(0, 0, 0, 0);
      window.addEventListener('pointermove', onPointerMove, { passive: true });
      window.addEventListener('pointerleave', () => { lastPointer = null; });
      window.addEventListener('resize', resizeCanvas, { passive: true });
      document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
          if (animationFrame) cancelAnimationFrame(animationFrame);
          animationFrame = 0;
        } else if (performance.now() - lastInputTime < params.idleDelay) {
          startRendering();
        }
      });
      reducedMotion.addEventListener?.('change', event => {
        if (event.matches && animationFrame) {
          cancelAnimationFrame(animationFrame);
          animationFrame = 0;
        }
      });
    } catch (error) {
      console.error('Не удалось запустить эффект жидкого курсора.', error);
      canvas.style.display = 'none';
    }
  }

  initialize();
})();
