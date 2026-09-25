// 音管回装适应状态机：温湿度读数链、适应判定与调音准入
// 纯业务逻辑，不依赖 React / localStorage，便于测试与复用

/** 两次读数之间至少相隔 30 分钟 */
export const MIN_READING_GAP_MS = 30 * 60 * 1000;
/** 两次读数允许的最大温差 1.5℃ */
export const MAX_TEMP_DELTA_C = 1.5;
/** 相邻读数间隔超过 90 分钟视为读数中断，更早的读数移出当前适应链 */
export const MAX_READING_GAP_MS = 90 * 60 * 1000;

export const ANOMALY_FLAGS = [
  "正常",
  "簧片需微调",
  "偏差超限",
  "漏气",
  "需复检",
] as const;
export type AnomalyFlag = (typeof ANOMALY_FLAGS)[number];

export interface Reading {
  id: string;
  /** 读数时间戳（毫秒） */
  at: number;
  /** 现场温度 ℃ */
  tempC: number;
  /** 现场相对湿度 % */
  humidity: number;
}

export type PipeEventKind = "install" | "reposition" | "interrupt" | "tuned";

export interface PipeEvent {
  id: string;
  at: number;
  kind: PipeEventKind;
  note?: string;
}

export interface TuningDraft {
  pitch: string;
  cents: number;
  anomaly: AnomalyFlag;
  note?: string;
}

export interface TuningResult extends TuningDraft {
  at: number;
}

export interface PipeState {
  id: string;
  venue: string;
  /** 音栓 */
  stop: string;
  /** 音管编号 */
  pipeNo: string;
  /** 管子是否在位 */
  installed: boolean;
  /** 现场温湿度读数（换位 / 中断后清空） */
  readings: Reading[];
  /** 回装、换位、中断、调音等过程事件 */
  events: PipeEvent[];
  /** 调音提交结果；存在即表示该音管已完成 */
  tuning?: TuningResult;
}

export interface StoreState {
  venue: string;
  pipes: PipeState[];
}

export type PipePhase = "not-installed" | "acclimating" | "ready" | "tuned";

export type StatusKind =
  | "tuned"
  | "not-installed"
  | "no-reading"
  | "waiting"
  | "temp-mismatch"
  | "ready";

export interface AcclimatizationStatus {
  phase: PipePhase;
  kind: StatusKind;
  /** 达成或对比所用的两次读数（早, 晚） */
  pair?: [Reading, Reading];
  /** 两次读数相隔分钟数 */
  gapMin?: number;
  /** 两次读数温差 ℃ */
  tempDelta?: number;
  /** waiting 状态下，最早可以记录第二次读数的时刻 */
  nextReadableAt?: number;
  /** 距最近一次读数是否已超过 MAX_READING_GAP_MS */
  stale: boolean;
  /** 最近一次读数时间 */
  latestAt?: number;
}

export function newId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/**
 * 当前适应链：按时间排序后的读数中，最后一次「相邻读数间隔超过
 * MAX_READING_GAP_MS」之后的读数视为有效（客观上的读数中断）。
 */
export function activeChain(readings: Reading[]): Reading[] {
  const sorted = [...readings].sort((a, b) => a.at - b.at);
  let start = 0;
  for (let i = 1; i < sorted.length; i += 1) {
    if (sorted[i].at - sorted[i - 1].at > MAX_READING_GAP_MS) {
      start = i;
    }
  }
  return sorted.slice(start);
}

/** 判定音管是否满足调音条件 */
export function evaluate(pipe: PipeState, now: number): AcclimatizationStatus {
  if (pipe.tuning) {
    return { phase: "tuned", kind: "tuned", stale: false };
  }
  if (!pipe.installed) {
    return { phase: "not-installed", kind: "not-installed", stale: false };
  }

  const chain = activeChain(pipe.readings);
  if (chain.length === 0) {
    return { phase: "acclimating", kind: "no-reading", stale: false };
  }

  const latest = chain[chain.length - 1];
  const stale = now - latest.at > MAX_READING_GAP_MS;
  // 以最近读数为锚点，取「最近一次距当前至少 30 分钟」的读数对比：
  // 温差 ≤1.5℃ 即达标，否则温差超限（再早的读数差距更大，不再考虑）
  const earlier = [...chain.slice(0, -1)]
    .reverse()
    .find((r) => latest.at - r.at >= MIN_READING_GAP_MS);

  if (earlier) {
    const gap = latest.at - earlier.at;
    const delta = Math.abs(latest.tempC - earlier.tempC);
    const base = {
      pair: [earlier, latest] as [Reading, Reading],
      gapMin: Math.round(gap / 60000),
      tempDelta: round1(delta),
      stale,
      latestAt: latest.at,
    };
    if (delta <= MAX_TEMP_DELTA_C + 1e-9) {
      return { phase: "ready", kind: "ready", ...base };
    }
    return { phase: "acclimating", kind: "temp-mismatch", ...base };
  }

  const first = chain[0];
  return {
    phase: "acclimating",
    kind: "waiting",
    pair: [first, latest],
    gapMin: Math.round((latest.at - first.at) / 60000),
    nextReadableAt: first.at + MIN_READING_GAP_MS,
    stale,
    latestAt: latest.at,
  };
}

function appendEvent(
  pipe: PipeState,
  kind: PipeEventKind,
  at: number,
  note?: string
): PipeEvent[] {
  return [...pipe.events, { id: newId(), at, kind, note }];
}

/** 新增一根回装音管，默认已在位并开始适应 */
export function createPipe(
  input: { venue: string; stop: string; pipeNo: string },
  now: number
): PipeState {
  return {
    id: newId(),
    venue: input.venue.trim(),
    stop: input.stop.trim(),
    pipeNo: input.pipeNo.trim(),
    installed: true,
    readings: [],
    events: [{ id: newId(), at: now, kind: "install" }],
  };
}

/** 切换在位状态：离位会清空读数并重新计时 */
export function setInstalled(
  pipe: PipeState,
  installed: boolean,
  now: number
): PipeState {
  if (installed === pipe.installed) {
    return pipe;
  }
  if (installed) {
    return {
      ...pipe,
      installed: true,
      events: appendEvent(pipe, "install", now),
    };
  }
  return {
    ...pipe,
    installed: false,
    readings: [],
    events: appendEvent(pipe, "interrupt", now, "管子离位，适应计时清零"),
  };
}

/** 记录一次现场温湿度读数 */
export function addReading(
  pipe: PipeState,
  reading: Omit<Reading, "id">
): PipeState {
  if (pipe.tuning || !pipe.installed) {
    return pipe;
  }
  return {
    ...pipe,
    readings: [...pipe.readings, { ...reading, id: newId() }],
  };
}

/** 音管换位：读数链清空，重新计时 */
export function reposition(pipe: PipeState, now: number): PipeState {
  if (pipe.tuning) {
    return pipe;
  }
  return {
    ...pipe,
    installed: true,
    readings: [],
    events: appendEvent(pipe, "reposition", now, "音管换位，重新计时"),
  };
}

/** 读数中断：读数链清空，重新计时 */
export function markInterrupted(pipe: PipeState, now: number): PipeState {
  if (pipe.tuning) {
    return pipe;
  }
  return {
    ...pipe,
    readings: [],
    events: appendEvent(pipe, "interrupt", now, "读数中断，重新计时"),
  };
}

/** 调音提交：仅当满足在位 + 30 分钟 + 温差 1.5℃ 条件时允许 */
export function submitTuning(
  pipe: PipeState,
  draft: TuningDraft,
  now: number
): PipeState {
  const status = evaluate(pipe, now);
  if (status.phase !== "ready") {
    throw new Error("音管尚未完成回装适应，暂不能调音");
  }
  return {
    ...pipe,
    tuning: { at: now, ...draft },
    events: appendEvent(pipe, "tuned", now),
  };
}
