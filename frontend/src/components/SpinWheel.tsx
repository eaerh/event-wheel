import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { Event } from '../api';

const COLORS: [string, string][] = [
  ['#818cf8', '#4338ca'], ['#34d399', '#047857'], ['#fbbf24', '#b45309'],
  ['#f87171', '#b91c1c'], ['#a78bfa', '#6d28d9'], ['#38bdf8', '#0369a1'],
  ['#fb923c', '#c2410c'], ['#4ade80', '#15803d'], ['#f472b6', '#be185d'],
  ['#22d3ee', '#0e7490'], ['#c084fc', '#7e22ce'], ['#facc15', '#a16207'],
  ['#2dd4bf', '#0f766e'], ['#fb7185', '#be123c'], ['#60a5fa', '#1d4ed8'],
];

const LED_COUNT = 48;

export interface WeightedEvent extends Event {
  weight: number;
}

interface SpinWheelProps {
  events: WeightedEvent[];
  onResult: (event: WeightedEvent) => void;
}

// Firework particle
interface Particle {
  x: number; y: number;
  vx: number; vy: number;
  life: number; maxLife: number;
  color: string; size: number;
}

function getCanvasSize(n: number): number {
  if (n <= 10) return 520;
  if (n <= 20) return 600;
  if (n <= 40) return 700;
  return 800;
}

export function SpinWheel({ events, onResult }: SpinWheelProps) {
  const [spinning, setSpinning] = useState(false);
  const [celebrating, setCelebrating] = useState(false);
  const rotationRef = useRef(0);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animRef = useRef<number>(0);
  const renderRef = useRef<number>(0);
  const particlesRef = useRef<Particle[]>([]);
  const flashRef = useRef(0);
  const strobeRef = useRef(false);
  const canvasSizeRef = useRef<{ size: number; dpr: number } | null>(null);

  const wheelEvents = useMemo(() => events, [
    // eslint-disable-next-line react-hooks/exhaustive-deps
    events.map(e => `${e.id}:${e.weight}`).join(',')
  ]);

  const sliceData = useMemo(() => {
    const total = wheelEvents.reduce((s, e) => s + e.weight, 0);
    const angles = wheelEvents.map(e => (e.weight / total) * 2 * Math.PI);
    const starts: number[] = [];
    let cum = 0;
    for (const a of angles) { starts.push(cum); cum += a; }
    return { angles, starts, total };
  }, [wheelEvents]);

  const getSliceAtPointer = useCallback((rotDeg: number): number => {
    const rotRad = (rotDeg % 360) * Math.PI / 180;
    const pointerAngle = ((3 * Math.PI / 2) - rotRad + 4 * Math.PI) % (2 * Math.PI);
    let cumAngle = 0;
    for (let i = 0; i < sliceData.angles.length; i++) {
      cumAngle += sliceData.angles[i];
      if (pointerAngle < cumAngle) return i;
    }
    return sliceData.angles.length - 1;
  }, [sliceData]);

  // Spawn fireworks
  const spawnFirework = useCallback((cx: number, cy: number, size: number) => {
    const colors = ['#ff6b6b', '#ffd93d', '#6bcb77', '#4d96ff', '#ff6fff', '#fff'];
    const count = 40 + Math.floor(Math.random() * 20);
    for (let i = 0; i < count; i++) {
      const angle = (Math.random() * Math.PI * 2);
      const speed = 1 + Math.random() * 4;
      particlesRef.current.push({
        x: cx + (Math.random() - 0.5) * size * 0.3,
        y: cy + (Math.random() - 0.5) * size * 0.3,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        life: 1, maxLife: 60 + Math.random() * 40,
        color: colors[Math.floor(Math.random() * colors.length)],
        size: 2 + Math.random() * 3,
      });
    }
  }, []);

  const drawWheel = useCallback((rotation: number, time: number) => {
    const canvas = canvasRef.current;
    if (!canvas || wheelEvents.length === 0) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const size = getCanvasSize(wheelEvents.length);

    // Only resize when dimensions actually change — setting canvas.width/height
    // clears the canvas and resets the context transform, which is expensive at 60fps.
    const prev = canvasSizeRef.current;
    if (!prev || prev.size !== size || prev.dpr !== dpr) {
      canvas.width = size * dpr;
      canvas.height = size * dpr;
      canvas.style.width = `${size}px`;
      canvas.style.height = `${size}px`;
      ctx.scale(dpr, dpr);
      canvasSizeRef.current = { size, dpr };
    }

    const cx = size / 2;
    const cy = size / 2;
    const r = cx - 30;
    const rot = (rotation * Math.PI) / 180;
    const n = wheelEvents.length;

    ctx.clearRect(0, 0, size, size);

    // ── Screen flash ──
    if (flashRef.current > 0) {
      ctx.fillStyle = `rgba(255,255,255,${flashRef.current})`;
      ctx.fillRect(0, 0, size, size);
      flashRef.current = Math.max(0, flashRef.current - 0.03);
    }

    // ── LED dots ──
    const isStrobe = strobeRef.current;
    const pulse = isStrobe
      ? (Math.sin(time * 0.02) > 0 ? 1 : 0)
      : 0.6 + 0.4 * Math.sin(time * 0.003);
    const ledR = r + 18;
    for (let i = 0; i < LED_COUNT; i++) {
      const angle = (i / LED_COUNT) * 2 * Math.PI;
      const lx = cx + Math.cos(angle) * ledR;
      const ly = cy + Math.sin(angle) * ledR;
      const brightness = isStrobe
        ? ((i + Math.floor(time * 0.02)) % 3 === 0 ? 1 : 0.1)
        : ((i % 2 === 0) ? pulse : (1 - pulse));
      const colorIdx = isStrobe
        ? (i + Math.floor(time * 0.01)) % COLORS.length
        : i % COLORS.length;
      const ledColor = COLORS[colorIdx][0];

      ctx.save();
      ctx.beginPath();
      ctx.arc(lx, ly, 6, 0, Math.PI * 2);
      ctx.shadowColor = ledColor;
      ctx.shadowBlur = 12 * brightness;
      ctx.fillStyle = 'transparent';
      ctx.fill();
      ctx.restore();

      ctx.beginPath();
      ctx.arc(lx, ly, 3.5, 0, Math.PI * 2);
      ctx.fillStyle = ledColor;
      ctx.globalAlpha = 0.3 + 0.7 * brightness;
      ctx.fill();
      ctx.globalAlpha = 1;
    }

    // ── Outer glow ──
    const glowPulse = isStrobe ? 1 : 0.5 + 0.5 * Math.sin(time * 0.002);
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, r + 8, 0, Math.PI * 2);
    ctx.shadowColor = `rgba(99,102,241,${0.6 * glowPulse})`;
    ctx.shadowBlur = 25;
    ctx.strokeStyle = `rgba(129,140,248,${0.5 + 0.3 * glowPulse})`;
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.restore();

    // ── Metallic ring ──
    const ringGrad = ctx.createLinearGradient(0, 0, size, size);
    ringGrad.addColorStop(0, '#818cf8');
    ringGrad.addColorStop(0.25, '#e0e7ff');
    ringGrad.addColorStop(0.5, '#a5b4fc');
    ringGrad.addColorStop(0.75, '#e0e7ff');
    ringGrad.addColorStop(1, '#818cf8');
    ctx.beginPath();
    ctx.arc(cx, cy, r + 4, 0, Math.PI * 2);
    ctx.strokeStyle = ringGrad;
    ctx.lineWidth = 6;
    ctx.stroke();

    // ── Slice notches ──
    for (let i = 0; i < n; i++) {
      const angle = rot + sliceData.starts[i];
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(angle) * r, cy + Math.sin(angle) * r);
      ctx.lineTo(cx + Math.cos(angle) * (r + 8), cy + Math.sin(angle) * (r + 8));
      ctx.strokeStyle = '#4f46e5';
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    // ── Slices ──
    for (let i = 0; i < n; i++) {
      const sliceAngle = sliceData.angles[i];
      const startAngle = rot + sliceData.starts[i];
      const endAngle = startAngle + sliceAngle;
      const midAngle = startAngle + sliceAngle / 2;

      const [c1, c2] = COLORS[i % COLORS.length];
      const grad = ctx.createRadialGradient(cx, cy, r * 0.08, cx, cy, r);
      grad.addColorStop(0, c1);
      grad.addColorStop(0.6, c1);
      grad.addColorStop(1, c2);

      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, r, startAngle, endAngle);
      ctx.closePath();
      ctx.fillStyle = grad;
      ctx.fill();

      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + Math.cos(startAngle) * r, cy + Math.sin(startAngle) * r);
      ctx.strokeStyle = 'rgba(255,255,255,0.7)';
      ctx.lineWidth = 1.5;
      ctx.stroke();

      // Label
      if (sliceAngle > 0.03) {
        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate(midAngle);
        ctx.textAlign = 'right';
        ctx.fillStyle = '#fff';
        const fs = n <= 6 ? 14 : n <= 12 ? 12 : n <= 20 ? 10 : n <= 30 ? 8 : 7;
        ctx.font = `700 ${fs}px "Inter", system-ui, sans-serif`;
        ctx.shadowColor = 'rgba(0,0,0,0.6)';
        ctx.shadowBlur = 3;
        const maxL = n <= 6 ? 24 : n <= 12 ? 20 : n <= 20 ? 16 : n <= 30 ? 12 : 8;
        const t = wheelEvents[i].title.length > maxL
          ? wheelEvents[i].title.slice(0, maxL - 1) + '…'
          : wheelEvents[i].title;
        ctx.fillText(t, r - 14, fs / 3);
        ctx.restore();
      }
    }

    // ── Center hub ──
    const hubR = n <= 20 ? 28 : 22;
    const hubGrad = ctx.createRadialGradient(cx - 4, cy - 4, 2, cx, cy, hubR);
    hubGrad.addColorStop(0, '#ffffff');
    hubGrad.addColorStop(0.4, '#f1f5f9');
    hubGrad.addColorStop(1, '#a5b4fc');
    ctx.beginPath();
    ctx.arc(cx, cy, hubR, 0, Math.PI * 2);
    ctx.fillStyle = hubGrad;
    ctx.fill();
    ctx.strokeStyle = '#6366f1';
    ctx.lineWidth = 3;
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(cx, cy, 8, 0, Math.PI * 2);
    const gemGrad = ctx.createRadialGradient(cx - 2, cy - 2, 1, cx, cy, 8);
    gemGrad.addColorStop(0, '#c7d2fe');
    gemGrad.addColorStop(1, '#4f46e5');
    ctx.fillStyle = gemGrad;
    ctx.fill();

    // ── Firework particles ──
    const alive: Particle[] = [];
    for (const p of particlesRef.current) {
      p.x += p.vx;
      p.y += p.vy;
      p.vy += 0.05; // gravity
      p.life++;
      const alpha = Math.max(0, 1 - p.life / p.maxLife);
      if (alpha <= 0) continue;
      alive.push(p);

      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size * alpha, 0, Math.PI * 2);
      ctx.fillStyle = p.color;
      ctx.globalAlpha = alpha;
      ctx.fill();
      ctx.globalAlpha = 1;
    }
    particlesRef.current = alive;
  }, [wheelEvents, sliceData]);

  // Render loop
  useEffect(() => {
    const render = (time: number) => {
      drawWheel(rotationRef.current, time);
      renderRef.current = requestAnimationFrame(render);
    };
    renderRef.current = requestAnimationFrame(render);
    return () => cancelAnimationFrame(renderRef.current);
  }, [drawWheel]);

  const spin = () => {
    if (spinning || celebrating || wheelEvents.length === 0) return;
    setSpinning(true);
    strobeRef.current = false;

    const spins = 5 + Math.random() * 5;
    const extra = Math.random() * 360;
    const totalDelta = spins * 360 + extra;
    const duration = 6000;
    const startTime = performance.now();
    const startRot = rotationRef.current;

    const animate = (now: number) => {
      const p = Math.min((now - startTime) / duration, 1);
      const eased = 1 - Math.pow(1 - p, 3.5);
      rotationRef.current = startRot + totalDelta * eased;

      if (p < 1) {
        animRef.current = requestAnimationFrame(animate);
      } else {
        setSpinning(false);
        setCelebrating(true);

        // Trigger celebration effects
        const size = getCanvasSize(wheelEvents.length);
        const cx = size / 2;
        flashRef.current = 0.8;
        strobeRef.current = true;

        // Multiple firework bursts
        setTimeout(() => spawnFirework(cx * 0.5, cx * 0.4, size), 100);
        setTimeout(() => spawnFirework(cx * 1.5, cx * 0.3, size), 400);
        setTimeout(() => spawnFirework(cx * 0.3, cx * 0.6, size), 700);
        setTimeout(() => spawnFirework(cx * 1.6, cx * 0.5, size), 1000);
        setTimeout(() => spawnFirework(cx, cx * 0.2, size), 600);

        // Read winner after effects start
        setTimeout(() => {
          strobeRef.current = false;
          setCelebrating(false);
          const winnerIdx = getSliceAtPointer(rotationRef.current);
          onResult(wheelEvents[winnerIdx]);
        }, 2000);
      }
    };

    animRef.current = requestAnimationFrame(animate);
  };

  useEffect(() => () => cancelAnimationFrame(animRef.current), []);

  if (events.length === 0) return null;

  return (
    <div className="wheel-container">
      <div className="wheel-wrapper">
        <div className={`wheel-pointer ${spinning ? 'wobble' : ''} ${celebrating ? 'bounce' : ''}`} />
        <canvas ref={canvasRef} />
      </div>
      <button
        className={`spin-btn ${spinning || celebrating ? '' : 'pulse'}`}
        onClick={spin}
        disabled={spinning || celebrating}
      >
        {spinning ? 'Spinning…' : celebrating ? '🎆 !' : '🎯 SPIN'}
      </button>
      <div className="wheel-hint">
        {events.length} events — larger slices = higher interest
      </div>
    </div>
  );
}
