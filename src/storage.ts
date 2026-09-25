// 调音记录的本机存储：仅使用浏览器 localStorage，不做任何远端同步
import type { PipeState, StoreState } from "./acclimatization";
import { createPipe, newId, submitTuning } from "./acclimatization";
import type { TuningDraft } from "./acclimatization";

const STORAGE_KEY = "hxyfront-62005:organ-workbench:v1";

function seed(now: number): StoreState {
  const pipes: PipeState[] = [];

  // 正在适应：已有两次读数，但温差超 1.5℃
  const acclimating = createPipe(
    { venue: "St.Mary 教堂", stop: "Trumpet 8'", pipeNo: "C#4" },
    now - 45 * 60 * 1000
  );
  acclimating.readings.push(
    {
      id: newId(),
      at: now - 35 * 60 * 1000,
      tempC: 20.4,
      humidity: 48,
    },
    {
      id: newId(),
      at: now - 2 * 60 * 1000,
      tempC: 22.6,
      humidity: 45,
    }
  );
  pipes.push(acclimating);

  // 已达适应条件：相隔 32 分钟、温差 0.8℃，等待调音提交
  const ready = createPipe(
    { venue: "St.Mary 教堂", stop: "Principal 4'", pipeNo: "G3" },
    now - 90 * 60 * 1000
  );
  ready.readings.push(
    { id: newId(), at: now - 32 * 60 * 1000, tempC: 21.2, humidity: 50 },
    { id: newId(), at: now, tempC: 22.0, humidity: 49 }
  );
  pipes.push(ready);

  // 已完成调音
  const tuned = createPipe(
    { venue: "Abbey Room", stop: "Bourdon 16'", pipeNo: "F2" },
    now - 26 * 60 * 60 * 1000
  );
  tuned.readings.push(
    {
      id: newId(),
      at: now - 25 * 60 * 60 * 1000,
      tempC: 19.6,
      humidity: 55,
    },
    {
      id: newId(),
      at: now - 24 * 60 * 60 * 1000,
      tempC: 19.9,
      humidity: 54,
    }
  );
  pipes.push(
    submitTuning(
      tuned,
      { pitch: "F2", cents: -12, anomaly: "需复检", note: "标记次日复检" },
      now - 23 * 60 * 60 * 1000
    )
  );

  return { venue: "St.Mary 教堂", pipes };
}

/** 读取本机记录；首次使用时写入演示数据 */
export function loadStore(): StoreState {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as StoreState;
      if (parsed && Array.isArray(parsed.pipes)) {
        return parsed;
      }
    }
  } catch (error) {
    console.warn("本机记录读取失败，将重建空工作台", error);
  }
  const initial = seed(Date.now());
  saveStore(initial);
  return initial;
}

/** 持久化到本机 */
export function saveStore(state: StoreState): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (error) {
    console.warn("本机记录写入失败", error);
  }
}

/** 清空全部本机记录并重建演示数据 */
export function resetStore(): StoreState {
  const fresh = seed(Date.now());
  saveStore(fresh);
  return fresh;
}

export type { StoreState, PipeState, TuningDraft };
