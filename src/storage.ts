// 调音记录的本机存储：数据只存浏览器 localStorage，不上传任何服务。
import type { Pipe } from "./acclimatization";
import { createId } from "./acclimatization";

const STORAGE_KEY = "organ-pipe-acclimatization.v1";

function isNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function isValidPipe(value: unknown): value is Pipe {
  if (typeof value !== "object" || value === null) return false;
  const p = value as Record<string, unknown>;
  if (typeof p.id !== "string" || typeof p.pipeNo !== "string") return false;
  if (typeof p.inPosition !== "boolean" || !isNumber(p.installedAt)) return false;
  if (!Array.isArray(p.readings) || !Array.isArray(p.resets)) return false;
  return p.readings.every(
    (r) =>
      typeof r === "object" &&
      r !== null &&
      typeof (r as { id: unknown }).id === "string" &&
      isNumber((r as { time: unknown }).time) &&
      isNumber((r as { temp: unknown }).temp) &&
      isNumber((r as { humidity: unknown }).humidity),
  );
}

export function loadPipes(): Pipe[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      const seeded = seedPipes();
      savePipes(seeded);
      return seeded;
    }
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isValidPipe);
  } catch {
    return [];
  }
}

export function savePipes(pipes: Pipe[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(pipes));
  } catch {
    // 隐私模式 / 存储被禁用时静默失败，工作台仍可在内存中使用
  }
}

export function clearPipes(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}

/** 首次进入时的示例：分别处于适应中、可调音、已调音三种状态 */
function seedPipes(): Pipe[] {
  const now = Date.now();
  const hour = 60 * 60 * 1000;
  const min = 60 * 1000;

  const adapting: Pipe = {
    id: createId(),
    venue: "St. Mary 教堂",
    stop: "Trumpet 8'",
    pipeNo: "C#4",
    reedState: "簧片新换，待稳定",
    inPosition: true,
    installedAt: now - 40 * min,
    readings: [
      { id: createId(), time: now - 35 * min, temp: 19.2, humidity: 55 },
      { id: createId(), time: now - 12 * min, temp: 21.4, humidity: 52 },
    ],
    resets: [],
    updatedAt: now,
  };

  const ready: Pipe = {
    id: createId(),
    venue: "ConcertHall A",
    stop: "Principal 4'",
    pipeNo: "G3",
    reedState: "正常",
    inPosition: true,
    installedAt: now - 3 * hour,
    readings: [
      { id: createId(), time: now - 95 * min, temp: 20.0, humidity: 48 },
      { id: createId(), time: now - 40 * min, temp: 20.6, humidity: 47 },
      { id: createId(), time: now - 5 * min, temp: 20.8, humidity: 47 },
    ],
    resets: [],
    updatedAt: now,
  };

  const tuned: Pipe = {
    id: createId(),
    venue: "Abbey Room",
    stop: "Bourdon 16'",
    pipeNo: "F2",
    reedState: "正常，建议下月复检",
    inPosition: true,
    installedAt: now - 26 * hour,
    readings: [
      { id: createId(), time: now - 25 * hour, temp: 18.4, humidity: 60 },
      { id: createId(), time: now - 24 * hour, temp: 18.9, humidity: 59 },
    ],
    resets: [],
    tuning: {
      time: now - 23 * hour,
      pitch: "F2",
      cents: -2,
      abnormal: false,
      note: "回装适应后调音，音准稳定",
    },
    updatedAt: now - 23 * hour,
  };

  return [adapting, ready, tuned];
}
