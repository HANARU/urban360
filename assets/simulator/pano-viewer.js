/* Minimal equirectangular panorama viewer (WebGL 1, no dependencies).
 *
 * Draws a 2:1 equirectangular image either as a perspective view that can be dragged
 * around ('sphere') or as the whole flat panorama ('flat'). lookup(x, y) returns the
 * texture coordinate under a canvas point, so callers can read their own pixel data
 * at the same spot the user is pointing at.
 */
(function () {
  'use strict';

  const VERT = `
    attribute vec2 aPos;
    varying vec2 vUv;
    void main() { vUv = aPos * 0.5 + 0.5; gl_Position = vec4(aPos, 0.0, 1.0); }`;

  const FRAG = `
    precision highp float;
    uniform sampler2D uTex;
    uniform float uYaw, uPitch, uTanHalf, uAspect, uFade;
    uniform int uMode;
    varying vec2 vUv;
    const float PI = 3.14159265358979;
    void main() {
      vec2 uv;
      if (uMode == 1) {
        // Flat: fit the 2:1 image into the canvas, letterboxed.
        vec2 p = vUv - 0.5;
        if (uAspect > 2.0) p.x *= uAspect / 2.0; else p.y *= 2.0 / uAspect;
        uv = vec2(p.x + 0.5, 0.5 - p.y);
        if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) { gl_FragColor = vec4(0.07, 0.07, 0.08, 1.0); return; }
      } else {
        vec2 p = vUv * 2.0 - 1.0;
        vec3 d = normalize(vec3(p.x * uTanHalf * uAspect, p.y * uTanHalf, 1.0));
        float cp = cos(uPitch), sp = sin(uPitch);
        d = vec3(d.x, d.y * cp + d.z * sp, -d.y * sp + d.z * cp);
        float cy = cos(uYaw), sy = sin(uYaw);
        d = vec3(d.x * cy + d.z * sy, d.y, -d.x * sy + d.z * cy);
        uv = vec2(atan(d.x, d.z) / (2.0 * PI) + 0.5, 0.5 - asin(clamp(d.y, -1.0, 1.0)) / PI);
      }
      gl_FragColor = vec4(texture2D(uTex, uv).rgb * uFade, 1.0);
    }`;

  class PanoViewer {
    constructor(canvas) {
      this.canvas = canvas;
      const gl = canvas.getContext('webgl', { antialias: false, preserveDrawingBuffer: true });
      if (!gl) throw new Error('WebGL is not available in this browser.');
      this.gl = gl;
      this.yaw = 0; this.pitch = -0.05; this.fov = 80 * Math.PI / 180;
      this.mode = 'sphere';
      this.textures = new Map();
      this.current = null;
      this.fade = 1;
      this.autoRotate = true;
      this.onChange = null;
      this._initGL();
      this._bindInput();
      this._loop = this._loop.bind(this);
      requestAnimationFrame(this._loop);
    }

    _initGL() {
      const gl = this.gl;
      const sh = (type, src) => {
        const s = gl.createShader(type);
        gl.shaderSource(s, src); gl.compileShader(s);
        if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
        return s;
      };
      const prog = gl.createProgram();
      gl.attachShader(prog, sh(gl.VERTEX_SHADER, VERT));
      gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FRAG));
      gl.linkProgram(prog);
      gl.useProgram(prog);
      const buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
      const loc = gl.getAttribLocation(prog, 'aPos');
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
      this.u = {};
      for (const n of ['uYaw', 'uPitch', 'uTanHalf', 'uAspect', 'uMode', 'uFade']) this.u[n] = gl.getUniformLocation(prog, n);
    }

    /** Upload an image once under a key. Semantic labels want nearest sampling. */
    addTexture(key, img, nearest) {
      const gl = this.gl;
      const t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, img);
      const f = nearest ? gl.NEAREST : gl.LINEAR;
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, f);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, f);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      this.textures.set(key, t);
    }

    /** Switch to another texture; a short dip to black makes the change visible. */
    show(key, animate) {
      if (!this.textures.has(key) || key === this.current) return;
      this.current = key;
      this.fade = animate ? 0.25 : 1;
      this.dirty = true;
    }

    setMode(mode) { this.mode = mode; this.dirty = true; }

    resetView() { this.yaw = 0; this.pitch = -0.05; this.fov = 80 * Math.PI / 180; this.dirty = true; }

    /** Texture coordinate (u, v in 0..1, v down) under a canvas point in CSS pixels, or null. */
    lookup(x, y) {
      const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
      const aspect = w / h;
      const sx = x / w, sy = 1 - y / h;
      if (this.mode === 'flat') {
        let px = sx - 0.5, py = sy - 0.5;
        if (aspect > 2) px *= aspect / 2; else py *= 2 / aspect;
        const u = px + 0.5, v = 0.5 - py;
        return (u < 0 || u > 1 || v < 0 || v > 1) ? null : { u, v };
      }
      const th = Math.tan(this.fov / 2);
      let dx = (sx * 2 - 1) * th * aspect, dy = (sy * 2 - 1) * th, dz = 1;
      const len = Math.hypot(dx, dy, dz); dx /= len; dy /= len; dz /= len;
      const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
      [dy, dz] = [dy * cp + dz * sp, -dy * sp + dz * cp];
      const cy = Math.cos(this.yaw), sy2 = Math.sin(this.yaw);
      [dx, dz] = [dx * cy + dz * sy2, -dx * sy2 + dz * cy];
      let u = Math.atan2(dx, dz) / (2 * Math.PI) + 0.5;
      u -= Math.floor(u);
      return { u, v: 0.5 - Math.asin(Math.max(-1, Math.min(1, dy))) / Math.PI };
    }

    _bindInput() {
      const c = this.canvas;
      let drag = null;
      c.addEventListener('pointerdown', (e) => {
        drag = { x: e.clientX, y: e.clientY, yaw: this.yaw, pitch: this.pitch };
        this.autoRotate = false;
        c.setPointerCapture(e.pointerId);
        c.classList.add('is-dragging');
      });
      c.addEventListener('pointermove', (e) => {
        if (!drag || this.mode === 'flat') return;
        const k = this.fov / c.clientHeight;
        this.yaw = drag.yaw - (e.clientX - drag.x) * k;
        this.pitch = Math.max(-1.45, Math.min(1.45, drag.pitch + (e.clientY - drag.y) * k));
        this.dirty = true;
      });
      const end = () => { drag = null; c.classList.remove('is-dragging'); };
      c.addEventListener('pointerup', end);
      c.addEventListener('pointercancel', end);
      c.addEventListener('wheel', (e) => {
        if (this.mode === 'flat') return;
        e.preventDefault();
        const deg = this.fov * 180 / Math.PI + Math.sign(e.deltaY) * 5;
        this.fov = Math.max(35, Math.min(110, deg)) * Math.PI / 180;
        this.autoRotate = false;
        this.dirty = true;
      }, { passive: false });
    }

    _loop() {
      const gl = this.gl, c = this.canvas;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = Math.round(c.clientWidth * dpr), h = Math.round(c.clientHeight * dpr);
      if (c.width !== w || c.height !== h) { c.width = w; c.height = h; this.dirty = true; }
      if (this.autoRotate && this.mode === 'sphere') { this.yaw += 0.0012; this.dirty = true; }
      if (this.fade < 1) { this.fade = Math.min(1, this.fade + 0.06); this.dirty = true; }
      if (this.dirty && this.current) {
        gl.viewport(0, 0, w, h);
        gl.bindTexture(gl.TEXTURE_2D, this.textures.get(this.current));
        gl.uniform1f(this.u.uYaw, this.yaw);
        gl.uniform1f(this.u.uPitch, this.pitch);
        gl.uniform1f(this.u.uTanHalf, Math.tan(this.fov / 2));
        gl.uniform1f(this.u.uAspect, w / h);
        gl.uniform1i(this.u.uMode, this.mode === 'flat' ? 1 : 0);
        gl.uniform1f(this.u.uFade, this.fade);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        this.dirty = false;
        if (this.onChange) this.onChange();
      }
      requestAnimationFrame(this._loop);
    }
  }

  window.PanoViewer = PanoViewer;
})();
