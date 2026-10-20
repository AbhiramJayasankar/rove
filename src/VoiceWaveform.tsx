import { useEffect, useRef } from "react";
import { useT } from "./i18n";

const BAR = 2.5;
const GAP = 2;
const SAMPLE_MS = 70;

/** Loudness over time: a new bar enters on the right every moment and the history scrolls left. */
export default function VoiceWaveform({ stream }: { stream: MediaStream | null }) {
  const t = useT();
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (!stream || !canvas.current) return;
    const element = canvas.current;
    const audio = new AudioContext();
    const source = audio.createMediaStreamSource(stream);
    const analyser = audio.createAnalyser();
    analyser.fftSize = 512;
    source.connect(analyser);
    const samples = new Uint8Array(analyser.fftSize);
    const levels: number[] = [];
    let frame = 0;
    let last = performance.now();
    void audio.resume().catch(() => {});
    function level() {
      analyser.getByteTimeDomainData(samples);
      let sum = 0;
      for (const sample of samples) sum += ((sample - 128) / 128) ** 2;
      // Speech sits low in the signal, so lift it; keep a faint bar for silence.
      return Math.min(1, Math.sqrt(sum / samples.length) * 4.5);
    }
    function draw(now: number) {
      const width = element.clientWidth, height = element.clientHeight, scale = devicePixelRatio || 1;
      if (element.width !== width * scale || element.height !== height * scale) {
        element.width = width * scale;
        element.height = height * scale;
      }
      const step = BAR + GAP;
      const capacity = Math.ceil(width / step) + 1;
      while (now - last >= SAMPLE_MS) {
        levels.push(level());
        if (levels.length > capacity) levels.shift();
        last += SAMPLE_MS;
      }
      // Slide between samples so the motion is continuous rather than stepping.
      const shift = ((now - last) / SAMPLE_MS) * step;
      const context = element.getContext("2d");
      if (context) {
        context.setTransform(scale, 0, 0, scale, 0, 0);
        context.clearRect(0, 0, width, height);
        context.fillStyle = getComputedStyle(element).color;
        const mid = height / 2;
        for (let index = 0; index < levels.length; index++) {
          const x = width - (levels.length - index) * step - shift + step;
          if (x < -BAR) continue;
          const barHeight = Math.max(2.5, levels[index] * (height - 4));
          context.globalAlpha = 0.35 + 0.65 * Math.max(0, Math.min(1, x / width));
          context.beginPath();
          context.roundRect(x, mid - barHeight / 2, BAR, barHeight, BAR / 2);
          context.fill();
        }
        context.globalAlpha = 1;
      }
      frame = requestAnimationFrame(draw);
    }
    frame = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(frame);
      source.disconnect();
      analyser.disconnect();
      void audio.close();
    };
  }, [stream]);
  return <canvas ref={canvas} className="voice-waveform" role="img" aria-label={t("Live microphone waveform")} />;
}
