// 音管回装适应状态机：纯业务逻辑，不依赖 React 与存储。
// 规则：
// 1. 音管必须在位；
// 2. 最近一次“换位 / 读数中断”之后，至少有两次现场温湿度读数；
// 3. 两次读数相隔不少于 30 分钟，且温差不超过 1.5℃；
// 同时满足才允许调音。适应期间音管只读、不计完成。

export const MIN_READING_GAP_MS = 30 * 60 * 1000;
export const MAX_TEMP_DELTA = 1.5;

export type ResetReason = "moved" | "interrupted";

export interface Reading {
  id: string;
  /** 读数时间，epoch 毫秒 */
  time: number;
  /** 温度 ℃ */
  temp: number;
  /** 相对湿度 % */
  humidity: number;
}

export interface ResetEvent {
  id: string;
  /** 重置时间，epoch 毫秒 */
  time: number;
  /** moved=换位取出；interrupted=读数中断 */
  reason: ResetReason;
}

export interface Tuning {
  time: number;
  /** 音高，如 A4 / C#4 */
  pitch: string;
  /** 音分偏差 */
  cents: number;
  /** 异常标记 */
  abnormal: boolean;
  /** 异常 / 维修备注 */
  note: string;
}

export interface Pipe {
  id: string;
  venue: string;
  stop: string;
  pipeNo: string;
  reedState: string;
  inPosition: boolean;
  installedAt: number;
  readings: Reading[];
  resets: ResetEvent[];
  /** 提交过调音后存在；若之后换位 / 中断，则需重新适应、再次调音 */
  tuning?: Tuning;
  updatedAt: number;
}

export type PipeStatus = "adapting" | "ready" | "tuned";

export interface Eligibility {
  status: PipeStatus;
  /** 是否可以提交调音 */
  ready: boolean;
  /** 不满足条件的原因（空数组表示满足） */
  reasons: string[];
  /** 最近一次重置之后仍计入适应的读数（按时间升序） */
  active: Reading[];
  /** 与最新读数配对、间隔 ≥30 分钟的锚点读数 */
  anchor?: Reading;
  latest?: Reading;
  gapMs?: number;
  tempDelta?: number;
  /** 距首次读数满 30 分钟还差多久（用于倒计时提示） */
  remainingMs?: number;
}

export interface NewPipeInput {
  venue: string;
  stop: string;
  pipeNo: string;
  reedState: string;
}

export interface NewReadingInput {
  time: number;
  temp: number;
  humidity: number;
}

export interface NewTuningInput {
  pitch: string;
  cents: number;
  abnormal: boolean;
  note: string;
}

export function createId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `id-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

const byTimeAsc = (a: { time: number }, b: { time: number }) => a.time - b.time;

export function latestReset(pipe: Pipe): ResetEvent | undefined {
  if (pipe.resets.length === 0) return undefined;
  return [...pipe.resets].sort(byTimeAsc)[pipe.resets.length - 1];
}

/** 最近一次换位 / 中断之后的读数才计入本轮适应 */
export function activeReadings(pipe: Pipe): Reading[] {
  const reset = latestReset(pipe);
  const cutoff = reset ? reset.time : -Infinity;
  return pipe.readings.filter((r) => r.time > cutoff).sort(byTimeAsc);
}

export function isTuned(pipe: Pipe): boolean {
  if (!pipe.tuning) return false;
  const reset = latestReset(pipe);
  // 调音之后若再发生换位 / 中断，原调音结果保留但不再计完成
  return !reset || reset.time < pipe.tuning.time;
}

export function evaluate(pipe: Pipe, now: number): Eligibility {
  const active = activeReadings(pipe);

  if (isTuned(pipe) && pipe.tuning) {
    return { status: "tuned", ready: false, reasons: [], active };
  }

  const reasons: string[] = [];
  if (!pipe.inPosition) {
    reasons.push("音管换位取出中：重新装回琴室后，适应计时从头开始");
  }

  const latest = active.length > 0 ? active[active.length - 1] : undefined;
  let anchor: Reading | undefined;
  let gapMs: number | undefined;
  let tempDelta: number | undefined;
  let remainingMs: number | undefined;

  if (!latest) {
    reasons.push("尚无现场温湿度读数，无法建立适应过程");
  } else if (active.length < 2) {
    reasons.push("只有一次读数，需在 30 分钟后再读数一次");
  }

  if (latest) {
    for (let i = active.length - 2; i >= 0; i -= 1) {
      if (latest.time - active[i].time >= MIN_READING_GAP_MS) {
        anchor = active[i];
        break;
      }
    }
    if (!anchor) {
      reasons.push("现有两次读数相隔不足 30 分钟");
      remainingMs = active[0].time + MIN_READING_GAP_MS - now;
    } else {
      gapMs = latest.time - anchor.time;
      tempDelta = Math.abs(latest.temp - anchor.temp);
      if (tempDelta > MAX_TEMP_DELTA) {
        reasons.push(
          `相隔 30 分钟以上的两次读数温差 ${tempDelta.toFixed(1)}℃，超过 ${MAX_TEMP_DELTA}℃，需继续适应`,
        );
      }
    }
  }

  const ready = pipe.inPosition && reasons.length === 0 && Boolean(anchor) && Boolean(latest);
  return {
    status: ready ? "ready" : "adapting",
    ready,
    reasons,
    active,
    anchor,
    latest,
    gapMs,
    tempDelta,
    remainingMs,
  };
}

export function createPipe(input: NewPipeInput, now: number): Pipe {
  return {
    id: createId(),
    venue: input.venue.trim(),
    stop: input.stop.trim(),
    pipeNo: input.pipeNo.trim(),
    reedState: input.reedState.trim(),
    inPosition: true,
    installedAt: now,
    readings: [],
    resets: [],
    updatedAt: now,
  };
}

export function addReading(pipe: Pipe, input: NewReadingInput): Pipe {
  if (!Number.isFinite(input.time)) throw new Error("读数时间无效");
  if (!Number.isFinite(input.temp)) throw new Error("温度无效");
  if (!Number.isFinite(input.humidity)) throw new Error("湿度无效");
  if (!pipe.inPosition) throw new Error("音管不在位，不能记录读数，请先装回琴室");
  const reset = latestReset(pipe);
  if (reset && input.time <= reset.time) {
    throw new Error("读数时间必须晚于最近一次换位 / 读数中断，计时已从该节点重新开始");
  }
  if (isTuned(pipe)) throw new Error("该音管已完成调音，无需继续读数");

  const reading: Reading = {
    id: createId(),
    time: input.time,
    temp: input.temp,
    humidity: input.humidity,
  };
  return {
    ...pipe,
    readings: [...pipe.readings, reading].sort(byTimeAsc),
    updatedAt: Date.now(),
  };
}

/** 换位 / 读数中断：此前读数保留可查，但不再计入，适应重新计时 */
export function logReset(pipe: Pipe, reason: ResetReason, time: number): Pipe {
  const event: ResetEvent = { id: createId(), time, reason };
  return {
    ...pipe,
    resets: [...pipe.resets, event].sort(byTimeAsc),
    inPosition: reason === "moved" ? false : pipe.inPosition,
    updatedAt: Date.now(),
  };
}

/** 换位后重新装回琴室（计时已在换位时重置） */
export function reinstall(pipe: Pipe, time: number): Pipe {
  if (pipe.inPosition) return pipe;
  return { ...pipe, inPosition: true, installedAt: time, updatedAt: Date.now() };
}

export function tunePipe(pipe: Pipe, input: NewTuningInput, now: number): Pipe {
  const eligibility = evaluate(pipe, now);
  if (!eligibility.ready) {
    throw new Error(eligibility.reasons[0] ?? "适应尚未完成，暂不能调音");
  }
  const pitch = input.pitch.trim();
  if (!pitch) throw new Error("请填写音高");
  if (!Number.isFinite(input.cents)) throw new Error("请填写音分偏差");

  const tuning: Tuning = {
    time: now,
    pitch,
    cents: input.cents,
    abnormal: input.abnormal,
    note: input.note.trim(),
  };
  return { ...pipe, tuning, updatedAt: now };
}

/* ---------- 展示用格式化 ---------- */

const pad2 = (n: number) => String(n).padStart(2, "0");

export function formatClock(ts: number): string {
  const d = new Date(ts);
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

export function formatGap(ms: number): string {
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `${mins} 分钟`;
  const h = Math.floor(mins / 60);
  return `${h} 小时 ${pad2(mins % 60)} 分`;
}

export function formatRemaining(ms: number): string {
  if (ms <= 0) return "已到 30 分钟，请再记录一次读数核对温差";
  const mins = Math.ceil(ms / 60000);
  if (mins < 60) return `${mins} 分钟`;
  return `${Math.floor(mins / 60)} 小时 ${pad2(mins % 60)} 分`;
}

export const RESET_LABEL: Record<ResetReason, string> = {
  moved: "换位取出",
  interrupted: "读数中断",
};
