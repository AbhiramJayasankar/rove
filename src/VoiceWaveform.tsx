import { useEffect, useRef } from "react";

export default function VoiceWaveform({ stream }: { stream: MediaStream | null }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (!stream || !canvas.current) return;
    const element = canvas.current;
    const audio = new AudioContext();
    const source = audio.createMediaStreamSource(stream);
    const analyser = audio.createAnalyser();
    analyser.fftSize = 256; source.connect(analyser);
    const samples = new Uint8Array(analyser.fftSize);
    let frame = 0;
    void audio.resume().catch(() => {});
    function draw() {
      const width = element.clientWidth, height = element.clientHeight, scale = devicePixelRatio || 1;
      if (element.width !== width * scale || element.height !== height * scale) { element.width = width * scale; element.height = height * scale; }
      const context = element.getContext("2d");
      if (context) {
        context.setTransform(scale, 0, 0, scale, 0, 0); context.clearRect(0, 0, width, height);
        analyser.getByteTimeDomainData(samples);
        context.strokeStyle = getComputedStyle(element).color; context.lineWidth = 1.5; context.beginPath();
        samples.forEach((sample, index) => {
          const x = index / (samples.length - 1) * width, y = height / 2 + (sample - 128) / 128 * height * .46;
          if (!index) context.moveTo(x, y); else context.lineTo(x, y);
        });
        context.stroke();
      }
      frame = requestAnimationFrame(draw);
    }
    draw();
    return () => { cancelAnimationFrame(frame); source.disconnect(); analyser.disconnect(); void audio.close(); };
  }, [stream]);
  return <canvas ref={canvas} className="voice-waveform" role="img" aria-label="Live microphone waveform" />;
}
