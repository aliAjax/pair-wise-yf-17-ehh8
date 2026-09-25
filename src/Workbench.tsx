import { useEffect, useMemo, useState } from "react";
import {
  addReading,
  createPipe,
  evaluate,
  formatClock,
  formatGap,
  formatRemaining,
  isTuned,
  latestReset,
  logReset,
  reinstall,
  RESET_LABEL,
  tunePipe,
  MAX_TEMP_DELTA,
  MIN_READING_GAP_MS,
  type Pipe,
  type PipeStatus,
  type ResetReason,
} from "./acclimatization";
import { clearPipes, loadPipes, savePipes } from "./storage";

type StatusFilter = "all" | PipeStatus | "abnormal";

const FILTERS: { key: StatusFilter; label: string }[] = [
  { key: "all", label: "全部" },
  { key: "adapting", label: "适应中" },
  { key: "ready", label: "可调音" },
  { key: "tuned", label: "已调音" },
  { key: "abnormal", label: "异常标记" },
];

const pad2 = (n: number) => String(n).padStart(2, "0");

function toLocalInputValue(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(
    d.getHours(),
  )}:${pad2(d.getMinutes())}`;
}

interface Notice {
  type: "error" | "ok";
  text: string;
}

export default function Workbench() {
  const [pipes, setPipes] = useState<Pipe[]>(() => loadPipes());
  const [selectedId, setSelectedId] = useState<string | null>(
    () => loadPipes()[0]?.id ?? null,
  );
  const [filter, setFilter] = useState<StatusFilter>("all");
  const [now, setNow] = useState(() => Date.now());
  const [notice, setNotice] = useState<Notice | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [newForm, setNewForm] = useState({ venue: "", stop: "", pipeNo: "", reedState: "" });

  // 读数表单
  const [readTime, setReadTime] = useState(() => toLocalInputValue(new Date()));
  const [temp, setTemp] = useState("");
  const [humidity, setHumidity] = useState("");

  // 调音表单
  const [pitch, setPitch] = useState("");
  const [cents, setCents] = useState("");
  const [abnormal, setAbnormal] = useState(false);
  const [note, setNote] = useState("");

  useEffect(() => savePipes(pipes), [pipes]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 20_000);
    return () => window.clearInterval(timer);
  }, []);

  const selected = pipes.find((p) => p.id === selectedId) ?? null;

  useEffect(() => {
    setPitch(selected?.pipeNo ?? "");
    setCents("");
    setAbnormal(false);
    setNote("");
    setNotice(null);
  }, [selectedId]); // 切换音管时重置表单与提示

  const eligibility = selected ? evaluate(selected, now) : null;

  const counts = useMemo(() => {
    const c = { adapting: 0, ready: 0, tuned: 0, abnormal: 0 };
    pipes.forEach((p) => {
      c[evaluate(p, now).status] += 1;
      if (p.tuning?.abnormal) c.abnormal += 1;
    });
    return c;
  }, [pipes, now]);

  const visiblePipes = pipes.filter((p) => {
    if (filter === "all") return true;
    if (filter === "abnormal") return Boolean(p.tuning?.abnormal);
    return evaluate(p, now).status === filter;
  });

  function commit(updated: Pipe) {
    setPipes((prev) => prev.map((p) => (p.id === updated.id ? updated : p)));
  }

  function flash(n: Notice) {
    setNotice(n);
  }

  function handleAddReading() {
    if (!selected) return;
    try {
      const time = new Date(readTime).getTime();
      if (!readTime || Number.isNaN(time)) throw new Error("请选择读数时间");
      const t = Number(temp);
      const h = Number(humidity);
      if (!Number.isFinite(t)) throw new Error("请填写温度（℃）");
      if (!Number.isFinite(h)) throw new Error("请填写相对湿度（%）");
      commit(addReading(selected, { time, temp: t, humidity: h }));
      setTemp("");
      setHumidity("");
      setReadTime(toLocalInputValue(new Date()));
      flash({ type: "ok", text: "读数已记录，适应进度已更新" });
    } catch (error) {
      flash({ type: "error", text: error instanceof Error ? error.message : "读数无效" });
    }
  }

  function handleReset(reason: ResetReason) {
    if (!selected) return;
    const label = RESET_LABEL[reason];
    if (!window.confirm(`确认登记「${label}」？适应计时将重新开始，此前读数保留但不再计入。`)) {
      return;
    }
    commit(logReset(selected, reason, Date.now()));
    flash({ type: "ok", text: `已登记${label}，适应重新计时` });
  }

  function handleReinstall() {
    if (!selected) return;
    commit(reinstall(selected, Date.now()));
    flash({ type: "ok", text: "音管已重新装回琴室，请从当前温湿度开始建立适应" });
  }

  function handleTune() {
    if (!selected) return;
    try {
      const value = Number(cents);
      if (!Number.isFinite(value)) throw new Error("请填写音分偏差");
      const updated = tunePipe(
        selected,
        { pitch, cents: value, abnormal, note },
        Date.now(),
      );
      commit(updated);
      flash({ type: "ok", text: abnormal ? "调音已提交，并已标记为异常音管" : "调音已提交，本音管计入完成" });
    } catch (error) {
      flash({ type: "error", text: error instanceof Error ? error.message : "提交失败" });
    }
  }

  function handleCreatePipe() {
    try {
      if (!newForm.venue.trim() || !newForm.stop.trim() || !newForm.pipeNo.trim()) {
        throw new Error("请填写场馆、音栓与音管编号");
      }
      const pipe = createPipe(newForm, Date.now());
      setPipes((prev) => [pipe, ...prev]);
      setSelectedId(pipe.id);
      setShowNew(false);
      setNewForm({ venue: "", stop: "", pipeNo: "", reedState: "" });
      flash({ type: "ok", text: "音管已建档：装回琴室，请记录第一次现场温湿度读数" });
    } catch (error) {
      flash({ type: "error", text: error instanceof Error ? error.message : "建档失败" });
    }
  }

  function handleClearLocal() {
    if (!window.confirm("将清除本机所有适应与调音记录（不可恢复），确定继续？")) return;
    clearPipes();
    window.location.reload();
  }

  return (
    <main className="app">
      <section className="hero">
        <p>回装适应工作台 · 数据仅存本机</p>
        <h1>管风琴音管调音记录</h1>
        <span>
          音管维修装回琴室后，先依据现场温湿度完成适应：音管在位，且相隔至少 30
          分钟的两次读数温差不超过 1.5℃ 才允许调音。适应期间音管只读、不计完成；换位或读数中断，适应重新计时。
        </span>
      </section>

      <section className="metrics">
        <article>
          <small>音管数量</small>
          <strong>{pipes.length}</strong>
        </article>
        <article>
          <small>适应中</small>
          <strong className="metric-warn">{counts.adapting}</strong>
        </article>
        <article>
          <small>可调音</small>
          <strong className="metric-ok">{counts.ready}</strong>
        </article>
        <article>
          <small>已完成 / 异常</small>
          <strong>
            {counts.tuned}
            <em className={counts.abnormal > 0 ? "abnormal-text" : ""}>/{counts.abnormal}</em>
          </strong>
        </article>
      </section>

      <section className="workspace">
        <aside className="panel">
          <div className="heading">
            <div>
              <p>适应状态</p>
              <h2>音管列表</h2>
            </div>
            <button className="primary" onClick={() => setShowNew((v) => !v)}>
              {showNew ? "收起" : "新增音管"}
            </button>
          </div>

          <div className="chips">
            {FILTERS.map((f) => (
              <button
                key={f.key}
                className={filter === f.key ? "chip-active" : ""}
                onClick={() => setFilter(f.key)}
              >
                {f.label}
              </button>
            ))}
          </div>

          {showNew && (
            <div className="new-pipe">
              {(
                [
                  ["venue", "场馆名称"],
                  ["stop", "音栓"],
                  ["pipeNo", "音管编号"],
                  ["reedState", "簧片状态"],
                ] as const
              ).map(([key, label]) => (
                <label key={key}>
                  <span>{label}</span>
                  <input
                    value={newForm[key]}
                    placeholder={"填写" + label}
                    onChange={(e) => setNewForm((f) => ({ ...f, [key]: e.target.value }))}
                  />
                </label>
              ))}
              <button className="primary" onClick={handleCreatePipe}>
                建档并开始适应
              </button>
            </div>
          )}

          <div className="pipe-list">
            {visiblePipes.length === 0 && <p className="empty">当前筛选下没有音管</p>}
            {visiblePipes.map((p) => (
              <PipeListItem
                key={p.id}
                pipe={p}
                status={evaluate(p, now).status}
                active={p.id === selectedId}
                onSelect={() => setSelectedId(p.id)}
              />
            ))}
          </div>
        </aside>

        <section className="panel form-panel">
          {!selected || !eligibility ? (
            <div className="empty-detail">
              <h2>请选择或新增一支音管</h2>
              <p>从左侧列表选择音管查看适应过程，或为维修后装回的音管建档。</p>
            </div>
          ) : (
            <PipeDetail
              pipe={selected}
              eligibility={eligibility}
              now={now}
              notice={notice}
              readTime={readTime}
              temp={temp}
              humidity={humidity}
              pitch={pitch}
              cents={cents}
              abnormal={abnormal}
              note={note}
              onReadTime={setReadTime}
              onTemp={setTemp}
              onHumidity={setHumidity}
              onPitch={setPitch}
              onCents={setCents}
              onAbnormal={setAbnormal}
              onNote={setNote}
              onAddReading={handleAddReading}
              onReset={handleReset}
              onReinstall={handleReinstall}
              onTune={handleTune}
            />
          )}
        </section>
      </section>

      <section className="panel local-bar">
        <div>
          <strong>本机存储</strong>
          <p>适应过程、读数与调音记录仅保存在本浏览器（localStorage），不会上传服务器。</p>
        </div>
        <button onClick={handleClearLocal}>清除本机数据</button>
      </section>
    </main>
  );
}

function StatusBadge({ status }: { status: PipeStatus }) {
  const map: Record<PipeStatus, string> = {
    adapting: "适应中",
    ready: "可调音",
    tuned: "已调音",
  };
  return <span className={`badge badge-${status}`}>{map[status]}</span>;
}

function PipeListItem({
  pipe,
  status,
  active,
  onSelect,
}: {
  pipe: Pipe;
  status: PipeStatus;
  active: boolean;
  onSelect: () => void;
}) {
  const tuned = isTuned(pipe);
  return (
    <button className={`pipe-item${active ? " pipe-item-active" : ""}`} onClick={onSelect}>
      <span className="pipe-item-head">
        <b>{pipe.pipeNo}</b>
        <StatusBadge status={status} />
      </span>
      <span className="pipe-item-sub">
        {pipe.venue} · {pipe.stop}
      </span>
      {tuned && pipe.tuning?.abnormal && <span className="flag-inline">⚠ 异常标记</span>}
      {!pipe.inPosition && <span className="flag-inline flag-out">换位取出中</span>}
    </button>
  );
}

interface DetailProps {
  pipe: Pipe;
  eligibility: ReturnType<typeof evaluate>;
  now: number;
  notice: Notice | null;
  readTime: string;
  temp: string;
  humidity: string;
  pitch: string;
  cents: string;
  abnormal: boolean;
  note: string;
  onReadTime: (v: string) => void;
  onTemp: (v: string) => void;
  onHumidity: (v: string) => void;
  onPitch: (v: string) => void;
  onCents: (v: string) => void;
  onAbnormal: (v: boolean) => void;
  onNote: (v: string) => void;
  onAddReading: () => void;
  onReset: (reason: ResetReason) => void;
  onReinstall: () => void;
  onTune: () => void;
}

function PipeDetail(props: DetailProps) {
  const { pipe, eligibility: e, notice } = props;
  const reset = latestReset(pipe);
  const cutoff = reset?.time ?? -Infinity;
  const readingLocked = !pipe.inPosition || e.status === "tuned";

  const timeline = [
    ...pipe.readings.map((r) => ({ kind: "reading" as const, time: r.time, data: r })),
    ...pipe.resets.map((r) => ({ kind: "reset" as const, time: r.time, data: r })),
    ...(pipe.tuning ? [{ kind: "tuning" as const, time: pipe.tuning.time, data: pipe.tuning }] : []),
  ].sort((a, b) => b.time - a.time);

  return (
    <>
      <div className="heading">
        <div>
          <p>{pipe.venue}</p>
          <h2>
            {pipe.stop} · {pipe.pipeNo} <StatusBadge status={e.status} />
          </h2>
        </div>
        <div className="head-actions">
          {!pipe.inPosition ? (
            <button className="primary" onClick={props.onReinstall}>
              已重新装回琴室
            </button>
          ) : (
            <>
              <button onClick={() => props.onReset("moved")}>登记换位取出</button>
              <button onClick={() => props.onReset("interrupted")}>登记读数中断</button>
            </>
          )}
        </div>
      </div>

      <dl className="meta-grid">
        <div>
          <dt>簧片状态</dt>
          <dd>{pipe.reedState || "—"}</dd>
        </div>
        <div>
          <dt>装回琴室时间</dt>
          <dd>{formatClock(pipe.installedAt)}</dd>
        </div>
        <div>
          <dt>最近重置节点</dt>
          <dd>
            {reset ? `${RESET_LABEL[reset.reason]} · ${formatClock(reset.time)}` : "无，计时自装回起算"}
          </dd>
        </div>
        <div>
          <dt>在位状态</dt>
          <dd>{pipe.inPosition ? "在位" : "换位取出中"}</dd>
        </div>
      </dl>

      <div className={`banner banner-${e.status}`}>
        {e.status === "tuned" && pipe.tuning ? (
          <p>
            已于 {formatClock(pipe.tuning.time)} 完成调音（{pipe.tuning.pitch}，
            {pipe.tuning.cents > 0 ? "+" : ""}
            {pipe.tuning.cents} cent）
            {pipe.tuning.abnormal ? "，已标记异常" : ""}。此后再换位或读数中断将重新适应。
          </p>
        ) : !pipe.inPosition ? (
          <p>音管已换位取出：适应计时作废。装回琴室后从第一次读数重新开始。</p>
        ) : e.ready && e.anchor && e.latest ? (
          <p>
            适应完成：{formatClock(e.anchor.time)}（{e.anchor.temp}℃）与{" "}
            {formatClock(e.latest.time)}（{e.latest.temp}℃）相隔{" "}
            {formatGap(e.gapMs ?? MIN_READING_GAP_MS)}，温差{" "}
            {(e.tempDelta ?? 0).toFixed(1)}℃ ≤ {MAX_TEMP_DELTA}℃，可以调音。
          </p>
        ) : (
          <div>
            <p>适应中，音管只读且不计完成，暂不能调音：</p>
            <ul>
              {e.reasons.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
            {e.remainingMs !== undefined && e.remainingMs > 0 && (
              <p className="countdown">
                距首次读数满 30 分钟还需 <b>{formatRemaining(e.remainingMs)}</b>
              </p>
            )}
          </div>
        )}
      </div>

      {notice && <div className={`notice notice-${notice.type}`}>{notice.text}</div>}

      <div className="detail-columns">
        <div className="subpanel">
          <h3>现场温湿度读数</h3>
          <fieldset className="entry-form" disabled={readingLocked}>
            {readingLocked && (
              <p className="lock-note">
                {e.status === "tuned" ? "已完成调音，读数表单已锁定。" : "音管不在位，装回后才能继续记录读数。"}
              </p>
            )}
            <label>
              <span>读数时间</span>
              <input
                type="datetime-local"
                value={props.readTime}
                onChange={(ev) => props.onReadTime(ev.target.value)}
              />
            </label>
            <div className="two-col">
              <label>
                <span>温度 ℃</span>
                <input
                  type="number"
                  step="0.1"
                  placeholder="如 20.5"
                  value={props.temp}
                  onChange={(ev) => props.onTemp(ev.target.value)}
                />
              </label>
              <label>
                <span>相对湿度 %</span>
                <input
                  type="number"
                  step="1"
                  placeholder="如 48"
                  value={props.humidity}
                  onChange={(ev) => props.onHumidity(ev.target.value)}
                />
              </label>
            </div>
            <button className="primary" onClick={props.onAddReading}>
              记录读数
            </button>
          </fieldset>

          <ol className="timeline">
            {timeline.map((item) => {
              if (item.kind === "reset") {
                const r = item.data as (typeof pipe.resets)[number];
                return (
                  <li key={r.id} className="tl-reset">
                    <span className="tl-time">{formatClock(item.time)}</span>
                    <span className="tl-tag">↻ {RESET_LABEL[r.reason]}，重新计时</span>
                  </li>
                );
              }
              if (item.kind === "tuning") {
                const t = item.data as NonNullable<Pipe["tuning"]>;
                return (
                  <li key="tuning" className="tl-tuning">
                    <span className="tl-time">{formatClock(item.time)}</span>
                    <span className="tl-tag">
                      ♪ 调音 {t.pitch} {t.cents > 0 ? "+" : ""}
                      {t.cents} cent{t.abnormal ? " · 异常" : ""}
                    </span>
                  </li>
                );
              }
              const r = item.data as (typeof pipe.readings)[number];
              const active = r.time > cutoff;
              return (
                <li key={r.id} className={active ? "tl-reading" : "tl-reading tl-stale"}>
                  <span className="tl-time">{formatClock(item.time)}</span>
                  <span className="tl-tag">
                    {r.temp}℃ · {r.humidity}%{active ? "" : "（重置前，不计入）"}
                  </span>
                </li>
              );
            })}
            {timeline.length === 0 && <li className="tl-empty">暂无读数与重置记录</li>}
          </ol>
        </div>

        <div className="subpanel">
          <h3>调音提交</h3>
          {e.status === "tuned" && pipe.tuning ? (
            <div className="tuning-result">
              <div className="tuning-row">
                <span>音高</span>
                <b>{pipe.tuning.pitch}</b>
              </div>
              <div className="tuning-row">
                <span>音分偏差</span>
                <b className={pipe.tuning.abnormal ? "abnormal-text" : ""}>
                  {pipe.tuning.cents > 0 ? "+" : ""}
                  {pipe.tuning.cents} cent
                </b>
              </div>
              <div className="tuning-row">
                <span>异常标记</span>
                <b>{pipe.tuning.abnormal ? "⚠ 已标记异常，需复检" : "正常"}</b>
              </div>
              <div className="tuning-row">
                <span>维修备注</span>
                <b>{pipe.tuning.note || "—"}</b>
              </div>
              <div className="tuning-row">
                <span>提交时间</span>
                <b>{formatClock(pipe.tuning.time)}</b>
              </div>
            </div>
          ) : (
            <fieldset className="entry-form" disabled={!e.ready}>
              {!e.ready && (
                <p className="lock-note">
                  适应未完成，调音表单只读：需在位，且相隔 ≥30 分钟的两次读数温差 ≤1.5℃。
                </p>
              )}
              <label>
                <span>音高</span>
                <input value={props.pitch} onChange={(ev) => props.onPitch(ev.target.value)} />
              </label>
              <label>
                <span>音分偏差（cent）</span>
                <input
                  type="number"
                  step="1"
                  value={props.cents}
                  placeholder="如 -3"
                  onChange={(ev) => props.onCents(ev.target.value)}
                />
              </label>
              <label className="check-row">
                <input
                  type="checkbox"
                  checked={props.abnormal}
                  onChange={(ev) => props.onAbnormal(ev.target.checked)}
                />
                <span>标记为异常音管（走音、机械问题等，需复检）</span>
              </label>
              <label>
                <span>异常 / 维修备注</span>
                <input
                  value={props.note}
                  placeholder="选填"
                  onChange={(ev) => props.onNote(ev.target.value)}
                />
              </label>
              <button className="primary" onClick={props.onTune}>
                提交调音
              </button>
            </fieldset>
          )}
        </div>
      </div>
    </>
  );
}
