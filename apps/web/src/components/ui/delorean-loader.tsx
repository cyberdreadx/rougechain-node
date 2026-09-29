import { useEffect, useRef } from "react";

interface DeloreanLoaderProps {
  text?: string;
}

const PIXEL = 3;
const CAR_COLOR = "#c0c0c8";
const CAR_DARK = "#8888a0";
const CAR_DARKER = "#606078";
const WINDOW_COLOR = "#3399ff";
const WHEEL_COLOR = "#222233";
const TIRE_COLOR = "#111118";
const TAILLIGHT = "#ff3333";
const HEADLIGHT = "#ffee88";
const FLUX_BLUE = "#44ccff";

// prettier-ignore
const DELOREAN_PIXELS: [number, number, string][] = [
  // roof
  [10,0,CAR_DARK],[11,0,CAR_DARK],[12,0,CAR_DARK],[13,0,CAR_DARK],[14,0,CAR_DARK],
  // windshield + roof line
  [8,1,CAR_DARK],[9,1,WINDOW_COLOR],[10,1,WINDOW_COLOR],[11,1,CAR_COLOR],[12,1,CAR_COLOR],[13,1,CAR_COLOR],[14,1,CAR_COLOR],[15,1,WINDOW_COLOR],[16,1,CAR_DARK],
  // upper body
  [6,2,CAR_DARK],[7,2,CAR_COLOR],[8,2,WINDOW_COLOR],[9,2,WINDOW_COLOR],[10,2,CAR_COLOR],[11,2,CAR_COLOR],[12,2,CAR_COLOR],[13,2,CAR_COLOR],[14,2,WINDOW_COLOR],[15,2,WINDOW_COLOR],[16,2,CAR_COLOR],[17,2,CAR_DARK],
  // main body top
  [4,3,CAR_DARKER],[5,3,CAR_DARK],[6,3,CAR_COLOR],[7,3,CAR_COLOR],[8,3,CAR_COLOR],[9,3,CAR_COLOR],[10,3,CAR_COLOR],[11,3,CAR_COLOR],[12,3,CAR_COLOR],[13,3,CAR_COLOR],[14,3,CAR_COLOR],[15,3,CAR_COLOR],[16,3,CAR_COLOR],[17,3,CAR_COLOR],[18,3,CAR_DARK],[19,3,CAR_DARKER],
  // main body with details
  [3,4,TAILLIGHT],[4,4,CAR_DARK],[5,4,CAR_COLOR],[6,4,CAR_COLOR],[7,4,CAR_COLOR],[8,4,FLUX_BLUE],[9,4,CAR_COLOR],[10,4,CAR_COLOR],[11,4,CAR_COLOR],[12,4,CAR_COLOR],[13,4,CAR_COLOR],[14,4,FLUX_BLUE],[15,4,CAR_COLOR],[16,4,CAR_COLOR],[17,4,CAR_COLOR],[18,4,CAR_COLOR],[19,4,CAR_DARK],[20,4,HEADLIGHT],
  // lower body
  [3,5,TAILLIGHT],[4,5,CAR_DARKER],[5,5,CAR_DARK],[6,5,CAR_DARK],[7,5,CAR_DARK],[8,5,CAR_DARK],[9,5,CAR_DARK],[10,5,CAR_DARK],[11,5,CAR_DARK],[12,5,CAR_DARK],[13,5,CAR_DARK],[14,5,CAR_DARK],[15,5,CAR_DARK],[16,5,CAR_DARK],[17,5,CAR_DARK],[18,5,CAR_DARK],[19,5,CAR_DARKER],[20,5,HEADLIGHT],
  // undercarriage
  [5,6,CAR_DARKER],[6,6,CAR_DARKER],[7,6,WHEEL_COLOR],[8,6,WHEEL_COLOR],[9,6,CAR_DARKER],[10,6,CAR_DARKER],[11,6,CAR_DARKER],[12,6,CAR_DARKER],[13,6,CAR_DARKER],[14,6,CAR_DARKER],[15,6,WHEEL_COLOR],[16,6,WHEEL_COLOR],[17,6,CAR_DARKER],[18,6,CAR_DARKER],
  // wheels
  [6,7,TIRE_COLOR],[7,7,WHEEL_COLOR],[8,7,WHEEL_COLOR],[9,7,TIRE_COLOR],
  [14,7,TIRE_COLOR],[15,7,WHEEL_COLOR],[16,7,WHEEL_COLOR],[17,7,TIRE_COLOR],
];

interface Spark {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  color: string;
  size: number;
}

const SPARK_COLORS = ["#44ccff", "#88eeff", "#ffffff", "#ffee44", "#ff8844", "#44ccff"];

export const DeloreanLoader = ({ text }: DeloreanLoaderProps) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animRef = useRef<number>(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d")!;
    const W = canvas.width;
    const H = canvas.height;

    const sparks: Spark[] = [];
    let carX = 0;
    let frame = 0;

    const spawnSpark = (originX: number, originY: number, burst: boolean) => {
      const color = SPARK_COLORS[Math.floor(Math.random() * SPARK_COLORS.length)];
      sparks.push({
        x: originX + (Math.random() - 0.5) * 8,
        y: originY + (Math.random() - 0.5) * 20,
        vx: burst ? -(3 + Math.random() * 6) : -(1 + Math.random() * 3),
        vy: (Math.random() - 0.5) * 3,
        life: 0,
        maxLife: 15 + Math.random() * 25,
        color,
        size: burst ? 2 + Math.random() * 3 : 1 + Math.random() * 2,
      });
    };

    const spawnTrail = (originX: number, originY: number) => {
      sparks.push({
        x: originX,
        y: originY,
        vx: -(2 + Math.random() * 4),
        vy: (Math.random() - 0.5) * 0.5,
        life: 0,
        maxLife: 10 + Math.random() * 15,
        color: frame % 6 < 3 ? "#44ccff" : "#88eeff",
        size: 2 + Math.random() * 2,
      });
    };

    const draw = () => {
      frame++;
      ctx.clearRect(0, 0, W, H);

      const bob = Math.sin(frame * 0.08) * 2;
      const carCenterX = W / 2 - (24 * PIXEL) / 2;
      const carCenterY = H / 2 - (8 * PIXEL) / 2 + bob;

      // Fire trails from back of car
      if (frame % 2 === 0) {
        spawnTrail(carCenterX + 3 * PIXEL, carCenterY + 4 * PIXEL);
        spawnTrail(carCenterX + 3 * PIXEL, carCenterY + 5 * PIXEL);
      }

      // Sparks from wheels and around car
      if (frame % 3 === 0) {
        spawnSpark(carCenterX + 7 * PIXEL, carCenterY + 7 * PIXEL, false);
        spawnSpark(carCenterX + 15 * PIXEL, carCenterY + 7 * PIXEL, false);
      }

      // Periodic burst
      if (frame % 40 < 3) {
        for (let i = 0; i < 6; i++) {
          spawnSpark(carCenterX + 10 * PIXEL, carCenterY + 4 * PIXEL, true);
        }
      }

      // Speed lines
      ctx.globalAlpha = 0.15;
      ctx.strokeStyle = "#44ccff";
      ctx.lineWidth = 1;
      for (let i = 0; i < 4; i++) {
        const ly = 10 + ((frame * 2 + i * 37) % (H - 20));
        const lx = (frame * 3 + i * 60) % W;
        ctx.beginPath();
        ctx.moveTo(lx, ly);
        ctx.lineTo(lx - 30 - Math.random() * 40, ly);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;

      // Draw sparks
      for (let i = sparks.length - 1; i >= 0; i--) {
        const s = sparks[i];
        s.x += s.vx;
        s.y += s.vy;
        s.vy += 0.05;
        s.life++;
        if (s.life >= s.maxLife) {
          sparks.splice(i, 1);
          continue;
        }
        const alpha = 1 - s.life / s.maxLife;
        ctx.globalAlpha = alpha;
        ctx.fillStyle = s.color;
        ctx.shadowColor = s.color;
        ctx.shadowBlur = s.size * 3;
        ctx.fillRect(
          Math.round(s.x),
          Math.round(s.y),
          Math.ceil(s.size),
          Math.ceil(s.size)
        );
      }
      ctx.shadowBlur = 0;
      ctx.globalAlpha = 1;

      // Glow behind car
      const glow = ctx.createRadialGradient(
        carCenterX + 10 * PIXEL, carCenterY + 4 * PIXEL, 2,
        carCenterX + 10 * PIXEL, carCenterY + 4 * PIXEL, 50
      );
      glow.addColorStop(0, "rgba(68, 204, 255, 0.25)");
      glow.addColorStop(1, "rgba(68, 204, 255, 0)");
      ctx.fillStyle = glow;
      ctx.fillRect(0, 0, W, H);

      // Draw the DeLorean pixel art
      ctx.imageSmoothingEnabled = false;
      for (const [px, py, color] of DELOREAN_PIXELS) {
        ctx.fillStyle = color;
        ctx.fillRect(
          Math.round(carCenterX + px * PIXEL),
          Math.round(carCenterY + py * PIXEL),
          PIXEL,
          PIXEL
        );
      }

      // Flux capacitor pulse
      if (frame % 20 < 10) {
        ctx.globalAlpha = 0.6 + Math.sin(frame * 0.3) * 0.4;
        ctx.fillStyle = FLUX_BLUE;
        ctx.shadowColor = FLUX_BLUE;
        ctx.shadowBlur = 8;
        ctx.fillRect(carCenterX + 8 * PIXEL, carCenterY + 4 * PIXEL, PIXEL, PIXEL);
        ctx.fillRect(carCenterX + 14 * PIXEL, carCenterY + 4 * PIXEL, PIXEL, PIXEL);
        ctx.shadowBlur = 0;
        ctx.globalAlpha = 1;
      }

      animRef.current = requestAnimationFrame(draw);
    };

    animRef.current = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(animRef.current);
  }, []);

  return (
    <div className="flex flex-col items-center gap-3">
      <canvas
        ref={canvasRef}
        width={240}
        height={100}
        className="rounded-lg"
        style={{ imageRendering: "pixelated" }}
      />
      {text && (
        <p className="text-sm text-muted-foreground animate-pulse font-mono">
          {text}
        </p>
      )}
    </div>
  );
};

export default DeloreanLoader;
