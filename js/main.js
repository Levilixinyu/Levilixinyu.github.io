/* Xinyu Li — interactive homepage
 * All physiology here is a simplified, illustrative simulation. */
(() => {
  "use strict";

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
  const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const gauss = () => {
    let u = 0, v = 0;
    while (!u) u = Math.random();
    while (!v) v = Math.random();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };

  /* ---------- theme ---------- */
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
  };
  const root = document.documentElement;
  if (store.get("theme")) root.dataset.theme = store.get("theme");
  let colors = {};
  const readColors = () => {
    const cs = getComputedStyle(root);
    for (const k of ["ink", "muted", "line", "gold", "signal", "stim", "bg", "z1", "z2", "z3", "z4", "z5"]) {
      colors[k] = cs.getPropertyValue("--" + k).trim();
    }
    colors.zones = [colors.z1, colors.z2, colors.z3, colors.z4, colors.z5];
  };
  readColors();
  $("#themeBtn").addEventListener("click", () => {
    const next = root.dataset.theme === "light" ? "dark" : "light";
    root.dataset.theme = next;
    store.set("theme", next);
    readColors();
  });

  /* ---------- canvas helpers ---------- */
  function fit(canvas) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx, w, h };
  }
  // run draw loops only while their element is on screen
  const visible = new WeakMap();
  const visIO = new IntersectionObserver((es) => es.forEach((e) => visible.set(e.target, e.isIntersecting)), { rootMargin: "100px" });
  const watchVis = (el) => { visible.set(el, false); visIO.observe(el); };

  /* =========================================================
   * Motor unit pool: size-ordered recruitment, rate coding,
   * fatigue, and NMES (synchronous, non-selective recruitment)
   * ========================================================= */
  class MUPool {
    constructor(n = 12, len = 1500, fs = 1000) {
      this.n = n; this.fs = fs; this.len = len;
      this.t = 0;
      this.emg = new Float32Array(len);
      this.mask = new Uint16Array(len);
      this.stim = new Uint8Array(len);
      this.future = new Float32Array(64);
      this.units = [];
      const order = [...Array(n).keys()].sort(() => Math.random() - 0.5);
      for (let i = 0; i < n; i++) {
        const r = i / (n - 1);
        const L = 8 + Math.round(r * 8);
        const tpl = new Float32Array(L);
        for (let k = 0; k < L; k++) {
          const x = (k - L / 2) / (L / 5);
          tpl[k] = -x * Math.exp(-x * x / 2) * 1.65;
        }
        this.units.push({
          th: 0.02 + 0.68 * Math.pow(r, 1.6),      // recruitment threshold (fraction of MVC)
          amp: 0.15 + 1.1 * Math.pow(r, 1.4),     // bigger units → bigger MUAPs
          maxRate: 38 - 14 * r,                   // onion-skin: early units fire faster
          tpl, next: Infinity, rate: 0,
          stimRank: order.indexOf(i) / n,         // spatial (not size) order for NMES
        });
      }
      this.stimEvery = fs / 40;                    // 40 Hz NMES
      this.nextStim = 0;
    }
    rateFor(u, drive, fatigue) {
      const th = u.th * (1 - 0.35 * fatigue);
      if (drive < th) return 0;
      const r = 8 + (u.maxRate - 8) * clamp(((drive - th) / (1 - th)) * 1.6);
      return r * (1 - 0.3 * fatigue);
    }
    addMUAP(u, gain, delay = 0) {
      const tpl = u.tpl;
      for (let k = 0; k < tpl.length; k++) this.future[(this.t + delay + k) % 64] += tpl[k] * u.amp * gain;
    }
    step(nSamples, drive, opt = {}) {
      const fatigue = opt.fatigue || 0;
      const gain = 1 + 0.5 * fatigue;
      const tremor = fatigue * 0.04 * Math.sin(this.t / 90);
      for (let s = 0; s < nSamples; s++) {
        const idx = this.t % this.len;
        let m = 0;
        const d = clamp(drive + tremor);
        this.units.forEach((u, i) => {
          const rate = this.rateFor(u, d, fatigue);
          if (rate <= 0) { u.next = Infinity; u.rate = 0; return; }
          const period = this.fs / rate;
          if (u.next === Infinity) u.next = this.t + Math.random() * period;
          u.rate = rate;
          if (this.t >= u.next) {
            m |= 1 << i;
            this.addMUAP(u, gain);
            u.next = this.t + period * Math.max(0.4, 1 + 0.15 * (1 + fatigue) * gauss());
          }
        });
        let st = 0;
        if (opt.nmes) {
          if (this.t >= this.nextStim) {
            st = 1;
            this.nextStim = this.t + this.stimEvery;
            const f = this.future, t = this.t;
            const art = opt.artifact ?? 1;                       // artifact grows with current
            f[t % 64] += 3.2 * art; f[(t + 1) % 64] -= 2.2 * art; f[(t + 2) % 64] += 0.6 * art;   // stimulus artifact
            const intensity = opt.intensity ?? 0.6;
            this.units.forEach((u, i) => {
              if (u.stimRank < intensity) { m |= 1 << i; this.addMUAP(u, gain * 1.2, 5); } // M-wave
            });
          }
        } else {
          this.nextStim = this.t;
        }
        const fi = this.t % 64;
        this.emg[idx] = this.future[fi] + 0.02 * gauss();
        this.future[fi] = 0;
        this.mask[idx] = m;
        this.stim[idx] = st;
        this.t++;
      }
    }
    rms(n = 300) {
      let s = 0;
      for (let k = 1; k <= n; k++) { const v = this.emg[(this.t - k + this.len * 4) % this.len]; s += v * v; }
      return Math.sqrt(s / n);
    }
    // iterate the ring buffer from oldest to newest
    forEach(fn) {
      for (let j = 0; j < this.len; j++) {
        const idx = (this.t + j) % this.len;
        fn(j, this.emg[idx], this.mask[idx], this.stim[idx]);
      }
    }
  }

  const unitColor = (i, n) => colors.zones[Math.min(4, Math.floor((i / n) * 5))];

  function drawRaster(ctx, pool, x0, y0, w, h, alpha = 1) {
    const rowH = h / pool.n, dx = w / pool.len;
    ctx.globalAlpha = alpha * 0.35;
    ctx.strokeStyle = colors.line;
    ctx.lineWidth = 1;
    for (let i = 0; i <= pool.n; i++) {
      ctx.beginPath(); ctx.moveTo(x0, y0 + i * rowH); ctx.lineTo(x0 + w, y0 + i * rowH); ctx.stroke();
    }
    pool.forEach((j, v, m, st) => {
      const x = x0 + j * dx;
      if (st) {
        ctx.globalAlpha = alpha * 0.35; ctx.fillStyle = colors.stim;
        ctx.fillRect(x, y0, Math.max(1, dx), h);
      }
      if (!m) return;
      ctx.globalAlpha = alpha;
      for (let i = 0; i < pool.n; i++) {
        if (!(m & (1 << i))) continue;
        const y = y0 + h - (i + 1) * rowH;               // smallest unit at the bottom
        ctx.fillStyle = unitColor(i, pool.n);
        ctx.fillRect(x, y + rowH * 0.18, Math.max(1.5, dx * 2), rowH * 0.64);
      }
    });
    ctx.globalAlpha = 1;
  }

  function drawTrace(ctx, pool, x0, y0, w, h, scale, color, glow = 0) {
    const dx = w / pool.len, mid = y0 + h / 2;
    ctx.beginPath();
    pool.forEach((j, v) => {
      const y = clamp(mid - v * scale, y0, y0 + h);
      j ? ctx.lineTo(x0 + j * dx, y) : ctx.moveTo(x0, y);
    });
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.4;
    ctx.shadowColor = color; ctx.shadowBlur = glow;
    ctx.stroke();
    ctx.shadowBlur = 0;
  }

  /* =========================================================
   * HERO — move = voluntary drive, click = NMES burst
   * ========================================================= */
  const hero = $(".hero"), heroCanvas = $("#heroCanvas");
  watchVis(hero);
  const heroPool = new MUPool(12, 1400);
  heroPool.step(1400, 0.14);                                // prefill so the trace starts full
  let heroTarget = 0, heroDrive = 0, nmesUntil = 0, lastMove = 0, lastPt = null;
  hero.addEventListener("pointermove", (e) => {
    const now = performance.now();
    if (lastPt) {
      const dt = Math.max(8, now - lastPt.t);
      const sp = Math.hypot(e.clientX - lastPt.x, e.clientY - lastPt.y) / dt; // px/ms
      heroTarget = clamp(heroTarget + sp * 0.06, 0, 1);
    }
    lastPt = { x: e.clientX, y: e.clientY, t: now };
    lastMove = now;
    activity.bump(0.015);
  });
  hero.addEventListener("pointerdown", (e) => {
    if (e.target.closest("a")) return;
    nmesUntil = performance.now() + 180;                     // short burst: ~4 pulses at 40 Hz
    activity.bump(0.08);
  });
  const hDrive = $("#hDrive"), hMU = $("#hMU"), hRMS = $("#hRMS");
  let heroFrame = 0;
  function heroLoop(now) {
    if (visible.get(hero)) {
      heroTarget *= 0.965;
      const idle = now - lastMove > 2500 ? 0.1 + 0.08 * Math.sin(now / 1400) : 0;
      heroDrive += (Math.max(heroTarget, idle, 0.04) - heroDrive) * 0.08;
      const nmes = now < nmesUntil;
      heroPool.step(reduceMotion ? 0 : 10, heroDrive, { nmes, intensity: 0.7 });

      const { ctx, w, h } = fit(heroCanvas);
      ctx.clearRect(0, 0, w, h);
      // faint grid
      ctx.strokeStyle = colors.line; ctx.globalAlpha = 0.5; ctx.lineWidth = 1;
      for (let x = (heroPool.t / 2) % 80; x < w; x += 80) { ctx.beginPath(); ctx.moveTo(w - x, 0); ctx.lineTo(w - x, h); ctx.stroke(); }
      ctx.globalAlpha = 1;
      drawRaster(ctx, heroPool, 0, h * 0.74, w, h * 0.22, 0.6);
      drawTrace(ctx, heroPool, 0, h * 0.22, w, h * 0.48, h * 0.09, colors.signal, 10);

      if (++heroFrame % 6 === 0) {
        hDrive.textContent = Math.round(heroDrive * 100);
        hMU.textContent = heroPool.units.filter((u) => u.rate > 0).length;
        hRMS.textContent = heroPool.rms().toFixed(2);
      }
    }
    requestAnimationFrame(heroLoop);
  }
  requestAnimationFrame(heroLoop);

  /* ---------- hero role typewriter ---------- */
  const ROLES = [
    "Where neurons meet neural nets",
    "Translator between nerve & muscle",
    "Teaching AI the language of movement",
    "Chaser of the VO₂ plateau",
  ];
  const roleEl = $("#roleText");
  if (!reduceMotion) {
    let r = 0, n = ROLES[0].length, deleting = false;
    const tick = () => {
      const word = ROLES[r];
      if (!deleting && n === word.length) { deleting = true; return setTimeout(tick, 2200); }
      if (deleting && n === 0) { deleting = false; r = (r + 1) % ROLES.length; return setTimeout(tick, 350); }
      n += deleting ? -1 : 1;
      roleEl.textContent = ROLES[r].slice(0, n);
      roleEl.parentElement.setAttribute("aria-label", ROLES[r]);
      setTimeout(tick, deleting ? 28 : 55 + Math.random() * 45);
    };
    setTimeout(tick, 2200);
  }

  /* =========================================================
   * LAB — recruitment simulator
   * ========================================================= */
  const lab = $("#lab");
  watchVis(lab);
  const labPool = new MUPool(12, 1600);
  labPool.step(1600, 0.2);
  const forceEl = $("#force"), fatigueEl = $("#fatigue");
  const nmesBtn = $("#nmesBtn"), rampBtn = $("#rampBtn");
  const forearm = $("#forearm"), bicep = $("#bicep"), pads = [$("#pad1"), $("#pad2")];
  let labNmes = false, ramp = false, rampT0 = 0, labFrame = 0;

  const toggle = (btn, on) => btn.setAttribute("aria-pressed", String(on));
  const stimDev = $("#stimDev"), stimEl = $("#stimI");
  // Intensity is the stimulator's output level, 0–100% as shown on the NEUBIE display (device
  // max at 100%). Thresholds below are illustrative and vary with electrodes and the person:
  // tingling first (sensory fibers), then visible contraction once motor axons are reached.
  // NMES only activates part of a muscle even at high output (MRI studies: roughly 40–60%),
  // so the recruited fraction saturates; in practice output is limited by tolerance.
  const SENS_TH = 8, MOTOR_TH = 20, MAX_PCT = 100;
  const recruitFor = (pct) => (pct <= MOTOR_TH ? 0 : 0.6 * (1 - Math.exp(-(pct - MOTOR_TH) / 35)));
  const syncStim = () => {
    $("#stimVal").textContent = stimEl.value;
    $("#stimScreen").textContent = stimEl.value + "%";
    stimEl.style.setProperty("--fill", (stimEl.value / MAX_PCT) * 100 + "%");
  };
  stimEl.addEventListener("input", () => { if (!labNmes && +stimEl.value > 0) nmesBtn.click(); syncStim(); });
  syncStim();
  nmesBtn.addEventListener("click", () => { labNmes = !labNmes; toggle(nmesBtn, labNmes); stimDev.classList.toggle("on", labNmes); });
  stimDev.addEventListener("click", () => nmesBtn.click());
  rampBtn.addEventListener("click", () => { ramp = !ramp; rampT0 = performance.now(); toggle(rampBtn, ramp); });
  forceEl.addEventListener("input", () => { if (ramp) { ramp = false; toggle(rampBtn, false); } });

  function labNote(force, fatigue, rec) {
    if (labNmes) {
      const mA = +stimEl.value;
      const pct = Math.round(recruitFor(mA) * 100);
      if (mA < SENS_TH) return `Intensity ${mA}%: below sensory threshold. The current is too weak to be felt, and no motor units respond.`;
      if (mA < MOTOR_TH) return `Intensity ${mA}%: above sensory threshold but below motor threshold. The participant feels tingling from cutaneous afferents, no visible contraction yet.`;
      if (mA < 70) return `Intensity ${mA}% recruits ~${pct}% of the pool, by electrode location (nonselective, spatially fixed) rather than by size, all firing in sync with each 40 Hz pulse.`;
      return `Intensity ${mA}%: recruitment levels off near ~${pct}% because units far from the electrodes stay out of reach. In practice the output is capped by what the participant can tolerate, and the synchronous drive makes NMES fatigue muscle quickly.`;
    }
    if (fatigue > 0.4) return "Fatigue: firing rates drop, so extra units are recruited and MUAPs grow — EMG amplitude rises even at the same force.";
    if (force < 0.15) return "Low force: only the smallest, low-threshold (slow-twitch) units are active.";
    if (force < 0.55) return `Size principle in action: ${rec} units recruited in order of size, each firing faster as force rises.`;
    return "High force: large fast-twitch units join in, and rate coding takes over for the final increase in force.";
  }

  function labLoop(now) {
    if (visible.get(lab)) {
      if (ramp) {
        const p = ((now - rampT0) / 10000) % 1;               // 10 s trapezoid-ish ramp
        forceEl.value = Math.round(80 * (p < 0.5 ? p * 2 : (1 - p) * 2));
      }
      const force = forceEl.value / 100, fatigue = fatigueEl.value / 100;
      // current → fraction of the pool recruited: nothing below motor threshold, all units near max
      const mA = +stimEl.value, recruit = recruitFor(mA);
      labPool.step(reduceMotion ? 0 : 12, force, { fatigue, nmes: labNmes && mA > 0, intensity: recruit, artifact: 0.15 + 0.85 * (mA / MAX_PCT) });

      const r = fit($("#labRaster"));
      r.ctx.clearRect(0, 0, r.w, r.h);
      drawRaster(r.ctx, labPool, 34, 6, r.w - 40, r.h - 12);
      r.ctx.fillStyle = colors.muted; r.ctx.font = "10px JetBrains Mono, monospace";
      const rowH = (r.h - 12) / labPool.n;
      labPool.units.forEach((u, i) => {
        const y = 6 + (r.h - 12) - (i + 0.5) * rowH + 3;
        r.ctx.fillStyle = u.rate > 0 ? unitColor(i, labPool.n) : colors.muted;
        r.ctx.fillText("MU" + String(i + 1).padStart(2, "0"), 0, y);
      });
      const e = fit($("#labEMG"));
      e.ctx.clearRect(0, 0, e.w, e.h);
      drawTrace(e.ctx, labPool, 0, 0, e.w, e.h, e.h * 0.11, labNmes ? colors.stim : colors.signal, 6);

      // arm: elbow flexes with force, electrodes flash on pulses
      // elbow flexes with voluntary force, or with the share of the pool the stimulator recruits
      const shown = labNmes ? Math.max(force, 0.75 * recruit) : force;
      forearm.setAttribute("transform", `rotate(${-shown * 95} 70 130)`);
      bicep.style.opacity = 0.3 + 0.7 * shown;
      bicep.setAttribute("rx", 9 + shown * 6);
      const flash = labNmes && labPool.stim.some((v, k) => v && (labPool.t - k + labPool.len) % labPool.len < 25);
      pads.forEach((p) => p.classList.toggle("on", flash));
      stimDev.classList.toggle("pulse", flash);

      if (++labFrame % 5 === 0) {
        const on = labPool.units.map((u, i) => [u, i]).filter(([u]) => u.rate > 0);
        $("#forceVal").textContent = forceEl.value;
        $("#fatigueVal").textContent = fatigueEl.value;
        // voluntary units plus any extra units the stimulator is driving
        const stimOn = labNmes ? labPool.units.filter((u) => u.stimRank < recruit) : [];
        const total = new Set([...on.map(([u]) => u), ...stimOn]).size;
        $("#sRec").textContent = total;
        $("#sFR").textContent = on.length ? Math.round(on.reduce((a, [u]) => a + u.rate, 0) / on.length) : 0;
        const idx = labPool.units.map((u, i) => (u.rate > 0 || stimOn.includes(u) ? i : -1)).filter((i) => i >= 0);
        $("#sBig").textContent = idx.length ? "MU" + String(Math.max(...idx) + 1).padStart(2, "0") : "–";
        $("#labRMS").textContent = `RMS ${labPool.rms().toFixed(2)} mV`;
        const mode = $("#labMode");
        mode.textContent = labNmes ? "NMES + VOLUNTARY" : fatigue > 0.4 ? "VOLUNTARY · FATIGUED" : "VOLUNTARY";
        mode.classList.toggle("stim", labNmes);
        $("#labNote").textContent = labNote(force, fatigue, on.length);
      }
    }
    requestAnimationFrame(labLoop);
  }
  requestAnimationFrame(labLoop);

  /* =========================================================
   * Research card mini-visualizations
   * ========================================================= */
  const vizPools = new Map();
  $$("[data-viz]").forEach((c) => { watchVis(c); if (c.dataset.viz === "mu") vizPools.set(c, new MUPool(6, 600)); });
  function vizLoop(now) {
    const t = now / 1000;
    $$("[data-viz]").forEach((c) => {
      if (!visible.get(c)) return;
      const { ctx, w, h } = fit(c);
      ctx.clearRect(0, 0, w, h);
      const kind = c.dataset.viz;
      if (kind === "coherence") {
        // pooled coherence spectrum with a beta-band peak that breathes
        const sig = 0.18;
        ctx.beginPath();
        for (let x = 0; x <= w; x += 2) {
          const f = (x / w) * 60;
          const peak = (0.5 + 0.18 * Math.sin(t * 1.3)) * Math.exp(-(((f - 22) / 6) ** 2));
          const alpha = 0.25 * Math.exp(-(((f - 10) / 3) ** 2));
          const cv = 0.06 + peak + alpha + 0.025 * Math.sin(f * 1.7 + t * 3);
          const y = h - 14 - cv * (h - 24);
          x ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
        }
        ctx.strokeStyle = colors.signal; ctx.lineWidth = 2; ctx.stroke();
        ctx.lineTo(w, h - 14); ctx.lineTo(0, h - 14); ctx.closePath();
        ctx.globalAlpha = 0.15; ctx.fillStyle = colors.signal; ctx.fill(); ctx.globalAlpha = 1;
        const yc = h - 14 - sig * (h - 24);
        ctx.setLineDash([4, 4]); ctx.strokeStyle = colors.gold; ctx.beginPath(); ctx.moveTo(0, yc); ctx.lineTo(w, yc); ctx.stroke(); ctx.setLineDash([]);
        ctx.fillStyle = colors.muted; ctx.font = "10px JetBrains Mono, monospace";
        ctx.fillText("α", w * (10 / 60) - 3, h - 2); ctx.fillText("β 15–30 Hz", w * (16 / 60), h - 2); ctx.fillText("γ", w * (45 / 60), h - 2);
      } else if (kind === "mu") {
        const pool = vizPools.get(c);
        const drive = 0.15 + 0.75 * (0.5 - 0.5 * Math.cos(t * 0.6)); // slow ramp up & down
        pool.step(reduceMotion ? 0 : 6, drive);
        drawRaster(ctx, pool, 0, 8, w, h - 16);
      } else if (kind === "gait") {
        drawGait(ctx, w, h, t);
      }
    });
    requestAnimationFrame(vizLoop);
  }
  function drawGait(ctx, w, h, t) {
    const phase = (t * 0.9) % 1;
    // same normative walking kinematics as the gait mini-lab; front (ink) leg strikes at phase 0
    const gyFig = h * 0.88;
    stroke(ctx, [[w * 0.06, gyFig + 1], [w * 0.46, gyFig + 1]], colors.line, 1.5);
    figure(ctx, w * 0.26, gyFig, h * 0.8, phase);
    // vertical ground reaction force: the classic double hump during stance (60% of cycle)
    const x0 = w * 0.5, gw = w * 0.46, gy = h * 0.82, gh = h * 0.6;
    const grf = (p) => (p > 0.6 ? 0 : 1.1 * Math.sin((Math.PI * p) / 0.6) + 0.35 * Math.sin((3 * Math.PI * p) / 0.6) * Math.sin((Math.PI * p) / 0.6));
    ctx.lineWidth = 2; ctx.strokeStyle = colors.signal; ctx.beginPath();
    for (let i = 0; i <= 100; i++) { const p = i / 100, y = gy - grf(p) * gh * 0.75; i ? ctx.lineTo(x0 + p * gw, y) : ctx.moveTo(x0, y); }
    ctx.stroke();
    ctx.fillStyle = colors.gold; ctx.beginPath(); ctx.arc(x0 + phase * gw, gy - grf(phase) * gh * 0.75, 4, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = colors.muted; ctx.font = "10px JetBrains Mono, monospace";
    ctx.fillText("vGRF · stance | swing", x0, h - 4);
  }
  requestAnimationFrame(vizLoop);

  // gentle 3D tilt
  $$("[data-tilt]").forEach((card) => {
    card.addEventListener("pointermove", (e) => {
      if (reduceMotion || !card.classList.contains("in")) return;
      const r = card.getBoundingClientRect();
      const x = (e.clientX - r.left) / r.width - 0.5, y = (e.clientY - r.top) / r.height - 0.5;
      card.style.transform = `perspective(900px) rotateY(${x * 7}deg) rotateX(${-y * 7}deg)`;
    });
    card.addEventListener("pointerleave", () => { card.style.transform = ""; });
  });

  /* =========================================================
   * WEARABLE HUD — simulated heart rate from page activity
   * ========================================================= */
  const activity = {
    level: 0,
    bump(v) { this.level = clamp(this.level + v); },
  };
  const HRmax = 190, HRrest = 62;
  const zoneNames = ["REST", "RECOVERY", "ENDURANCE", "TEMPO", "THRESHOLD", "VO₂ MAX"];
  const zoneTime = [0, 0, 0, 0, 0];
  let hr = HRrest, beatClock = 0, steps = 0, kcal = 0, sessionT = 0;
  let lastScrollY = scrollY, lastHud = performance.now();
  const ecg = $("#ecg"), ecgCtx = ecg.getContext("2d"), ecgBuf = new Float32Array(120);
  let ecgPhase = 1;
  const watch = $("#watch"), face = $("#watchFace");
  face.addEventListener("click", () => {
    const open = watch.classList.toggle("open");
    face.setAttribute("aria-expanded", String(open));
  });

  // stylised PQRST complex, phase 0..1 within one beat
  const pqrst = (p) =>
    0.12 * Math.exp(-(((p - 0.12) / 0.03) ** 2)) -
    0.1 * Math.exp(-(((p - 0.21) / 0.008) ** 2)) +
    1.0 * Math.exp(-(((p - 0.24) / 0.012) ** 2)) -
    0.22 * Math.exp(-(((p - 0.27) / 0.01) ** 2)) +
    0.25 * Math.exp(-(((p - 0.45) / 0.05) ** 2));

  const zoneOf = (h) => {
    const pct = h / HRmax;
    if (h < 85) return 0;
    if (pct < 0.6) return 1;
    if (pct < 0.7) return 2;
    if (pct < 0.8) return 3;
    if (pct < 0.9) return 4;
    return 5;
  };

  function hudLoop(now) {
    const dt = Math.min(0.1, (now - lastHud) / 1000);
    lastHud = now;
    sessionT += dt;
    const dy = Math.abs(scrollY - lastScrollY);
    lastScrollY = scrollY;
    steps += dy / 55;
    activity.bump(dy * 0.00035);
    activity.level *= Math.pow(0.55, dt);                    // activity fades within seconds
    const target = HRrest + (HRmax - 10 - HRrest) * activity.level;
    // HR kinetics: on-response is faster than recovery
    const k = target > hr ? 0.9 : 0.22;
    hr += (target - hr) * (1 - Math.exp(-k * dt));
    kcal += Math.max(0, hr - HRrest) * 0.0016 * dt + 0.02 * dt;

    const z = zoneOf(hr);
    if (z > 0) zoneTime[z - 1] += dt;

    // ECG
    const beatsPerSec = hr / 60;
    const samplesPerSec = 70;
    let n = Math.round(samplesPerSec * dt);
    while (n-- > 0) {
      ecgPhase += beatsPerSec / samplesPerSec;
      if (ecgPhase >= 1) {
        ecgPhase -= 1;
        const heart = $("#heart");
        heart.classList.remove("beat"); void heart.offsetWidth; heart.classList.add("beat");
      }
      ecgBuf.copyWithin(0, 1);
      ecgBuf[ecgBuf.length - 1] = pqrst(ecgPhase) + 0.02 * gauss();
    }
    const zc = colors.zones[Math.max(0, z - 1)];
    face.style.setProperty("--zc", zc);
    ecgCtx.clearRect(0, 0, ecg.width, ecg.height);
    ecgCtx.beginPath();
    ecgBuf.forEach((v, i) => { const y = ecg.height * 0.72 - v * ecg.height * 0.6; i ? ecgCtx.lineTo(i, y) : ecgCtx.moveTo(i, y); });
    ecgCtx.strokeStyle = zc; ecgCtx.lineWidth = 1.5; ecgCtx.stroke();

    $("#bpm").textContent = Math.round(hr);
    $("#zone").textContent = (z ? "Z" + z : "Z0") + " · " + zoneNames[z];
    if (watch.classList.contains("open")) {
      const tot = zoneTime.reduce((a, b) => a + b, 0) || 1;
      $$("#zoneBars span").forEach((s, i) => { s.style.height = 6 + 94 * (zoneTime[i] / tot) + "%"; });
      $("#steps").textContent = Math.round(steps).toLocaleString();
      $("#kcal").textContent = kcal.toFixed(1);
      $("#ttime").textContent = Math.floor(sessionT / 60) + ":" + String(Math.floor(sessionT % 60)).padStart(2, "0");
    }
    requestAnimationFrame(hudLoop);
  }
  requestAnimationFrame(hudLoop);

  /* =========================================================
   * Scroll effects: session bar, reveal, nav, timeline
   * ========================================================= */
  const fill = $("#sessionFill"), tl = $(".timeline"), tlFill = $("#tlFill");
  function onScroll() {
    const max = document.documentElement.scrollHeight - innerHeight;
    fill.style.width = (max > 0 ? (scrollY / max) * 100 : 0) + "%";
    const r = tl.getBoundingClientRect();
    tlFill.style.height = clamp((innerHeight * 0.65 - r.top) / r.height) * 100 + "%";
  }
  addEventListener("scroll", onScroll, { passive: true });
  onScroll();

  const revealIO = new IntersectionObserver((es) => es.forEach((e) => {
    if (e.isIntersecting) { e.target.classList.add("in"); revealIO.unobserve(e.target); }
  }), { threshold: 0.12 });
  $$(".reveal").forEach((el) => revealIO.observe(el));

  const navLinks = $$(".nav nav a");
  const navIO = new IntersectionObserver((es) => es.forEach((e) => {
    if (!e.isIntersecting) return;
    navLinks.forEach((a) => a.classList.toggle("active", a.getAttribute("href") === "#" + e.target.id));
  }), { rootMargin: "-45% 0px -50% 0px" });
  $$("section[id]").forEach((s) => navIO.observe(s));

  /* ---------- talk filters ---------- */
  $$("#talkFilters button").forEach((b) => b.addEventListener("click", () => {
    $$("#talkFilters button").forEach((x) => x.classList.toggle("on", x === b));
    $$("#talkList .talk").forEach((t) => t.classList.toggle("hide", b.dataset.f !== "all" && t.dataset.v !== b.dataset.f));
  }));

  $$("#tlFilters button").forEach((b) => b.addEventListener("click", () => {
    $$("#tlFilters button").forEach((x) => x.classList.toggle("on", x === b));
    $$(".tl-item").forEach((t) => t.classList.toggle("hide", b.dataset.t !== "all" && t.dataset.t !== b.dataset.t));
    onScroll();
  }));

  /* =========================================================
   * Gallery + lightbox
   * ========================================================= */
  const galleries = {
    monet: Array.from({ length: 11 }, (_, i) => `img/monet${i + 1}.jpg`),
    view: Array.from({ length: 12 }, (_, i) => `img/view${i + 1}.jpg`),
  };
  const masonry = $("#masonry");
  let current = "monet", lbList = [], lbIndex = 0;
  const galIO = new IntersectionObserver((es) => es.forEach((e) => {
    if (e.isIntersecting) { e.target.classList.add("in"); galIO.unobserve(e.target); }
  }), { threshold: 0.05 });
  function renderGallery(key) {
    current = key;
    masonry.innerHTML = "";
    galleries[key].forEach((src, i) => {
      const fig = document.createElement("figure");
      const img = new Image();
      img.src = src; img.loading = "lazy"; img.alt = (key === "monet" ? "Monet collection photo " : "Travel photo ") + (i + 1);
      fig.appendChild(img);
      fig.style.transitionDelay = (i % 3) * 80 + "ms";
      fig.addEventListener("click", () => openLB(galleries[current], i));
      masonry.appendChild(fig);
      galIO.observe(fig);
    });
  }
  $$("#galTabs button").forEach((b) => b.addEventListener("click", () => {
    $$("#galTabs button").forEach((x) => x.classList.toggle("on", x === b));
    renderGallery(b.dataset.g);
  }));
  renderGallery("monet");

  const lb = $("#lightbox"), lbImg = $("#lbImg");
  // list items are image paths, or { src, dl } when a PDF download should be offered
  function openLB(list, i) {
    lbList = list; lbIndex = i; lb.hidden = false;
    showLB(); document.body.style.overflow = "hidden";
  }
  function closeLB() { lb.hidden = true; document.body.style.overflow = ""; }
  function showLB() {
    const list = lbList;
    $(".lb-prev").hidden = $(".lb-next").hidden = list.length < 2;
    lbIndex = (lbIndex + list.length) % list.length;
    const item = list[lbIndex];
    lbImg.src = item.src || item;
    $("#lbDl").hidden = !item.dl;
    if (item.dl) $("#lbDl").href = item.dl;
    lbImg.style.animation = "none"; void lbImg.offsetWidth; lbImg.style.animation = "";
    $("#lbCount").textContent = list.length > 1 ? `${lbIndex + 1} / ${list.length}` : "";
  }
  $(".lb-close").addEventListener("click", closeLB);
  $(".lb-prev").addEventListener("click", () => { lbIndex--; showLB(); });
  $(".lb-next").addEventListener("click", () => { lbIndex++; showLB(); });
  lb.addEventListener("click", (e) => { if (e.target === lb) closeLB(); });
  addEventListener("keydown", (e) => {
    if (lb.hidden) return;
    if (e.key === "Escape") closeLB();
    if (e.key === "ArrowLeft") { lbIndex--; showLB(); }
    if (e.key === "ArrowRight") { lbIndex++; showLB(); }
  });
  let touchX = null;
  lb.addEventListener("touchstart", (e) => { touchX = e.touches[0].clientX; }, { passive: true });
  lb.addEventListener("touchend", (e) => {
    if (touchX === null) return;
    const dx = e.changedTouches[0].clientX - touchX;
    if (Math.abs(dx) > 50) { lbIndex += dx < 0 ? 1 : -1; showLB(); }
    touchX = null;
  });

  /* =========================================================
   * Chip mini-labs — one tiny interactive demo per research chip
   * ========================================================= */
  const mini = $("#mini"), miniCanvas = $("#miniCanvas"), miniCtl = $("#miniCtl");
  const hash = (i) => { const x = Math.sin(i * 12.9898) * 43758.5453; return x - Math.floor(x) - 0.5; };
  const lerp = (a, b, k) => a + (b - a) * k;
  function text(ctx, s, x, y, color = colors.muted, size = 10, align = "left") {
    ctx.fillStyle = color; ctx.font = `${size}px JetBrains Mono, monospace`; ctx.textAlign = align;
    ctx.fillText(s, x, y); ctx.textAlign = "left";
  }
  function stroke(ctx, pts, color, width = 1.4) {
    ctx.beginPath();
    pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.strokeStyle = color; ctx.lineWidth = width; ctx.stroke();
  }

  // Side-view stick figure facing right. Joint angles follow typical sagittal-plane gait curves
  // (phase 0 = heel strike of the front leg); the lowest foot point is locked to the ground.
  const DEG = Math.PI / 180;
  const bump = (p, c, w) => { let d = p - c; d -= Math.round(d); return Math.exp(-((d / w) ** 2)); };
  // periodic Catmull-Rom interpolation through evenly spaced samples over one stride
  const table = (v) => (p) => {
    const n = v.length, x = (((p % 1) + 1) % 1) * n, i = Math.floor(x), t = x - i;
    const p0 = v[(i - 1 + n) % n], p1 = v[i % n], p2 = v[(i + 1) % n], p3 = v[(i + 2) % n];
    return 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t + (-p0 + 3 * p1 - 3 * p2 + p3) * t * t * t);
  };
  const GAIT = {
    // walking: normative sagittal joint angles (approx. Winter), sampled every 10% of the stride
    walk: {
      hip: table([25, 22, 15, 6, -2, -9, -6, 6, 18, 24]),
      knee: table([3, 15, 17, 10, 5, 8, 38, 58, 42, 12]),
      ankle: table([0, -4, 3, 7, 10, 4, -14, -6, 1, 2]),
      shoulder: (p) => -16 * Math.cos(2 * Math.PI * (p - 0.92)),
      elbow: 18, lean: 3,
    },
    // running: deeper stance knee, ~100° swing knee, forward lean, bent arms, two flight phases
    run: {
      hip: (p) => 12 + 27 * Math.cos(2 * Math.PI * (p - 0.86)),
      knee: (p) => 14 + 28 * bump(p, 0.18, 0.08) + 88 * bump(p, 0.68, 0.13),
      ankle: (p) => 14 * bump(p, 0.18, 0.08) - 22 * bump(p, 0.42, 0.06),
      shoulder: (p) => -34 * Math.cos(2 * Math.PI * (p - 0.86)),
      elbow: 88, lean: 9,
    },
  };
  function legPose(G, H, hip, p) {
    const thigh = H * 0.245, shank = H * 0.245, footL = H * 0.075;
    const h = G.hip(p) * DEG, k = G.knee(p) * DEG, a = G.ankle(p) * DEG;
    const knee = { x: hip.x + Math.sin(h) * thigh, y: hip.y + Math.cos(h) * thigh };
    const sa = h - k;                                       // shank angle from vertical
    const ank = { x: knee.x + Math.sin(sa) * shank, y: knee.y + Math.cos(sa) * shank };
    const fa = sa + Math.PI / 2 + a;                       // foot ⟂ shank, dorsiflexion tilts toes up
    const toe = { x: ank.x + Math.sin(fa) * footL, y: ank.y + Math.cos(fa) * footL };
    const heel = { x: ank.x - Math.sin(fa) * footL * 0.25, y: ank.y - Math.cos(fa) * footL * 0.25 + H * 0.012 };
    return { knee, ank, toe, heel };
  }
  // Pelvis height over one gait cycle: take the raw "lowest foot on the ground" height, smooth it
  // (raw values jump whenever contact switches heel → toe → other foot), then scale the oscillation
  // to a realistic vertical COM excursion: ~2.5% of height walking, ~4% running (2 bumps per stride).
  const pelvisCache = {};
  function pelvisCurve(mode) {
    if (pelvisCache[mode]) return pelvisCache[mode];
    const G = GAIT[mode], N = 200, raw = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const p = i / N;
      const pts = [0, 0.5].flatMap((off) => { const l = legPose(G, 1, { x: 0, y: 0 }, (p + off) % 1); return [l.toe.y, l.heel.y]; });
      raw[i] = -Math.max(...pts);                           // hip offset above ground, H = 1
    }
    const sm = new Float32Array(N), W = 14;
    for (let i = 0; i < N; i++) { let a = 0; for (let k = -W; k <= W; k++) a += raw[(i + k + N) % N]; sm[i] = a / (2 * W + 1); }
    const mean = sm.reduce((a, b) => a + b, 0) / N, lo = Math.min(...sm), hi = Math.max(...sm);
    const amp = mode === "run" ? 0.04 : 0.025;
    const out = sm.map((v) => mean + ((v - mean) / Math.max(1e-6, hi - lo)) * amp);
    return (pelvisCache[mode] = out);
  }
  function figure(ctx, cx, groundY, H, phase, o = {}) {
    const mode = o.run ? "run" : "walk", G = GAIT[mode];
    const torso = H * 0.3, upper = H * 0.15, fore = H * 0.14;
    const curve = pelvisCurve(mode), fi = ((phase % 1) + 1) % 1 * curve.length, i0 = Math.floor(fi) % curve.length;
    const off = curve[i0] + (curve[(i0 + 1) % curve.length] - curve[i0]) * (fi - Math.floor(fi));
    const hip = { x: cx, y: groundY + off * H };
    const legs = [0, 0.5].map((off) => {
      const p = (((phase + off) % 1) + 1) % 1;
      return { ...legPose(G, H, hip, p), back: off > 0, p };
    });
    const lean = G.lean * DEG;
    const neck = { x: hip.x + Math.sin(lean) * torso, y: hip.y - Math.cos(lean) * torso };
    const head = { x: neck.x + Math.sin(lean) * H * 0.08 + H * 0.01, y: neck.y - H * 0.08 };
    const arms = [0, 0.5].map((off) => {
      const p = (((phase + off) % 1) + 1) % 1;
      const s = G.shoulder(p) * DEG;                       // arm swings opposite to the same-side leg
      const elbow = { x: neck.x + Math.sin(s) * upper, y: neck.y + Math.cos(s) * upper };
      const fa = s + G.elbow * DEG;
      const hand = { x: elbow.x + Math.sin(fa) * fore, y: elbow.y + Math.cos(fa) * fore };
      return { elbow, hand, back: off > 0 };
    });
    const ink = o.color || colors.ink;
    ctx.lineCap = "round"; ctx.lineJoin = "round";
    const limb = (pts, back) => stroke(ctx, pts.map((q) => [q.x, q.y]), back ? colors.muted : ink, H * 0.035);
    const leg = (l) => limb([hip, l.knee, l.ank, l.heel, l.toe, l.ank], l.back);
    if (!o.markersOnly) {
      legs.filter((l) => l.back).forEach(leg);
      arms.filter((l) => l.back).forEach((l) => limb([neck, l.elbow, l.hand], true));
      limb([hip, neck], false);
      ctx.beginPath(); ctx.arc(head.x, head.y, H * 0.065, 0, Math.PI * 2);
      ctx.strokeStyle = ink; ctx.lineWidth = H * 0.03; ctx.stroke();
      legs.filter((l) => !l.back).forEach(leg);
      arms.filter((l) => !l.back).forEach((l) => limb([neck, l.elbow, l.hand], false));
    }
    if (o.mask) {
      ctx.fillStyle = colors.signal;
      ctx.beginPath(); ctx.ellipse(head.x + H * 0.07, head.y + H * 0.03, H * 0.03, H * 0.04, 0, 0, Math.PI * 2); ctx.fill();
    }
    if (o.markers) {
      const all = [head, neck, hip, ...legs.flatMap((l) => [l.knee, l.ank, l.heel, l.toe]), ...arms.flatMap((l) => [l.elbow, l.hand])];
      all.forEach((q) => {
        ctx.beginPath(); ctx.arc(q.x, q.y, H * 0.022, 0, Math.PI * 2);
        ctx.fillStyle = "#f4f7ff"; ctx.shadowColor = colors.signal; ctx.shadowBlur = 8; ctx.fill(); ctx.shadowBlur = 0;
      });
    }
    return { head, neck, hip, legs, arms };
  }
  function belt(ctx, x0, x1, y, offset) {
    ctx.fillStyle = colors.line; ctx.fillRect(x0, y, x1 - x0, 7);
    ctx.strokeStyle = colors.muted; ctx.lineWidth = 1;
    for (let x = x0 + (((-offset) % 18) + 18) % 18; x < x1; x += 18) { ctx.beginPath(); ctx.moveTo(x, y + 1); ctx.lineTo(x, y + 6); ctx.stroke(); }
    ctx.beginPath(); ctx.arc(x0, y + 3.5, 5, 0, Math.PI * 2); ctx.arc(x1, y + 3.5, 5, 0, Math.PI * 2); ctx.fillStyle = colors.muted; ctx.fill();
  }

  const EGGS = {
    /* ---- shared neural drive → EMG–EMG coherence ---- */
    coherence: {
      title: "EMG–EMG coherence · shoulder",
      note: "Two muscles that share synaptic input fire with a common rhythm — that shows up as a coherence peak (here ~20 Hz, β band). Drag the slider to change how much drive they share.",
      init(st) { st.drive = 0.6; },
      controls(st) {
        const l = document.createElement("label");
        l.innerHTML = `shared neural drive <input type="range" min="0" max="100" value="60">`;
        l.querySelector("input").addEventListener("input", (e) => { st.drive = e.target.value / 100; });
        return [l];
      },
      draw(ctx, w, h, t, st) {
        const W = w * 0.52, N = 220, i0 = Math.floor(t * 300);
        const shared = (i) => Math.sin((2 * Math.PI * i) / 15) * (0.55 + 0.45 * Math.sin(i / 37));
        ["Supraspinatus", "Infraspinatus"].forEach((name, k) => {
          const yc = h * (0.3 + k * 0.4), amp = h * 0.11, pts = [];
          for (let j = 0; j < N; j++) {
            const i = i0 + j;
            const v = st.drive * shared(i) * 0.9 + (1 - st.drive * 0.6) * hash(i * 7 + k * 1013) * 1.7;
            pts.push([10 + (j / N) * W, yc - v * amp]);
          }
          stroke(ctx, pts, k ? colors.gold : colors.signal);
          text(ctx, name, 12, yc - amp - 8);
        });
        const x0 = w * 0.6, x1 = w - 14, yb = h - 24, yt = 22;
        const coh = (f) => clamp(0.03 + 0.025 * hash(Math.floor(f) * 31 + Math.floor(t * 4) * 97) + st.drive ** 2 * 0.88 * Math.exp(-(((f - 20) / 3.5) ** 2)) + st.drive * 0.12 * Math.exp(-(((f - 10) / 3) ** 2)));
        const pts = [];
        for (let f = 0; f <= 50; f += 0.5) pts.push([x0 + (f / 50) * (x1 - x0), yb - coh(f) * (yb - yt)]);
        ctx.beginPath(); pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
        ctx.lineTo(x1, yb); ctx.lineTo(x0, yb); ctx.closePath();
        ctx.globalAlpha = 0.18; ctx.fillStyle = colors.signal; ctx.fill(); ctx.globalAlpha = 1;
        stroke(ctx, pts, colors.signal, 2);
        const yc = yb - 0.08 * (yb - yt);
        ctx.setLineDash([4, 4]); stroke(ctx, [[x0, yc], [x1, yc]], colors.gold, 1); ctx.setLineDash([]);
        stroke(ctx, [[x0, yt], [x0, yb], [x1, yb]], colors.line, 1);
        text(ctx, "0", x0, yb + 13); text(ctx, "20 Hz", x0 + 0.4 * (x1 - x0), yb + 13, colors.muted, 10, "center"); text(ctx, "50", x1, yb + 13, colors.muted, 10, "right");
        text(ctx, `|Coh|² @20 Hz = ${coh(20).toFixed(2)}`, x1, yt - 6, colors.ink, 11, "right");
      },
    },

    /* ---- surface EMG → individual motor unit spike trains ---- */
    decomp: {
      title: "Motor unit decomposition",
      note: "Surface EMG is the sum of many motor unit action potentials. Decomposition unmixes it into individual spike trains, so you can read each unit's firing rate and recruitment threshold.",
      init(st) { st.split = false; st.p = 0; },
      controls(st) {
        const b = document.createElement("button");
        b.textContent = "Decompose ▸";
        b.addEventListener("click", () => { st.split = !st.split; b.textContent = st.split ? "◂ Recompose" : "Decompose ▸"; b.classList.toggle("on", st.split); });
        return [b];
      },
      draw(ctx, w, h, t, st) {
        st.p += ((st.split ? 1 : 0) - st.p) * 0.06;
        const units = [9, 12, 15, 19].map((rate, u) => ({ per: 1000 / rate, amp: 0.45 + u * 0.28, wid: 2.2 + u * 0.5, ph: u * 37, rate }));
        const N = 520, i0 = Math.floor(t * 420), x0 = 70, W = w - x0 - 14;
        const val = (U, u, i) => {
          const k = Math.floor((i + U.ph) / U.per);
          let v = 0, spike = false;
          for (let s = k - 1; s <= k + 1; s++) {
            const ts = Math.round(s * U.per - U.ph + hash(s * 13 + u * 101) * U.per * 0.15);
            const x = (i - ts) / U.wid;
            v += -x * Math.exp((-x * x) / 2) * U.amp * 1.6;
            if (i === ts) spike = true;
          }
          return [v, spike];
        };
        const y0 = h * 0.2, lane = (u) => h * (0.42 + u * 0.155), p = st.p;
        const comp = [];
        const parts = units.map(() => []), spikes = units.map(() => []);
        for (let j = 0; j < N; j++) {
          const i = i0 + j, x = x0 + (j / N) * W;
          let sum = 0.05 * hash(i * 3.1);
          units.forEach((U, u) => {
            const [v, s] = val(U, u, i);
            sum += v; parts[u].push([x, v]);
            if (s) spikes[u].push(x);
          });
          comp.push([x, y0 - sum * h * 0.05]);
        }
        ctx.globalAlpha = 1 - 0.55 * p; stroke(ctx, comp, colors.ink, 1.2); ctx.globalAlpha = 1;
        text(ctx, "sEMG", 12, y0 + 4, colors.ink);
        units.forEach((U, u) => {
          const yc = lerp(y0, lane(u), p), col = colors.zones[u];
          ctx.globalAlpha = 0.15 + 0.85 * p;
          stroke(ctx, parts[u].map(([x, v]) => [x, yc - v * h * 0.035]), col, 1.3);
          if (p > 0.7) {
            ctx.globalAlpha = (p - 0.7) / 0.3;
            text(ctx, `MU${u + 1}`, 12, yc + 4, col);
            text(ctx, `${U.rate} Hz`, 44, yc + 4, colors.muted, 9);
            ctx.fillStyle = col;
            spikes[u].forEach((x) => ctx.fillRect(x - 0.75, yc - h * 0.065, 1.5, 5));
          }
          ctx.globalAlpha = 1;
        });
      },
    },

    /* ---- wearable foot-drop FES sleeve ---- */
    fes: {
      title: "FES sleeve · foot drop",
      note: "A wearable functional electrical stimulation (FES) sleeve stimulates the tibialis anterior during swing, so the ankle dorsiflexes and the toes clear the ground. Hold the button to stimulate — intensity ramps up and down like a real stimulator.",
      init(st) { st.on = false; st.level = 0; },
      controls(st) {
        const b = document.createElement("button");
        b.textContent = "⚡ Hold to stimulate";
        const on = (v) => (e) => { e.preventDefault(); st.on = v; b.classList.toggle("on", v); };
        b.addEventListener("pointerdown", on(true));
        ["pointerup", "pointerleave", "pointercancel"].forEach((ev) => b.addEventListener(ev, on(false)));
        b.addEventListener("keydown", (e) => { if (e.key === " " || e.key === "Enter") on(true)(e); });
        b.addEventListener("keyup", (e) => { if (e.key === " " || e.key === "Enter") on(false)(e); });
        return [b];
      },
      draw(ctx, w, h, t, st) {
        st.level += ((st.on ? 1 : 0) - st.level) * (st.on ? 0.05 : 0.08);
        const L = st.level, pulse = st.on && Math.floor(t * 40) % 2 === 0;
        const knee = { x: w * 0.2, y: h * 0.12 }, ank = { x: w * 0.23, y: h * 0.68 };
        const skin = root.dataset.theme === "light" ? "#e2d3b5" : "#3a4c74";
        // thigh stub + knee
        ctx.fillStyle = skin;
        ctx.beginPath(); ctx.moveTo(knee.x - 24, 0); ctx.lineTo(knee.x + 24, 0); ctx.lineTo(knee.x + 20, knee.y); ctx.lineTo(knee.x - 20, knee.y); ctx.fill();
        ctx.beginPath(); ctx.arc(knee.x, knee.y, 21, 0, Math.PI * 2); ctx.fill();
        // tapered shank with calf bulge at the back
        ctx.beginPath();
        ctx.moveTo(knee.x + 19, knee.y);
        ctx.quadraticCurveTo(knee.x + 22, (knee.y + ank.y) / 2, ank.x + 10, ank.y);
        ctx.lineTo(ank.x - 10, ank.y);
        ctx.quadraticCurveTo(knee.x - 34, knee.y + h * 0.2, knee.x - 19, knee.y);
        ctx.closePath(); ctx.fill();
        // tibialis anterior (front of shank) brightens as it is recruited
        ctx.save(); ctx.translate(knee.x + 12, knee.y + h * 0.24); ctx.rotate(-0.04);
        ctx.beginPath(); ctx.ellipse(0, 0, 6 + L * 3, h * 0.19, 0, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(226,104,122,${0.25 + 0.7 * L})`; ctx.shadowColor = "#e2687a"; ctx.shadowBlur = 12 * L; ctx.fill(); ctx.restore();
        // wearable sleeve with electrodes
        ctx.save(); ctx.translate(knee.x + 1, knee.y + h * 0.12); ctx.rotate(-0.04);
        ctx.fillStyle = "rgba(14,22,40,0.78)"; ctx.strokeStyle = colors.signal; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.roundRect(-27, 0, 52, h * 0.24, 9); ctx.fill(); ctx.stroke();
        [h * 0.03, h * 0.15].forEach((y) => {
          ctx.fillStyle = pulse ? colors.stim : "#cfd6e4";
          ctx.shadowColor = colors.stim; ctx.shadowBlur = pulse ? 14 : 0;
          ctx.beginPath(); ctx.roundRect(8, y, 13, 15, 3); ctx.fill(); ctx.shadowBlur = 0;
        });
        ctx.fillStyle = colors.signal; ctx.beginPath(); ctx.arc(-14, h * 0.12, 3, 0, Math.PI * 2); ctx.fill();
        ctx.restore();
        // foot: dropped (plantarflexed) → dorsiflexed under stimulation
        const ang = lerp(0.45, -0.2, L), fl = Math.min(w * 0.17, 90);
        ctx.save(); ctx.translate(ank.x, ank.y); ctx.rotate(ang);
        ctx.fillStyle = skin;
        ctx.beginPath();
        ctx.moveTo(-16, -8); ctx.quadraticCurveTo(-22, 14, -8, 16);
        ctx.lineTo(fl - 6, 16); ctx.quadraticCurveTo(fl + 4, 14, fl, 4);
        ctx.quadraticCurveTo(fl * 0.5, -6, 8, -12); ctx.closePath(); ctx.fill();
        ctx.beginPath(); ctx.arc(0, 0, 11, 0, Math.PI * 2); ctx.fill();
        ctx.restore();
        const gy = h * 0.9;
        ctx.setLineDash([5, 5]); stroke(ctx, [[w * 0.04, gy], [w * 0.5, gy]], colors.muted, 1); ctx.setLineDash([]);
        const toeY = ank.y + Math.sin(ang) * fl + 16;
        text(ctx, L > 0.6 ? "toe clearance ✓" : toeY > gy - 6 ? "toe drag ✗" : "", ank.x + fl * 0.3, gy + 14, L > 0.6 ? colors.signal : colors.z5);
        text(ctx, `ankle ${ang > 0 ? "plantar" : "dorsi"} ${Math.abs(Math.round((ang * 180) / Math.PI))}°`, 12, h - 10, colors.ink);
        // stimulus waveform
        // biphasic pulses drawn explicitly (sampling per pixel would alias them away)
        const x0 = w * 0.56, x1 = w - 14, yc = h * 0.45, pts = [[x0, yc]];
        const gap = (x1 - x0) / 10, shift = ((t * 40) % 1) * gap, amp = L * h * 0.22;
        for (let x = x0 + gap - shift; x < x1 - 6; x += gap) {
          pts.push([x, yc], [x, yc - amp], [x + 2.5, yc - amp], [x + 2.5, yc + amp], [x + 5, yc + amp], [x + 5, yc]);
        }
        pts.push([x1, yc]);
        stroke(ctx, pts, colors.stim, 1.5);
        stroke(ctx, [[x0, yc], [x1, yc]], colors.line, 1);
        text(ctx, "STIM OUTPUT", x0, h * 0.12);
        text(ctx, `40 Hz · biphasic · ${Math.round(L * 35)} mA`, x0, h * 0.12 + 14, colors.ink);
        ctx.fillStyle = colors.line; ctx.fillRect(x0, h * 0.82, x1 - x0, 6);
        ctx.fillStyle = colors.stim; ctx.fillRect(x0, h * 0.82, (x1 - x0) * L, 6);
        text(ctx, "intensity ramp", x0, h * 0.82 - 6);
      },
    },

    /* ---- motion capture + instrumented treadmill ---- */
    gait: {
      title: "Gait lab · motion capture",
      note: "Reflective markers on each segment are tracked in 3D while an instrumented treadmill measures ground reaction forces — vertical GRF has the classic double hump. Switch to the markers-only view to see what the cameras see.",
      init(st) { st.markers = false; st.trail = []; },
      controls(st) {
        const b = document.createElement("button");
        b.textContent = "Markers view";
        b.addEventListener("click", () => { st.markers = !st.markers; b.classList.toggle("on", st.markers); b.textContent = st.markers ? "Skeleton view" : "Markers view"; });
        return [b];
      },
      draw(ctx, w, h, t, st) {
        const phase = (t * 0.85) % 1, gy = h * 0.84, cx = w * 0.27, H = h * 0.74;
        belt(ctx, w * 0.06, w * 0.48, gy, t * 60);
        const f = figure(ctx, cx, gy, H, phase, { markers: st.markers, markersOnly: st.markers });
        st.trail.push(f.legs.map((l) => [l.ank.x, l.ank.y]));
        if (st.trail.length > 80) st.trail.shift();
        if (st.markers) {
          [0, 1].forEach((k) => {
            const pts = st.trail.map((p, i) => [p[k][0] - (st.trail.length - 1 - i) * 1.2, p[k][1]]);
            ctx.globalAlpha = 0.6; stroke(ctx, pts, k ? colors.gold : colors.signal, 1.2); ctx.globalAlpha = 1;
          });
        }
        const grf = (p) => (p > 0.6 ? 0 : 1.1 * Math.sin((Math.PI * p) / 0.6) + 0.35 * Math.sin((3 * Math.PI * p) / 0.6) * Math.sin((Math.PI * p) / 0.6));
        const x0 = w * 0.56, x1 = w - 14, yb = h - 26, gh = h * 0.6;
        stroke(ctx, [[x0, yb - gh], [x0, yb], [x1, yb]], colors.line, 1);
        // the stance leg is the one whose phase sits in 0–0.6 of its own cycle
        [0, 0.5].forEach((off, k) => {
          const pts = [];
          for (let i = 0; i <= 100; i++) pts.push([x0 + (i / 100) * (x1 - x0), yb - grf(((i / 100) + off) % 1) * gh * 0.8]);
          stroke(ctx, pts, k ? colors.gold : colors.signal, 1.6);
        });
        const cur = x0 + phase * (x1 - x0);
        ctx.setLineDash([3, 3]); stroke(ctx, [[cur, yb - gh], [cur, yb]], colors.muted, 1); ctx.setLineDash([]);
        text(ctx, "vGRF (× body weight) · L / R", x0, yb - gh - 6);
        text(ctx, "gait cycle →", x1, yb + 14, colors.muted, 10, "right");
      },
    },

    /* ---- graded exercise test with a metabolic cart ---- */
    vo2: {
      title: "VO₂max test · graded treadmill",
      note: "Speed and grade rise every stage while a metabolic cart measures expired O₂ and CO₂ breath by breath. VO₂ climbs linearly with workload, then plateaus even as work keeps rising — that plateau is VO₂max. (Time compressed: 1 s ≈ 1 min.)",
      init(st) { st.t0 = null; st.runPhase = 0; st.last = null; },
      controls(st) {
        const b = document.createElement("button");
        b.textContent = "↻ Restart test";
        b.addEventListener("click", () => { st.t0 = null; st.hist = []; });
        return [b];
      },
      draw(ctx, w, h, t, st) {
        if (st.t0 === null) { st.t0 = t; st.hist = []; }
        const dt = st.last === null ? 0 : Math.min(0.05, t - st.last); st.last = t;
        const END = 13, tm = Math.min(END, t - st.t0), done = t - st.t0 >= END;
        const stage = Math.min(5, Math.floor(tm / 2));
        // walk for the first stages, switch to running above the walk–run transition (~7.5 km/h)
        const speed = done ? 4 : [5, 6.5, 8, 9.5, 11, 12.5][stage], grade = done ? 0 : 1 + stage * 1.5;
        const running = speed >= 7.5;
        const raw = 10 + 4.4 * tm, vo2 = raw < 46 ? raw : 52 - 6 * Math.exp(-(raw - 46) / 6);
        const hr = Math.min(194, 72 + 9.6 * tm), rer = Math.min(1.16, 0.8 + 0.028 * tm);
        if (!done && (!st.hist.length || tm - st.hist[st.hist.length - 1][0] > 0.08)) st.hist.push([tm, vo2, hr]);
        st.runPhase += dt * (running ? 1.2 + speed * 0.02 : 0.75 + speed * 0.04);   // stride frequency (Hz)
        // metabolic cart
        const cartX = w * 0.04, cartY = h * 0.42;
        ctx.fillStyle = colors.line; ctx.fillRect(cartX, cartY, w * 0.07, h * 0.42);
        ctx.fillStyle = colors.signal; ctx.globalAlpha = 0.7; ctx.fillRect(cartX + 4, cartY + 6, w * 0.07 - 8, 16); ctx.globalAlpha = 1;
        text(ctx, "O₂ CO₂", cartX + w * 0.035, cartY + 18, "#04221b", 8, "center");
        // treadmill, tilted by grade (exaggerated for visibility)
        const tx = w * 0.3, gy = h * 0.86, ang = Math.atan(grade / 100) * 2.5, H = h * 0.62;
        ctx.save(); ctx.translate(tx, gy); ctx.rotate(-ang);
        belt(ctx, -w * 0.14, w * 0.14, 0, t * speed * 7);
        const f = figure(ctx, 0, 0, H, st.runPhase % 1, { run: running, mask: true });
        ctx.restore();
        // breathing tube from mask to cart
        const ca = Math.cos(-ang), sa = Math.sin(-ang);
        const mx = tx + (f.head.x + H * 0.08) * ca - (f.head.y + H * 0.05) * sa, my = gy + (f.head.x + H * 0.08) * sa + (f.head.y + H * 0.05) * ca;
        ctx.beginPath(); ctx.moveTo(mx, my);
        ctx.bezierCurveTo(mx + 10, my + 50, cartX + w * 0.12, cartY - 40, cartX + w * 0.07, cartY + 8);
        ctx.strokeStyle = colors.signal; ctx.lineWidth = 2; ctx.stroke();
        text(ctx, `${running ? "run" : "walk"} · ${speed.toFixed(1)} km/h · ${grade.toFixed(1)}%`, tx, h - 4, colors.ink, 10, "center");
        // chart
        const x0 = w * 0.56, x1 = w - 14, yt = 34, yb = h - 24;
        const X = (m) => x0 + (m / END) * (x1 - x0), Y = (v) => yb - (v / 60) * (yb - yt);
        stroke(ctx, [[x0, yt], [x0, yb], [x1, yb]], colors.line, 1);
        for (let s = 2; s < END; s += 2) { ctx.setLineDash([2, 4]); stroke(ctx, [[X(s), yt], [X(s), yb]], colors.line, 1); ctx.setLineDash([]); }
        ctx.globalAlpha = 0.6; stroke(ctx, st.hist.map(([m, , r]) => [X(m), Y((r / 200) * 60)]), colors.z5, 1.2); ctx.globalAlpha = 1;
        stroke(ctx, st.hist.map(([m, v]) => [X(m), Y(v)]), colors.gold, 2.2);
        text(ctx, `VO₂ ${vo2.toFixed(1)}`, x0, 12, colors.gold, 11);
        text(ctx, `HR ${Math.round(hr)}`, x0 + 92, 12, colors.z5, 11);
        text(ctx, `RER ${rer.toFixed(2)}`, x0 + 160, 12, colors.ink, 11);
        text(ctx, "ml·kg⁻¹·min⁻¹", x0, 26, colors.muted, 9);
        text(ctx, "min", x1, yb + 14, colors.muted, 9, "right");
        if (done) {
          ctx.setLineDash([5, 4]); stroke(ctx, [[x0, Y(52)], [x1, Y(52)]], colors.signal, 1); ctx.setLineDash([]);
          text(ctx, "plateau → VO₂max ≈ 52 ✓", x1, Y(52) - 6, colors.signal, 11, "right");
        } else {
          text(ctx, `stage ${stage + 1}`, x1, 12, colors.muted, 10, "right");
        }
      },
    },
  };

  let activeEgg = null, eggState = {}, eggLoopOn = false;
  watchVis(miniCanvas);
  function openEgg(key) {
    $$(".chip-egg").forEach((c) => c.setAttribute("aria-expanded", String(c.dataset.egg === key)));
    if (!key || key === activeEgg) { activeEgg = null; mini.hidden = true; $$(".chip-egg").forEach((c) => c.setAttribute("aria-expanded", "false")); return; }
    activeEgg = key; eggState = {};
    const egg = EGGS[key];
    egg.init(eggState);
    $("#miniTitle").textContent = egg.title;
    $("#miniNote").textContent = egg.note;
    miniCtl.replaceChildren(...egg.controls(eggState));
    mini.hidden = false;
    activity.bump(0.05);
    if (!eggLoopOn) { eggLoopOn = true; requestAnimationFrame(eggLoop); }
  }
  function eggLoop(now) {
    if (!activeEgg) { eggLoopOn = false; return; }
    if (visible.get(miniCanvas) !== false) {
      const { ctx, w, h } = fit(miniCanvas);
      ctx.clearRect(0, 0, w, h);
      EGGS[activeEgg].draw(ctx, w, h, reduceMotion ? 0 : now / 1000, eggState);
    }
    requestAnimationFrame(eggLoop);
  }
  $$(".chip-egg").forEach((c) => c.addEventListener("click", () => { $("#chipsHint").classList.add("used"); openEgg(c.dataset.egg); }));
  $("#miniClose").addEventListener("click", () => openEgg(null));

  /* =========================================================
   * 🐈 easter egg — click the chip, or type "cat" / "meow"
   * ========================================================= */
  const catLayer = $("#catLayer");
  // real cats, picked at random: asleep in the bed, a loaf peeking up, a big stretch, or a belly flop from the side
  const CATS = [
    { cls: "cat-bed", src: "img/cat-bed.png", bubble: "z z z…", ms: 7000 },
    { cls: "cat-loaf", src: "img/cat-loaf.png", bubble: "meow?", ms: 4200 },
    { cls: "cat-stretch", src: "img/cat-stretch.png", bubble: "*stretch~*", ms: 6500 },
    { cls: "cat-flop", src: "img/cat-flop.png", bubble: "pet me? ♡", ms: 5000 },
  ];
  let lastCat = -1;
  function releaseCat() {
    if (catLayer.childElementCount > 2) return;              // don't pile up cats
    let k = Math.floor(Math.random() * CATS.length);
    if (k === lastCat) k = (k + 1 + Math.floor(Math.random() * (CATS.length - 1))) % CATS.length; // never the same twice in a row
    lastCat = k;
    const c = CATS[k];
    const el = document.createElement("div");
    el.className = "cat " + c.cls;
    el.style.left = c.cls === "cat-loaf" ? 8 + Math.random() * 70 + "%" : "";
    el.innerHTML = `<img src="${c.src}" alt=""><span class="cat-bubble mono">${c.bubble}</span>`;
    el.style.animationDuration = c.ms + "ms";
    catLayer.appendChild(el);
    setTimeout(() => el.remove(), c.ms);
  }
  $("#catBtn").addEventListener("click", releaseCat);
  let typed = "";
  addEventListener("keydown", (e) => {
    if (e.key.length !== 1) return;
    typed = (typed + e.key.toLowerCase()).slice(-4);
    if (typed.endsWith("cat") || typed === "meow") releaseCat();
  });

  // tap to flip the credential card on touch screens
  // internship photo albums in the timeline
  $$(".polaroids").forEach((album) => {
    const figs = $$("figure", album);
    const srcs = figs.map((f) => $("img", f).getAttribute("src"));
    figs.forEach((f, i) => f.addEventListener("click", () => openLB(srcs, i)));
  });

  // conference photos + poster on a talk
  $$(".talk-gallery").forEach((g) => {
    const items = $$(".tg-item", g);
    const list = items.map((b) => (b.dataset.dl ? { src: b.dataset.src, dl: b.dataset.dl } : b.dataset.src));
    items.forEach((b, i) => b.addEventListener("click", () => openLB(list, i)));
  });

  // ACSM-EP certificate: open in the lightbox with a PDF download
  const openCert = () => openLB([{ src: "img/acsm-ep-certificate.jpg", dl: "files/acsm-ep-certificate.pdf" }], 0);
  [$("#certCard"), ...$$("[data-open-cert]")].forEach((el) => el.addEventListener("click", openCert));

  $("#yr").textContent = new Date().getFullYear();
  console.log("%c🐈 meow — type “cat” anywhere on the page.", "color:#e3b84b;font:14px monospace");
})();
