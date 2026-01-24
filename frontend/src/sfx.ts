export class Sfx {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private lastRotateAt = 0;

  private getContext(): AudioContext {
    if (this.ctx) return this.ctx;
    const Ctx = (window.AudioContext || (window as any).webkitAudioContext) as typeof AudioContext | undefined;
    if (!Ctx) throw new Error("WebAudio not supported");
    this.ctx = new Ctx();
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.22;
    this.master.connect(this.ctx.destination);
    return this.ctx;
  }

  async resume() {
    try {
      const ctx = this.getContext();
      if (ctx.state !== "running") await ctx.resume();
    } catch {
      // ignore
    }
  }

  setVolume(v: number) {
    try {
      const ctx = this.getContext();
      const g = this.master!;
      const t = ctx.currentTime;
      g.gain.setTargetAtTime(Math.max(0, Math.min(1, v)), t, 0.03);
    } catch {
      // ignore
    }
  }

  playEat(count = 1) {
    try {
      const ctx = this.getContext();
      if (ctx.state !== "running") return;
      const g = this.master!;
      const t0 = ctx.currentTime;

      const n = Math.max(1, Math.min(4, count | 0));
      for (let i = 0; i < n; i++) {
        const t = t0 + i * 0.045;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        const filt = ctx.createBiquadFilter();
        filt.type = "lowpass";
        filt.frequency.setValueAtTime(1500, t);
        filt.frequency.exponentialRampToValueAtTime(3500, t + 0.06);

        osc.type = "triangle";
        osc.frequency.setValueAtTime(420 + i * 30, t);
        osc.frequency.exponentialRampToValueAtTime(980 + i * 60, t + 0.09);

        gain.gain.setValueAtTime(0.0001, t);
        gain.gain.exponentialRampToValueAtTime(0.55, t + 0.012);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.13);

        osc.connect(filt);
        filt.connect(gain);
        gain.connect(g);

        osc.start(t);
        osc.stop(t + 0.16);
      }
    } catch {
      // ignore
    }
  }

  playRotate() {
    try {
      const ctx = this.getContext();
      if (ctx.state !== "running") return;
      const nowMs = performance.now();
      if (nowMs - this.lastRotateAt < 140) return; // de-spam
      this.lastRotateAt = nowMs;

      const g = this.master!;
      const t0 = ctx.currentTime;

      // Simple "whoosh": filtered noise burst + a soft low tone.
      const noiseBuf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 0.12), ctx.sampleRate);
      {
        const data = noiseBuf.getChannelData(0);
        for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / data.length);
      }
      const noise = ctx.createBufferSource();
      noise.buffer = noiseBuf;

      const bp = ctx.createBiquadFilter();
      bp.type = "bandpass";
      bp.frequency.setValueAtTime(650, t0);
      bp.Q.setValueAtTime(0.9, t0);

      const ng = ctx.createGain();
      ng.gain.setValueAtTime(0.0001, t0);
      ng.gain.exponentialRampToValueAtTime(0.22, t0 + 0.02);
      ng.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.14);

      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.setValueAtTime(150, t0);
      osc.frequency.exponentialRampToValueAtTime(120, t0 + 0.12);
      const og = ctx.createGain();
      og.gain.setValueAtTime(0.0001, t0);
      og.gain.exponentialRampToValueAtTime(0.10, t0 + 0.02);
      og.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.13);

      noise.connect(bp);
      bp.connect(ng);
      ng.connect(g);

      osc.connect(og);
      og.connect(g);

      noise.start(t0);
      noise.stop(t0 + 0.16);
      osc.start(t0);
      osc.stop(t0 + 0.16);
    } catch {
      // ignore
    }
  }

  playHurt(intensity = 1, level = 1) {
    try {
      const ctx = this.getContext();
      if (ctx.state !== "running") return;
      const g = this.master!;
      const t0 = ctx.currentTime;
      const k = Math.max(0.2, Math.min(2.5, intensity));
      const vol = Math.max(0, Math.min(1, level));

      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.exponentialRampToValueAtTime(0.20 * vol, t0 + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.30);

      // "Voice" tone with jitter and formant-ish bandpasses.
      const src = ctx.createOscillator();
      src.type = "sawtooth";
      src.frequency.setValueAtTime(360 + 40 * k, t0);
      src.frequency.exponentialRampToValueAtTime(720 + 60 * k, t0 + 0.11);
      src.frequency.exponentialRampToValueAtTime(420, t0 + 0.30);

      const vib = ctx.createOscillator();
      vib.type = "sine";
      vib.frequency.setValueAtTime(10 + 2 * k, t0);
      const vibGain = ctx.createGain();
      vibGain.gain.setValueAtTime(18 + 6 * k, t0);
      vib.connect(vibGain);
      vibGain.connect(src.frequency);

      const bp1 = ctx.createBiquadFilter();
      bp1.type = "bandpass";
      bp1.frequency.setValueAtTime(980, t0);
      bp1.Q.setValueAtTime(7, t0);

      const bp2 = ctx.createBiquadFilter();
      bp2.type = "bandpass";
      bp2.frequency.setValueAtTime(1550, t0);
      bp2.Q.setValueAtTime(9, t0);

      const mix = ctx.createGain();
      mix.gain.setValueAtTime(0.75, t0);

      src.connect(bp1);
      src.connect(bp2);
      bp1.connect(mix);
      bp2.connect(mix);
      mix.connect(gain);
      gain.connect(g);

      vib.start(t0);
      vib.stop(t0 + 0.32);
      src.start(t0);
      src.stop(t0 + 0.32);
    } catch {
      // ignore
    }
  }

  playDie(level = 1) {
    try {
      const ctx = this.getContext();
      if (ctx.state !== "running") return;
      const g = this.master!;
      const t0 = ctx.currentTime;
      const vol = Math.max(0, Math.min(1, level));

      const out = ctx.createGain();
      out.gain.setValueAtTime(0.0001, t0);
      out.gain.exponentialRampToValueAtTime(0.26 * vol, t0 + 0.02);
      out.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.48);
      out.connect(g);

      // Descending "oomph" tone.
      const osc = ctx.createOscillator();
      osc.type = "triangle";
      osc.frequency.setValueAtTime(220, t0);
      osc.frequency.exponentialRampToValueAtTime(70, t0 + 0.42);
      osc.connect(out);

      // Short noisy thud.
      const noiseBuf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 0.22), ctx.sampleRate);
      {
        const data = noiseBuf.getChannelData(0);
        for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / data.length, 2);
      }
      const noise = ctx.createBufferSource();
      noise.buffer = noiseBuf;
      const lp = ctx.createBiquadFilter();
      lp.type = "lowpass";
      lp.frequency.setValueAtTime(520, t0);
      const ng = ctx.createGain();
      ng.gain.setValueAtTime(0.0001, t0);
      ng.gain.exponentialRampToValueAtTime(0.20 * vol, t0 + 0.015);
      ng.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.22);
      noise.connect(lp);
      lp.connect(ng);
      ng.connect(out);

      osc.start(t0);
      osc.stop(t0 + 0.50);
      noise.start(t0);
      noise.stop(t0 + 0.26);
    } catch {
      // ignore
    }
  }
}
