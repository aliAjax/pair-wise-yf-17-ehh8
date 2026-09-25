import { useEffect, useMemo, useState } from "react";
import {
  ANOMALY_FLAGS,
  MAX_READING_GAP_MS,
  MAX_TEMP_DELTA_C,
  MIN_READING_GAP_MS,
  activeChain,
  addReading,
  createPipe,
  evaluate,
  markInterrupted,
  reposition,
  setInstalled,
  submitTuning,
} from "./acclimatization";
import type {
  AcclimatizationStatus,
  AnomalyFlag,
  PipeEvent,
  PipeState,
  StoreState,
  TuningDraft,
} from "./acclimatization";
import { loadStore, resetStore, saveStore } from "./storage";

const PHASE_TEXT: Record<AcclimatizationStatus["phase"], string> = {
  "not-installed": "离位",
  acclimating: "适应中 · 只读",
  ready: "可以调音",
  tuned: "已调音",
};
const EVENT_TEXT: Record<PipeEvent["kind"], string> = {
  install: "回装在位",
  reposition: "换位重置",
  interrupt: "读数中断",
  tuned: "调音提交",
};

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function clock(ts: number): string {
  const d = new Date(ts);
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(
    d.getHours()
  )}:${pad2(d.getMinutes())}`;
}

function fullClock(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(
    d.getDate()
  )} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function datetimeLocalValue(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(
    d.getDate()
  )}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function remainText(ms: number): string {
  if (ms <= 0) return "0 分钟";
  const minutes = Math.ceil(ms / 60000);
  if (minutes < 60) return `${minutes} 分钟`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h} 小时` : `${h} 小时 ${m} 分`;
}

interface StatusView {
  title: string;
  detail?: string;
  tone: "muted" | "wait" | "warn" | "ok";
}

function describeStatus(status: AcclimatizationStatus, now: number): StatusView {
  const fmtPair = (): string => {
    if (!status.pair) return "";
    const [a, b] = status.pair;
    return `第一次 ${clock(a.at)} / ${a.tempC.toFixed(1)}℃，第二次 ${clock(
      b.at
    )} / ${b.tempC.toFixed(1)}℃`;
  };

  switch (status.kind) {
    case "tuned":
      return { title: "调音已完成并归档", tone: "ok" };
    case "not-installed":
      return {
        title: "管子离位中",
        detail: "重新装回后将从零开始适应，适应完成前音管保持只读。",
        tone: "muted",
      };
    case "no-reading":
      return {
        title: "等待首次现场读数",
        detail: "回装后先记录琴室温湿度，系统据此建立适应过程。",
        tone: "wait",
      };
    case "waiting":
      return {
        title: "适应中 · 音管只读",
        detail: `两次读数需相隔至少 30 分钟。最早可在 ${clock(
          status.nextReadableAt ?? now
        )} 记录第二次读数（约还需 ${remainText(
          (status.nextReadableAt ?? now) - now
        )}）。当前相隔 ${status.gapMin ?? 0} 分钟。`,
        tone: "wait",
      };
    case "temp-mismatch":
      return {
        title: "温差超限，继续适应",
        detail: `${fmtPair()}；相隔 ${status.gapMin} 分钟、温差 ${
          status.tempDelta
        }℃，超过 ${MAX_TEMP_DELTA_C}℃ 上限，请继续保持在位并补记读数。`,
        tone: "warn",
      };
    case "ready":
      return {
        title: "适应条件满足，可以调音",
        detail: `${fmtPair()}；相隔 ${
          status.gapMin
        } 分钟、温差 ${status.tempDelta}℃（≤ ${MAX_TEMP_DELTA_C}℃）。`,
        tone: "ok",
      };
    default:
      return { title: "", tone: "muted" };
  }
}

/* ---------------- 读数录入 ---------------- */

function ReadingForm(props: {
  pipe: PipeState;
  now: number;
  onAdd: (at: number, tempC: number, humidity: number) => void;
  onError: (message: string) => void;
}) {
  const { pipe, now, onAdd, onError } = props;
  const [at, setAt] = useState(datetimeLocalValue(now));
  const [temp, setTemp] = useState("");
  const [humidity, setHumidity] = useState("");

  const submit = () => {
    const ts = new Date(at).getTime();
    const tempC = Number(temp);
    const rh = Number(humidity);
    if (Number.isNaN(ts)) {
      onError("请选择有效的读数时间");
      return;
    }
    if (temp.trim() === "" || Number.isNaN(tempC)) {
      onError("请填写现场温度");
      return;
    }
    if (humidity.trim() === "" || Number.isNaN(rh)) {
      onError("请填写现场湿度");
      return;
    }
    if (tempC < -20 || tempC > 60) {
      onError("温度超出合理范围（-20 ~ 60℃）");
      return;
    }
    if (rh < 0 || rh > 100) {
      onError("湿度应在 0 ~ 100% 之间");
      return;
    }
    onAdd(ts, tempC, rh);
  };

  return (
    <div className="inline-form" key={`reading-${pipe.readings.length}`}>
      <label>
        <span>读数时间</span>
        <input
          type="datetime-local"
          value={at}
          onChange={(e) => setAt(e.target.value)}
        />
      </label>
      <label>
        <span>温度 ℃</span>
        <input
          type="number"
          step="0.1"
          placeholder="如 21.5"
          value={temp}
          onChange={(e) => setTemp(e.target.value)}
        />
      </label>
      <label>
        <span>湿度 %</span>
        <input
          type="number"
          step="1"
          placeholder="如 48"
          value={humidity}
          onChange={(e) => setHumidity(e.target.value)}
        />
      </label>
      <button type="button" className="primary" onClick={submit}>
        记录读数
      </button>
    </div>
  );
}

/* ---------------- 调音提交 ---------------- */

function TuningForm(props: {
  pipe: PipeState;
  onSubmit: (draft: TuningDraft) => void;
  onError: (message: string) => void;
}) {
  const { pipe, onSubmit, onError } = props;
  const [pitch, setPitch] = useState(pipe.pipeNo);
  const [cents, setCents] = useState("");
  const [anomaly, setAnomaly] = useState<AnomalyFlag>("正常");
  const [note, setNote] = useState("");

  const submit = () => {
    const centsValue = Number(cents);
    if (!pitch.trim()) {
      onError("请填写音高");
      return;
    }
    if (cents.trim() === "" || Number.isNaN(centsValue)) {
      onError("请填写音分偏差");
      return;
    }
    if (centsValue < -100 || centsValue > 100) {
      onError("音分偏差超出合理范围（-100 ~ +100 cent）");
      return;
    }
    onSubmit({
      pitch: pitch.trim(),
      cents: Math.round(centsValue * 10) / 10,
      anomaly,
      note: note.trim() || undefined,
    });
  };

  return (
    <div className="tuning-form">
      <div className="inline-form">
        <label>
          <span>音高</span>
          <input
            placeholder="如 C#4"
            value={pitch}
            onChange={(e) => setPitch(e.target.value)}
          />
        </label>
        <label>
          <span>音分偏差 cent</span>
          <input
            type="number"
            step="0.1"
            placeholder="如 +9"
            value={cents}
            onChange={(e) => setCents(e.target.value)}
          />
        </label>
        <label>
          <span>异常标记</span>
          <select
            value={anomaly}
            onChange={(e) => setAnomaly(e.target.value as AnomalyFlag)}
          >
            {ANOMALY_FLAGS.map((flag) => (
              <option key={flag} value={flag}>
                {flag}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className="full">
        <span>维修备注</span>
        <input
          placeholder="簧片状态、处理方式等（选填）"
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
      </label>
      <button type="button" className="primary" onClick={submit}>
        提交调音
      </button>
    </div>
  );
}

/* ---------------- 音管卡片 ---------------- */

function PipeCard(props: {
  pipe: PipeState;
  now: number;
  onReading: (at: number, tempC: number, humidity: number) => void;
  onTuning: (draft: TuningDraft) => void;
  onReposition: () => void;
  onInterrupt: () => void;
  onToggleInstalled: (installed: boolean) => void;
  onError: (message: string) => void;
}) {
  const { pipe, now } = props;
  const status = useMemo(() => evaluate(pipe, now), [pipe, now]);
  const view = describeStatus(status, now);
  const chainIds = useMemo(
    () => new Set(activeChain(pipe.readings).map((r) => r.id)),
    [pipe.readings]
  );
  const sortedReadings = [...pipe.readings].sort((a, b) => b.at - a.at);
  const sortedEvents = [...pipe.events].sort((a, b) => b.at - a.at);
  const locked = status.phase === "tuned";

  return (
    <article className={`pipe-card tone-${view.tone}`}>
      <header className="pipe-head">
        <div>
          <h3>
            {pipe.stop} · {pipe.pipeNo}
          </h3>
          <p className="pipe-venue">{pipe.venue}</p>
        </div>
        <span className={`phase-badge phase-${status.phase}`}>
          {PHASE_TEXT[status.phase]}
        </span>
      </header>

      <div className={`status-box tone-${view.tone}`}>
        <strong>{view.title}</strong>
        {view.detail && <p>{view.detail}</p>}
        {status.stale && status.phase !== "tuned" && (
          <p className="stale-note">
            距上次读数已超过 90 分钟，按读数中断处理，请补记读数继续适应。
          </p>
        )}
      </div>

      {sortedReadings.length > 0 && (
        <table className="reading-table">
          <thead>
            <tr>
              <th>时间</th>
              <th>温度</th>
              <th>湿度</th>
              <th>状态</th>
            </tr>
          </thead>
          <tbody>
            {sortedReadings.map((r) => (
              <tr key={r.id} className={chainIds.has(r.id) ? "" : "voided"}>
                <td>{clock(r.at)}</td>
                <td>{r.tempC.toFixed(1)}℃</td>
                <td>{r.humidity}%</td>
                <td>{chainIds.has(r.id) ? "当前适应链" : "中断前读数"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {!locked && pipe.installed && (
        <>
          <ReadingForm
            pipe={pipe}
            now={now}
            onAdd={props.onReading}
            onError={props.onError}
          />
          <div className="card-actions">
            <button type="button" onClick={props.onReposition}>
              换位 · 重新计时
            </button>
            <button type="button" onClick={props.onInterrupt}>
              读数中断 · 重新计时
            </button>
            <button type="button" onClick={() => props.onToggleInstalled(false)}>
              标记离位
            </button>
          </div>
        </>
      )}

      {!locked && !pipe.installed && (
        <div className="card-actions">
          <button
            type="button"
            className="primary"
            onClick={() => props.onToggleInstalled(true)}
          >
            重新装回在位
          </button>
        </div>
      )}

      {status.phase === "ready" && (
        <TuningForm
          pipe={pipe}
          onSubmit={props.onTuning}
          onError={props.onError}
        />
      )}
      {status.phase === "acclimating" && (
        <p className="readonly-note">适应期间音管只读、不计入完成，暂不能调音。</p>
      )}

      {locked && pipe.tuning && (
        <div className="tuned-result">
          <dl>
            <div>
              <dt>音高</dt>
              <dd>{pipe.tuning.pitch}</dd>
            </div>
            <div>
              <dt>音分偏差</dt>
              <dd>{signedCents(pipe.tuning.cents)}</dd>
            </div>
            <div>
              <dt>异常标记</dt>
              <dd>
                <span
                  className={`flag ${
                    pipe.tuning.anomaly === "正常" ? "flag-ok" : "flag-bad"
                  }`}
                >
                  {pipe.tuning.anomaly}
                </span>
              </dd>
            </div>
            <div>
              <dt>提交时间</dt>
              <dd>{fullClock(pipe.tuning.at)}</dd>
            </div>
          </dl>
          {pipe.tuning.note && <p className="tuning-note">{pipe.tuning.note}</p>}
        </div>
      )}

      <details className="event-log">
        <summary>过程事件（{sortedEvents.length}）</summary>
        <ul>
          {sortedEvents.map((ev) => (
            <li key={ev.id}>
              <span className="event-kind">{EVENT_TEXT[ev.kind]}</span>
              <span className="event-time">{fullClock(ev.at)}</span>
              {ev.note && <span className="event-note">{ev.note}</span>}
            </li>
          ))}
        </ul>
      </details>
    </article>
  );
}

function signedCents(value: number): string {
  return `${value > 0 ? "+" : ""}${value} cent`;
}

/* ---------------- 工作台页面 ---------------- */

export default function Workbench() {
  const [store, setStore] = useState<StoreState>(() => loadStore());
  const [now, setNow] = useState(() => Date.now());
  const [stopInput, setStopInput] = useState("");
  const [pipeNoInput, setPipeNoInput] = useState("");
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => saveStore(store), [store]);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 20_000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 4000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const updatePipe = (id: string, updater: (pipe: PipeState) => PipeState) => {
    setStore((prev) => ({
      ...prev,
      pipes: prev.pipes.map((p) => (p.id === id ? updater(p) : p)),
    }));
  };

  const stats = useMemo(() => {
    let acclimating = 0;
    let ready = 0;
    let tuned = 0;
    for (const pipe of store.pipes) {
      const phase = evaluate(pipe, now).phase;
      if (phase === "acclimating") acclimating += 1;
      else if (phase === "ready") ready += 1;
      else if (phase === "tuned") tuned += 1;
    }
    return {
      total: store.pipes.length,
      acclimating,
      ready,
      tuned,
      other: store.pipes.length - acclimating - ready - tuned,
    };
  }, [store.pipes, now]);

  const addPipe = () => {
    if (!stopInput.trim() || !pipeNoInput.trim()) {
      setNotice("请先填写音栓与音管编号");
      return;
    }
    const pipe = createPipe(
      { venue: store.venue, stop: stopInput, pipeNo: pipeNoInput },
      Date.now()
    );
    setStore((prev) => ({ ...prev, pipes: [pipe, ...prev.pipes] }));
    setStopInput("");
    setPipeNoInput("");
    setNotice("音管已登记为在位，适应计时开始");
  };

  const tunedRows = useMemo(
    () =>
      store.pipes
        .filter((p) => p.tuning)
        .sort(
          (a, b) => (b.tuning?.at ?? 0) - (a.tuning?.at ?? 0)
        ),
    [store.pipes]
  );

  return (
    <main className="app workbench-app">
      <section className="hero compact">
        <p>回装适应工作台 · 数据仅存本机浏览器（localStorage），不上传</p>
        <h1>管风琴音管调音记录</h1>
        <span>
          维修后的音管装回琴室后，先依据现场温湿度完成回装适应，再进行调音，避免凭感觉即时调音导致次日走音。
        </span>
      </section>

      <section className="rule-banner panel">
        <h2>适应规则</h2>
        <ol>
          <li>
            音管回装在位后，持续记录现场温湿度，系统据此建立适应过程。
          </li>
          <li>
            管子<strong>在位</strong>，且<strong>相隔至少 30 分钟</strong>的两次读数
            <strong>温差不超过 {MAX_TEMP_DELTA_C}℃</strong>，才允许调音。
          </li>
          <li>适应期间音管只读、不计入完成。</li>
          <li>
            换位或读数中断立即清空读数、重新计时；相邻读数间隔超过{" "}
            {MAX_READING_GAP_MS / 60000} 分钟同样按中断处理。
          </li>
        </ol>
      </section>

      {notice && <div className="notice-bar">{notice}</div>}

      <section className="metrics">
        <article>
          <small>音管总数</small>
          <strong>{stats.total}</strong>
        </article>
        <article>
          <small>适应中（只读，不计完成）</small>
          <strong className="metric-wait">{stats.acclimating}</strong>
        </article>
        <article>
          <small>可以调音</small>
          <strong className="metric-ok">{stats.ready}</strong>
        </article>
        <article>
          <small>已完成调音</small>
          <strong className="metric-done">
            {stats.tuned}
            <em> / {stats.total}</em>
          </strong>
        </article>
      </section>

      <section className="workspace">
        <aside className="panel side-panel">
          <h2>现场信息</h2>
          <label className="full">
            <span>教堂 / 音乐厅</span>
            <input
              value={store.venue}
              onChange={(e) =>
                setStore((prev) => ({ ...prev, venue: e.target.value }))
              }
            />
          </label>
          <p className="hint">当前时间 {fullClock(now)}</p>
          <p className="hint">
            两次读数最小间隔 {MIN_READING_GAP_MS / 60000} 分钟 · 温差上限{" "}
            {MAX_TEMP_DELTA_C}℃
          </p>

          <h2 className="side-sub">登记回装音管</h2>
          <label className="full">
            <span>音栓</span>
            <input
              placeholder="如 Trumpet 8'"
              value={stopInput}
              onChange={(e) => setStopInput(e.target.value)}
            />
          </label>
          <label className="full">
            <span>音管编号</span>
            <input
              placeholder="如 C#4"
              value={pipeNoInput}
              onChange={(e) => setPipeNoInput(e.target.value)}
            />
          </label>
          <button type="button" className="primary wide" onClick={addPipe}>
            装回并开始适应
          </button>

          <h2 className="side-sub">本机数据</h2>
          <p className="hint">
            适应状态、温湿度读数与调音记录均保存在当前浏览器，不经过网络。
          </p>
          <button
            type="button"
            className="wide"
            onClick={() => {
              if (
                window.confirm("确定清空全部本机记录并重建示例数据吗？此操作不可撤销。")
              ) {
                setStore(resetStore());
                setNotice("本机记录已重置");
              }
            }}
          >
            清空本机记录
          </button>
        </aside>

        <section className="pipe-grid">
          {store.pipes.length === 0 && (
            <div className="panel empty">还没有回装音管，请先在左侧登记。</div>
          )}
          {store.pipes.map((pipe) => (
            <PipeCard
              key={pipe.id}
              pipe={pipe}
              now={now}
              onError={setNotice}
              onReading={(at, tempC, humidity) =>
                updatePipe(pipe.id, (p) => addReading(p, { at, tempC, humidity }))
              }
              onTuning={(draft) =>
                updatePipe(pipe.id, (p) => {
                  try {
                    const next = submitTuning(p, draft, Date.now());
                    setNotice("调音已提交并归档");
                    return next;
                  } catch (error) {
                    setNotice(
                      error instanceof Error ? error.message : "调音提交失败"
                    );
                    return p;
                  }
                })
              }
              onReposition={() =>
                updatePipe(pipe.id, (p) => {
                  setNotice("已记录换位，读数清零，重新计时");
                  return reposition(p, Date.now());
                })
              }
              onInterrupt={() =>
                updatePipe(pipe.id, (p) => {
                  setNotice("已记录读数中断，读数清零，重新计时");
                  return markInterrupted(p, Date.now());
                })
              }
              onToggleInstalled={(installed) =>
                updatePipe(pipe.id, (p) => {
                  setNotice(installed ? "已重新装回在位，开始适应" : "已标记离位，读数清零");
                  return setInstalled(p, installed, Date.now());
                })
              }
            />
          ))}
        </section>
      </section>

      <section className="panel report-panel">
        <div className="heading">
          <div>
            <p>单次维护报告</p>
            <h2>调音提交记录（{tunedRows.length}）</h2>
          </div>
        </div>
        {tunedRows.length === 0 ? (
          <p className="hint">暂无已提交调音的音管。</p>
        ) : (
          <div className="table-scroll">
            <table className="report-table">
              <thead>
                <tr>
                  <th>提交时间</th>
                  <th>场馆</th>
                  <th>音栓</th>
                  <th>音管编号</th>
                  <th>音高</th>
                  <th>音分偏差</th>
                  <th>异常标记</th>
                  <th>维修备注</th>
                </tr>
              </thead>
              <tbody>
                {tunedRows.map((p) => (
                  <tr key={p.id}>
                    <td>{fullClock(p.tuning!.at)}</td>
                    <td>{p.venue}</td>
                    <td>{p.stop}</td>
                    <td>{p.pipeNo}</td>
                    <td>{p.tuning!.pitch}</td>
                    <td>{signedCents(p.tuning!.cents)}</td>
                    <td>
                      <span
                        className={`flag ${
                          p.tuning!.anomaly === "正常" ? "flag-ok" : "flag-bad"
                        }`}
                      >
                        {p.tuning!.anomaly}
                      </span>
                    </td>
                    <td>{p.tuning!.note ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </main>
  );
}
