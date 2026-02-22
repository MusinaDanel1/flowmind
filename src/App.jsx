import { useState, useEffect, useRef } from "react";

// ─── Storage Layer ────────────────────────────────────────────────────────────
const storage = {
  getTasks: () => JSON.parse(localStorage.getItem("fm_tasks") || "[]"),
  saveTasks: (tasks) => localStorage.setItem("fm_tasks", JSON.stringify(tasks)),
  getHistory: () => JSON.parse(localStorage.getItem("fm_history") || "[]"),
  saveHistory: (h) => localStorage.setItem("fm_history", JSON.stringify(h)),
  getInsight: () => JSON.parse(localStorage.getItem("fm_insight") || "null"),
  saveInsight: (i) => localStorage.setItem("fm_insight", JSON.stringify(i)),
  getPriorityCache: () => JSON.parse(localStorage.getItem("fm_priority_cache") || "null"),
  savePriorityCache: (data) => localStorage.setItem("fm_priority_cache", JSON.stringify({ data, at: Date.now() })),
  isPriorityCacheValid: () => {
    const c = JSON.parse(localStorage.getItem("fm_priority_cache") || "null");
    if (!c) return false;
    return Date.now() - c.at < 60 * 60 * 1000; // 1 hour
  },
};

// ─── Claude API ───────────────────────────────────────────────────────────────
async function callClaude(prompt, systemPrompt) {
  const apiKey = import.meta.env.VITE_ANTHROPIC_KEY;
  if (!apiKey) {
    console.warn("VITE_ANTHROPIC_KEY не задан — AI функции не работают");
    return "";
  }
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1000,
      system: systemPrompt || "You are a helpful productivity assistant.",
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok) {
    console.error("Claude API error:", res.status);
    return "";
  }
  const data = await res.json();
  return data.content?.[0]?.text || "";
}

async function parseTask(rawText) {
  const today = new Date().toISOString().split("T")[0];
  const system = `You parse a task from free-form text. Return ONLY valid JSON, no markdown, no explanation.`;
  const prompt = `Today is ${today}. Parse this task: "${rawText}"
Return JSON:
{
  "title": "short clear title (max 6 words)",
  "deadline": "ISO date string or null",
  "priority": "high or medium or low",
  "category": "work or study or personal",
  "energy": "high or medium or low",
  "aiHint": "one short insight in Russian (max 10 words)"
}`;
  const text = await callClaude(prompt, system);
  try {
    const clean = text.replace(/```json|```/g, "").trim();
    return JSON.parse(clean);
  } catch {
    return {
      title: rawText.slice(0, 40),
      deadline: null,
      priority: "medium",
      category: "personal",
      energy: "medium",
      aiHint: "Задача добавлена",
    };
  }
}

async function prioritizeTasks(tasks) {
  if (!tasks.length) return tasks;
  const hour = new Date().getHours();
  const timeOfDay = hour < 12 ? "morning" : hour < 17 ? "afternoon" : "evening";
  const system = `You are a productivity AI. Return ONLY valid JSON, no markdown.`;
  const prompt = `It is ${timeOfDay} right now. Prioritize these tasks optimally.
Rules: 
- Morning → high-energy tasks first
- Afternoon → medium-energy tasks
- Evening → low-energy, light tasks
- Overdue or today's deadlines always go first
- High priority before medium before low

Tasks: ${JSON.stringify(tasks.map((t) => ({
    id: t.id,
    title: t.title,
    priority: t.priority,
    energy: t.energy,
    deadline: t.deadline,
    category: t.category,
  })))}

Return JSON:
{
  "order": ["id1", "id2", ...],
  "reasons": { "id1": "short reason in Russian (max 8 words)", ... }
}`;
  const text = await callClaude(prompt, system);
  try {
    const clean = text.replace(/```json|```/g, "").trim();
    const result = JSON.parse(clean);
    const map = Object.fromEntries(tasks.map((t) => [t.id, t]));
    const sorted = result.order.map((id) => map[id]).filter(Boolean);
    // Attach AI reason to each task as priorityReason
    return sorted.map((t) => ({
      ...t,
      priorityReason: result.reasons?.[t.id] || null,
    }));
  } catch {
    return tasks;
  }
}

async function generateInsight(history) {
  if (history.length < 2) return "Продолжай добавлять задачи — скоро появится аналитика.";
  const system = `You are a productivity coach. Write in Russian. Be brief and personal.`;
  const prompt = `Analyze this week's tasks and give a 2-3 sentence insight in Russian.
Completed: ${history.filter((t) => t.status === "done").length}
Total: ${history.length}
Categories: ${JSON.stringify(history.reduce((a, t) => { a[t.category] = (a[t.category] || 0) + 1; return a; }, {}))}
Be specific, warm, actionable. Max 50 words.`;
  return await callClaude(prompt, system);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
const uid = () => Math.random().toString(36).slice(2, 9);

const CATEGORY_COLORS = {
  work: "#f59e0b",
  study: "#6366f1",
  personal: "#10b981",
};

const PRIORITY_LABELS = { high: "Срочно", medium: "Обычное", low: "Потом" };
const ENERGY_LABELS = { high: "Сложная", medium: "Средняя", low: "Лёгкая" };

function formatDeadline(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  const now = new Date();
  const diff = Math.ceil((d - now) / 86400000);
  if (diff < 0) return { label: "Просрочено", warn: true };
  if (diff === 0) return { label: "Сегодня", warn: true };
  if (diff === 1) return { label: "Завтра", warn: true };
  return { label: `${diff} дн.`, warn: false };
}

// ─── Components ───────────────────────────────────────────────────────────────

function Loader({ text = "ИИ анализирует..." }) {
  const [dots, setDots] = useState("");
  useEffect(() => {
    const i = setInterval(() => setDots((d) => (d.length >= 3 ? "" : d + ".")), 400);
    return () => clearInterval(i);
  }, []);
  return (
    <div className="flex items-center gap-2 text-amber-400 text-sm font-mono">
      <svg className="animate-spin w-4 h-4" fill="none" viewBox="0 0 24 24">
        <circle className="opacity-20" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
        <path className="opacity-90" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
      </svg>
      {text}{dots}
    </div>
  );
}


function Toast({ message, onDone }) {
  useEffect(() => {
    const t = setTimeout(onDone, 2200);
    return () => clearTimeout(t);
  }, []);
  return (
    <div
      className="fixed bottom-20 left-1/2 -translate-x-1/2 z-50 flex items-center gap-2 px-4 py-2.5 rounded-full bg-zinc-800 border border-zinc-700 shadow-xl"
      style={{ animation: "toastIn 0.3s ease" }}
    >
      <span className="text-emerald-400 text-sm">✓</span>
      <span className="text-sm text-zinc-200 whitespace-nowrap">{message}</span>
    </div>
  );
}

function TaskCard({ task, onDone, onDelete, onEdit, animate, completing }) {
  const dl = formatDeadline(task.deadline);
  const catColor = CATEGORY_COLORS[task.category] || "#6b7280";
  return (
    <div
      onClick={() => onEdit && onEdit(task)}
      className={`group relative rounded-xl p-4 mb-3 border transition-all duration-500 cursor-pointer ${
        animate ? "opacity-0 translate-y-2" : "opacity-100 translate-y-0"
      } ${completing?.has(task.id) ? "task-completing pointer-events-none" : ""} ${
        task.priority === "high"
          ? "bg-zinc-800/80 border-amber-500/30"
          : "bg-zinc-800/50 border-zinc-700/50"
      } hover:border-zinc-500/70`}
      style={{ transition: "border-color 0.2s" }}
    >
      {/* left accent bar */}
      <div
        className="absolute left-0 top-3 bottom-3 w-0.5 rounded-full"
        style={{ backgroundColor: catColor }}
      />

      <div className="flex items-start gap-3 pl-3">
        {/* Done button */}
        <button
          onClick={(e) => { e.stopPropagation(); onDone(task.id); }}
          className="mt-0.5 w-5 h-5 rounded-full border-2 border-zinc-600 hover:border-amber-400 flex-shrink-0 transition-colors duration-200 hover:bg-amber-400/10"
        />

        <div className="flex-1 min-w-0">
          <p className="text-zinc-100 text-sm font-medium leading-snug">{task.title}</p>

          <div className="flex flex-wrap gap-2 mt-2">
            {dl && (
              <span
                className={`text-xs px-2 py-0.5 rounded-full font-mono ${
                  dl.warn ? "bg-red-500/15 text-red-400" : "bg-zinc-700 text-zinc-400"
                }`}
              >
                {dl.label}
              </span>
            )}
            <span
              className="text-xs px-2 py-0.5 rounded-full"
              style={{ background: catColor + "20", color: catColor }}
            >
              {task.category}
            </span>
            <span className="text-xs px-2 py-0.5 rounded-full bg-zinc-700 text-zinc-400">
              {ENERGY_LABELS[task.energy]}
            </span>
          </div>

          <p className="mt-1.5 text-xs text-zinc-700 opacity-0 group-hover:opacity-100 transition-opacity">нажми чтобы редактировать</p>
          {(task.priorityReason || task.aiHint) && (
            <p className="mt-2 text-xs text-zinc-500 italic">
              ✦ {task.priorityReason || task.aiHint}
            </p>
          )}
        </div>

        <button
          onClick={(e) => { e.stopPropagation(); onDelete(task.id); }}
          className="opacity-0 group-hover:opacity-100 text-zinc-600 hover:text-zinc-400 transition-all text-lg leading-none mt-0.5"
        >
          ×
        </button>
      </div>
    </div>
  );
}


function EditTaskModal({ task, onClose, onSave, onDelete }) {
  const [form, setForm] = useState({ ...task });

  function set(key, val) { setForm((f) => ({ ...f, [key]: val })); }

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div className="bg-zinc-900 border border-zinc-700 rounded-2xl w-full max-w-md shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="p-6 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-zinc-100 font-semibold text-lg">Редактировать задачу</h2>
            <button onClick={onClose} className="text-zinc-600 hover:text-zinc-400 text-xl leading-none">×</button>
          </div>

          {/* Title */}
          <div>
            <label className="text-xs text-zinc-500 mb-1 block">Название</label>
            <input
              value={form.title}
              onChange={(e) => set("title", e.target.value)}
              className="w-full bg-zinc-800 border border-zinc-700 rounded-xl px-3 py-2 text-sm text-zinc-200 focus:outline-none focus:border-amber-500/50"
            />
          </div>

          {/* Deadline */}
          <div>
            <label className="text-xs text-zinc-500 mb-1 block">Дедлайн</label>
            <input
              type="date"
              value={form.deadline || ""}
              onChange={(e) => set("deadline", e.target.value || null)}
              className="w-full bg-zinc-800 border border-zinc-700 rounded-xl px-3 py-2 text-sm text-zinc-200 focus:outline-none focus:border-amber-500/50"
            />
          </div>

          {/* Row: priority / category / energy */}
          <div className="grid grid-cols-3 gap-3">
            {[
              { key: "priority", label: "Приоритет", options: ["high","medium","low"], labels: PRIORITY_LABELS },
              { key: "category", label: "Категория", options: ["work","study","personal"], labels: { work:"Работа", study:"Учёба", personal:"Личное" } },
              { key: "energy",   label: "Энергия",   options: ["high","medium","low"], labels: ENERGY_LABELS },
            ].map(({ key, label, options, labels }) => (
              <div key={key}>
                <label className="text-xs text-zinc-500 mb-1 block">{label}</label>
                <select
                  value={form[key]}
                  onChange={(e) => set(key, e.target.value)}
                  className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-2 py-2 text-xs text-zinc-200 focus:outline-none"
                >
                  {options.map((o) => <option key={o} value={o}>{labels[o]}</option>)}
                </select>
              </div>
            ))}
          </div>

          {/* Note */}
          <div>
            <label className="text-xs text-zinc-500 mb-1 block">Заметка</label>
            <textarea
              value={form.note || ""}
              onChange={(e) => set("note", e.target.value)}
              placeholder="Добавь детали..."
              rows={2}
              className="w-full bg-zinc-800 border border-zinc-700 rounded-xl px-3 py-2 text-sm text-zinc-200 placeholder-zinc-600 resize-none focus:outline-none focus:border-amber-500/50"
            />
          </div>
        </div>

        <div className="flex gap-2 px-6 pb-6">
          <button
            onClick={() => { onDelete(task.id); onClose(); }}
            className="px-4 py-2 rounded-xl border border-red-500/30 text-red-400 text-sm hover:bg-red-500/10 transition-colors"
          >
            Удалить
          </button>
          <div className="flex-1" />
          <button onClick={onClose} className="px-4 py-2 rounded-xl border border-zinc-700 text-zinc-400 text-sm hover:bg-zinc-800 transition-colors">
            Отмена
          </button>
          <button
            onClick={() => { onSave(form); onClose(); }}
            className="px-5 py-2 rounded-xl bg-amber-500 text-zinc-900 text-sm font-semibold hover:bg-amber-400 transition-colors"
          >
            Сохранить
          </button>
        </div>
      </div>
    </div>
  );
}

function AddTaskModal({ onClose, onAdd }) {
  const [raw, setRaw] = useState("");
  const [parsed, setParsed] = useState(null);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef();

  useEffect(() => { inputRef.current?.focus(); }, []);

  async function handleParse() {
    if (!raw.trim()) return;
    setLoading(true);
    const result = await parseTask(raw);
    setParsed(result);
    setLoading(false);
  }

  function handleConfirm() {
    const task = {
      id: uid(),
      ...parsed,
      status: "active",
      createdAt: new Date().toISOString(),
    };
    onAdd(task);
    onClose();
  }

  return (
    <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <div className="bg-zinc-900 border border-zinc-700 rounded-2xl w-full max-w-md shadow-2xl">
        <div className="p-6">
          <h2 className="text-zinc-100 font-semibold text-lg mb-1">Новая задача</h2>
          <p className="text-zinc-500 text-sm mb-4">Опишите задачу как угодно — ИИ разберётся</p>

          <textarea
            ref={inputRef}
            value={raw}
            onChange={(e) => { setRaw(e.target.value); setParsed(null); }}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleParse(); } }}
            placeholder='Например: "Сдать отчёт Серику до пятницы, срочно"'
            className="w-full bg-zinc-800 border border-zinc-700 rounded-xl p-3 text-sm text-zinc-200 placeholder-zinc-600 resize-none focus:outline-none focus:border-amber-500/50 transition-colors"
            rows={3}
          />

          {loading && <div className="mt-3"><Loader /></div>}

          {parsed && !loading && (
            <div className="mt-4 bg-zinc-800/60 border border-zinc-700 rounded-xl p-4 space-y-3">
              <p className="text-xs text-amber-400 font-mono uppercase tracking-wider">ИИ распознал</p>

              <div>
                <label className="text-xs text-zinc-500">Название</label>
                <input
                  value={parsed.title}
                  onChange={(e) => setParsed({ ...parsed, title: e.target.value })}
                  className="mt-1 w-full bg-zinc-700/50 border border-zinc-600 rounded-lg px-3 py-1.5 text-sm text-zinc-200 focus:outline-none focus:border-amber-500/50"
                />
              </div>

              <div className="grid grid-cols-3 gap-2">
                {[
                  { key: "priority", label: "Приоритет", options: ["high", "medium", "low"], labels: PRIORITY_LABELS },
                  { key: "category", label: "Категория", options: ["work", "study", "personal"], labels: { work: "Работа", study: "Учёба", personal: "Личное" } },
                  { key: "energy", label: "Энергия", options: ["high", "medium", "low"], labels: ENERGY_LABELS },
                ].map(({ key, label, options, labels }) => (
                  <div key={key}>
                    <label className="text-xs text-zinc-500">{label}</label>
                    <select
                      value={parsed[key]}
                      onChange={(e) => setParsed({ ...parsed, [key]: e.target.value })}
                      className="mt-1 w-full bg-zinc-700/50 border border-zinc-600 rounded-lg px-2 py-1.5 text-xs text-zinc-200 focus:outline-none"
                    >
                      {options.map((o) => <option key={o} value={o}>{labels[o]}</option>)}
                    </select>
                  </div>
                ))}
              </div>

              <div>
                <label className="text-xs text-zinc-500">Дедлайн</label>
                <input
                  type="date"
                  value={parsed.deadline || ""}
                  onChange={(e) => setParsed({ ...parsed, deadline: e.target.value || null })}
                  className="mt-1 w-full bg-zinc-700/50 border border-zinc-600 rounded-lg px-3 py-1.5 text-sm text-zinc-200 focus:outline-none focus:border-amber-500/50"
                />
              </div>

              {parsed.aiHint && (
                <p className="text-xs text-zinc-500 italic">✦ {parsed.aiHint}</p>
              )}
            </div>
          )}
        </div>

        <div className="flex gap-2 p-6 pt-0">
          <button
            onClick={onClose}
            className="flex-1 py-2.5 rounded-xl border border-zinc-700 text-zinc-400 text-sm hover:bg-zinc-800 transition-colors"
          >
            Отмена
          </button>
          {!parsed ? (
            <button
              onClick={handleParse}
              disabled={!raw.trim() || loading}
              className="flex-1 py-2.5 rounded-xl bg-amber-500 text-zinc-900 text-sm font-semibold hover:bg-amber-400 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              Разобрать →
            </button>
          ) : (
            <button
              onClick={handleConfirm}
              className="flex-1 py-2.5 rounded-xl bg-amber-500 text-zinc-900 text-sm font-semibold hover:bg-amber-400 transition-colors"
            >
              Добавить ✓
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// Simple bar chart without recharts dependency issues
function MiniBarChart({ data, color = "#f59e0b" }) {
  const max = Math.max(...data.map((d) => d.value), 1);
  return (
    <div className="flex items-end gap-1.5 h-20">
      {data.map((d, i) => (
        <div key={i} className="flex-1 flex flex-col items-center gap-1">
          <div
            className="w-full rounded-t-sm transition-all duration-700"
            style={{
              height: `${(d.value / max) * 64}px`,
              backgroundColor: color,
              opacity: d.value === 0 ? 0.15 : 0.8,
              minHeight: 2,
            }}
          />
          <span className="text-xs text-zinc-600">{d.label}</span>
        </div>
      ))}
    </div>
  );
}

function DonutChart({ segments }) {
  const total = segments.reduce((s, d) => s + d.value, 0) || 1;
  let offset = 0;
  const r = 40;
  const cx = 50;
  const cy = 50;
  const circ = 2 * Math.PI * r;

  return (
    <svg viewBox="0 0 100 100" className="w-28 h-28">
      {segments.map((seg, i) => {
        const pct = seg.value / total;
        const dash = pct * circ;
        const gap = circ - dash;
        const el = (
          <circle
            key={i}
            cx={cx}
            cy={cy}
            r={r}
            fill="none"
            stroke={seg.color}
            strokeWidth="16"
            strokeDasharray={`${dash} ${gap}`}
            strokeDashoffset={-offset * circ}
            transform="rotate(-90 50 50)"
            opacity={0.85}
          />
        );
        offset += pct;
        return el;
      })}
      <circle cx={cx} cy={cy} r={r - 8} fill="#18181b" />
      <text x="50" y="54" textAnchor="middle" fill="#f4f4f5" fontSize="12" fontWeight="600">
        {total}
      </text>
    </svg>
  );
}

// ─── Views ────────────────────────────────────────────────────────────────────

function TodayView({ tasks, onDone, onDelete, onEdit, onAdd, prioritizing, lastPrioritized, onReprioritize, completing }) {
  const [newIds, setNewIds] = useState(new Set());

  const active = tasks.filter((t) => t.status === "active");
  const now = active.slice(0, 2);
  const today = active.slice(2, 5);
  const later = active.slice(5);

  function handleAdd(task) {
    setNewIds((s) => new Set([...s, task.id]));
    onAdd(task);
    setTimeout(() => setNewIds((s) => { const n = new Set(s); n.delete(task.id); return n; }), 50);
  }

  const Section = ({ title, emoji, items, dim }) => (
    <div className={dim ? "opacity-60" : ""}>
      <div className="flex items-center gap-2 mb-3">
        <span className="text-base">{emoji}</span>
        <span className="text-xs font-mono text-zinc-500 uppercase tracking-widest">{title}</span>
        <div className="flex-1 h-px bg-zinc-800" />
        <span className="text-xs text-zinc-600">{items.length}</span>
      </div>
      {items.length === 0 ? (
        <p className="text-zinc-700 text-sm text-center py-4">Пусто</p>
      ) : (
        items.map((t) => (
          <TaskCard
            key={t.id}
            task={t}
            onDone={onDone}
            onDelete={onDelete}
            onEdit={onEdit}
            animate={newIds.has(t.id)}
            completing={completing}
          />
        ))
      )}
    </div>
  );

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-zinc-100">Сегодня</h1>
          <p className="text-zinc-500 text-sm mt-0.5">
            {new Date().toLocaleDateString("ru-RU", { weekday: "long", day: "numeric", month: "long" })}
          </p>
        </div>

      </div>

      {/* AI Priority Status Banner */}
      <div className="flex items-center justify-between px-3 py-2 rounded-lg bg-zinc-800/40 border border-zinc-700/40">
        {prioritizing ? (
          <Loader text="ИИ расставляет приоритеты" />
        ) : (
          <div className="flex items-center gap-2">
            <span className="text-amber-400 text-xs">✦</span>
            <span className="text-xs text-zinc-500">
              {lastPrioritized
                ? `Приоритизировано в ${new Date(lastPrioritized).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}`
                : "Ещё не приоритизировано"}
            </span>
          </div>
        )}
        <button
          onClick={onReprioritize}
          disabled={prioritizing}
          className="text-xs text-zinc-600 hover:text-amber-400 transition-colors disabled:opacity-30 font-mono"
        >
          ↺ обновить
        </button>
      </div>

      {active.length === 0 ? (
        <div className="text-center py-16 space-y-3">
          <p className="text-5xl">✦</p>
          <p className="text-zinc-300 font-medium">Все задачи выполнены!</p>
          <p className="text-zinc-600 text-sm">Добавь новые или отдохни — ты заслужил</p>
        </div>
      ) : (
        <>
          <Section title="Сейчас" emoji="⚡" items={now} />
      <Section title="На сегодня" emoji="○" items={today} />
          <Section title="Потом" emoji="◦" items={later} dim />
        </>
      )}
    </div>
  );
}

function AllTasksView({ tasks, onDone, onDelete, onEdit, onAdd, completing }) {
  const [filter, setFilter] = useState("active");
  const filtered = tasks.filter((t) => filter === "all" ? true : t.status === filter);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-zinc-100">Все задачи</h1>

      </div>

      <div className="flex gap-1 bg-zinc-800/60 rounded-xl p-1">
        {[["active", "Активные"], ["done", "Готово"], ["all", "Все"]].map(([v, l]) => (
          <button
            key={v}
            onClick={() => setFilter(v)}
            className={`flex-1 py-1.5 rounded-lg text-sm transition-all ${
              filter === v
                ? "bg-zinc-700 text-zinc-100 font-medium"
                : "text-zinc-500 hover:text-zinc-400"
            }`}
          >
            {l}
          </button>
        ))}
      </div>

      {filtered.length === 0 ? (
        <div className="text-center py-16">
          <p className="text-zinc-600 text-4xl mb-3">✦</p>
          <p className="text-zinc-500 text-sm">Здесь пока пусто</p>
        </div>
      ) : (
        filtered.map((t) => (
          <TaskCard key={t.id} task={t} onDone={onDone} onDelete={onDelete} onEdit={onEdit} completing={completing} />
        ))
      )}
    </div>
  );
}

function AnalyticsView({ tasks }) {
  const [insight, setInsight] = useState(storage.getInsight());
  const [loadingInsight, setLoadingInsight] = useState(false);

  const all = tasks;
  const done = all.filter((t) => t.status === "done");
  const active = all.filter((t) => t.status === "active");
  const overdue = active.filter((t) => {
    if (!t.deadline) return false;
    return new Date(t.deadline) < new Date();
  });

  // Flow Score — ratio of done to total, penalized by overdue
  const flowScore = all.length
    ? Math.max(0, Math.round((done.length / all.length) * 100) - overdue.length * 5)
    : 0;

  const flowLabel =
    flowScore >= 80 ? "Отличный поток" :
    flowScore >= 50 ? "Хороший ритм" :
    flowScore >= 20 ? "Есть куда расти" : "Начни с малого";

  // By category — done vs active
  const byCat = ["work", "study", "personal"].map((cat) => {
    const catTasks = all.filter((t) => t.category === cat);
    const catDone = catTasks.filter((t) => t.status === "done").length;
    return {
      label: { work: "Работа", study: "Учёба", personal: "Личное" }[cat],
      value: catTasks.length,
      done: catDone,
      color: CATEGORY_COLORS[cat],
      pct: catTasks.length ? Math.round((catDone / catTasks.length) * 100) : 0,
    };
  });

  // By day (last 7 days) — both created and done
  const days = Array.from({ length: 7 }, (_, i) => {
    const d = new Date();
    d.setDate(d.getDate() - (6 - i));
    const iso = d.toISOString().split("T")[0];
    const label = d.toLocaleDateString("ru-RU", { weekday: "short" });
    const created = all.filter((t) => t.createdAt?.startsWith(iso)).length;
    const completed = done.filter((t) => t.doneAt?.startsWith(iso)).length;
    return { label, created, completed };
  });

  // Priority breakdown
  const byPriority = ["high", "medium", "low"].map((p) => ({
    label: PRIORITY_LABELS[p],
    total: all.filter((t) => t.priority === p).length,
    done: done.filter((t) => t.priority === p).length,
    color: p === "high" ? "#f59e0b" : p === "medium" ? "#6366f1" : "#10b981",
  }));

  async function loadInsight() {
    setLoadingInsight(true);
    const system = `You are a productivity coach. Write in Russian. Be brief, warm, specific. Max 60 words total.`;
    const prompt = `Analyze productivity data and write 3 short insights in Russian.
Stats:
- Total tasks: ${all.length}, Done: ${done.length}, Active: ${active.length}, Overdue: ${overdue.length}
- Flow Score: ${flowScore}%
- By category: ${byCat.map(c => `${c.label}: ${c.done}/${c.value}`).join(", ")}
- By priority done rate: ${byPriority.map(p => `${p.label}: ${p.done}/${p.total}`).join(", ")}
- Most productive day this week: ${days.reduce((a, b) => b.completed > a.completed ? b : a, days[0]).label}

Format: 3 bullet points starting with emoji, each max 20 words. Be specific about the data.`;
    const text = await callClaude(prompt, system);
    const obj = { text, at: Date.now() };
    storage.saveInsight(obj);
    setInsight(obj);
    setLoadingInsight(false);
  }

  // Parse insight into bullet points if formatted
  const insightLines = insight?.text
    ? insight.text.split("\n").filter((l) => l.trim())
    : [];

  return (
    <div className="space-y-5 pb-4">
      <h1 className="text-2xl font-bold text-zinc-100">Аналитика</h1>

      {/* Flow Score — hero metric */}
      <div className="relative bg-zinc-800/60 rounded-2xl p-5 border border-zinc-700/50 overflow-hidden">
        <div
          className="absolute inset-0 opacity-5"
          style={{ background: `radial-gradient(circle at 80% 50%, ${flowScore >= 50 ? "#10b981" : "#f59e0b"}, transparent 60%)` }}
        />
        <div className="flex items-center justify-between">
          <div>
            <p className="text-xs font-mono text-zinc-500 uppercase tracking-widest mb-1">Flow Score</p>
            <p className="text-5xl font-bold text-zinc-100">{flowScore}<span className="text-2xl text-zinc-500">%</span></p>
            <p className="text-sm mt-1" style={{ color: flowScore >= 50 ? "#10b981" : "#f59e0b" }}>{flowLabel}</p>
          </div>
          <div className="text-right space-y-2">
            {[
              { label: "Выполнено", value: done.length, color: "text-emerald-400" },
              { label: "Активных", value: active.length, color: "text-zinc-300" },
              { label: "Просрочено", value: overdue.length, color: overdue.length > 0 ? "text-red-400" : "text-zinc-600" },
            ].map(({ label, value, color }) => (
              <div key={label}>
                <span className={`text-lg font-bold ${color}`}>{value}</span>
                <span className="text-xs text-zinc-600 ml-1.5">{label}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Progress bar */}
        <div className="mt-4 h-1.5 bg-zinc-700 rounded-full overflow-hidden">
          <div
            className="h-full rounded-full transition-all duration-1000"
            style={{
              width: `${flowScore}%`,
              background: flowScore >= 50 ? "#10b981" : "#f59e0b",
            }}
          />
        </div>
      </div>

      {/* Week activity chart */}
      <div className="bg-zinc-800/60 rounded-xl p-5 border border-zinc-700/50">
        <div className="flex items-center justify-between mb-4">
          <p className="text-xs font-mono text-zinc-500 uppercase tracking-widest">Активность за неделю</p>
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-1.5">
              <div className="w-2 h-2 rounded-full bg-amber-500" />
              <span className="text-xs text-zinc-600">создано</span>
            </div>
            <div className="flex items-center gap-1.5">
              <div className="w-2 h-2 rounded-full bg-emerald-500" />
              <span className="text-xs text-zinc-600">выполнено</span>
            </div>
          </div>
        </div>
        <div className="flex items-end gap-1.5 h-24">
          {days.map((d, i) => {
            const maxVal = Math.max(...days.map((x) => Math.max(x.created, x.completed)), 1);
            const isToday = i === 6;
            return (
              <div key={i} className="flex-1 flex flex-col items-center gap-1">
                <div className="w-full flex gap-0.5 items-end" style={{ height: 72 }}>
                  <div
                    className="flex-1 rounded-t-sm transition-all duration-700"
                    style={{
                      height: `${(d.created / maxVal) * 72}px`,
                      background: "#f59e0b",
                      opacity: isToday ? 1 : 0.5,
                      minHeight: d.created > 0 ? 3 : 0,
                    }}
                  />
                  <div
                    className="flex-1 rounded-t-sm transition-all duration-700"
                    style={{
                      height: `${(d.completed / maxVal) * 72}px`,
                      background: "#10b981",
                      opacity: isToday ? 1 : 0.5,
                      minHeight: d.completed > 0 ? 3 : 0,
                    }}
                  />
                </div>
                <span className={`text-xs ${isToday ? "text-amber-400" : "text-zinc-600"}`}>{d.label}</span>
              </div>
            );
          })}
        </div>
      </div>

      {/* Category breakdown */}
      <div className="bg-zinc-800/60 rounded-xl p-5 border border-zinc-700/50">
        <p className="text-xs font-mono text-zinc-500 uppercase tracking-widest mb-4">По категориям</p>
        <div className="space-y-3">
          {byCat.map(({ label, value, done: d, color, pct }) => (
            <div key={label}>
              <div className="flex items-center justify-between mb-1.5">
                <div className="flex items-center gap-2">
                  <div className="w-2 h-2 rounded-full" style={{ backgroundColor: color }} />
                  <span className="text-sm text-zinc-300">{label}</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-zinc-500">{d}/{value}</span>
                  <span className="text-xs font-mono" style={{ color }}>{pct}%</span>
                </div>
              </div>
              <div className="h-1.5 bg-zinc-700 rounded-full overflow-hidden">
                <div
                  className="h-full rounded-full transition-all duration-700"
                  style={{ width: `${pct}%`, backgroundColor: color }}
                />
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Priority breakdown */}
      <div className="bg-zinc-800/60 rounded-xl p-5 border border-zinc-700/50">
        <p className="text-xs font-mono text-zinc-500 uppercase tracking-widest mb-4">По приоритету</p>
        <div className="flex gap-3">
          {byPriority.map(({ label, total, done: d, color }) => (
            <div key={label} className="flex-1 text-center">
              <div
                className="text-2xl font-bold"
                style={{ color: total > 0 ? color : "#3f3f46" }}
              >
                {d}/{total}
              </div>
              <div className="text-xs text-zinc-500 mt-1">{label}</div>
              <div className="mt-2 h-1 bg-zinc-700 rounded-full overflow-hidden">
                <div
                  className="h-full rounded-full"
                  style={{
                    width: total > 0 ? `${Math.round((d / total) * 100)}%` : "0%",
                    backgroundColor: color,
                  }}
                />
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* AI Insight */}
      <div className="bg-zinc-800/60 rounded-xl p-5 border border-amber-500/20">
        <div className="flex items-center justify-between mb-3">
          <p className="text-xs font-mono text-amber-400 uppercase tracking-widest">ИИ-анализ</p>
          <button
            onClick={loadInsight}
            disabled={loadingInsight}
            className="text-xs text-zinc-500 hover:text-amber-400 transition-colors disabled:opacity-40"
          >
            {loadingInsight ? "..." : insight ? "↺ обновить" : "получить анализ →"}
          </button>
        </div>
        {loadingInsight ? (
          <Loader text="ИИ анализирует продуктивность" />
        ) : insightLines.length > 0 ? (
          <div className="space-y-2.5">
            {insightLines.map((line, i) => (
              <p key={i} className="text-sm text-zinc-300 leading-relaxed">{line}</p>
            ))}
            <p className="text-xs text-zinc-600 mt-3">
              Обновлено {new Date(insight.at).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}
            </p>
          </div>
        ) : (
          <button
            onClick={loadInsight}
            className="w-full text-center py-4 text-sm text-zinc-600 hover:text-amber-400 transition-colors border border-dashed border-zinc-700 rounded-lg"
          >
            ✦ Нажми чтобы получить персональный анализ
          </button>
        )}
      </div>
    </div>
  );
}

// ─── App ──────────────────────────────────────────────────────────────────────
export default function FlowMind() {
  const [tasks, setTasks] = useState(() => storage.getTasks());
  const [view, setView] = useState("today");
  const [showModal, setShowModal] = useState(false);
  const [prioritizing, setPrioritizing] = useState(false);
  const [toast, setToast] = useState(null);
  const [completing, setCompleting] = useState(new Set());
  const [editingTask, setEditingTask] = useState(null);
  const [lastPrioritized, setLastPrioritized] = useState(() => {
    const c = storage.getPriorityCache();
    return c?.at || null;
  });

  // Run prioritization
  async function runPrioritize(currentTasks, force = false) {
    const active = currentTasks.filter((t) => t.status === "active");
    if (active.length < 2) return currentTasks;

    // Use cache if valid and not forced
    if (!force && storage.isPriorityCacheValid()) {
      const cached = storage.getPriorityCache();
      if (cached?.data) {
        // Apply cached order to current tasks
        const map = Object.fromEntries(currentTasks.map((t) => [t.id, t]));
        const reordered = cached.data
          .map((t) => map[t.id] ? { ...map[t.id], priorityReason: t.priorityReason } : null)
          .filter(Boolean);
        // Add any tasks not in cache
        const cachedIds = new Set(cached.data.map((t) => t.id));
        const remaining = currentTasks.filter((t) => !cachedIds.has(t.id));
        return [...reordered, ...remaining];
      }
    }

    setPrioritizing(true);
    try {
      const sorted = await prioritizeTasks(active);
      const doneTasks = currentTasks.filter((t) => t.status !== "active");
      const merged = [...sorted, ...doneTasks];

      // Save cache
      storage.savePriorityCache(sorted.map((t) => ({ id: t.id, priorityReason: t.priorityReason })));
      setLastPrioritized(Date.now());

      return merged;
    } catch {
      return currentTasks;
    } finally {
      setPrioritizing(false);
    }
  }

  // On mount: load tasks and prioritize
  useEffect(() => {
    let initialTasks = storage.getTasks();

    if (initialTasks.length === 0) {
      initialTasks = [
        { id: uid(), title: "Подготовить презентацию", deadline: new Date(Date.now() + 86400000).toISOString().split("T")[0], priority: "high", category: "work", energy: "high", aiHint: "Начни утром, пока мозг свежий", status: "active", createdAt: new Date().toISOString() },
        { id: uid(), title: "Написать отчёт по хакатону", deadline: new Date(Date.now() + 172800000).toISOString().split("T")[0], priority: "high", category: "study", energy: "high", aiHint: "Такие задачи занимают 2–3 часа", status: "active", createdAt: new Date().toISOString() },
        { id: uid(), title: "Код-ревью pull request", deadline: null, priority: "medium", category: "work", energy: "medium", aiHint: "Хорошо идёт после обеда", status: "active", createdAt: new Date().toISOString() },
        { id: uid(), title: "Купить продукты", deadline: null, priority: "low", category: "personal", energy: "low", aiHint: "Займёт 30 мин", status: "active", createdAt: new Date().toISOString() },
        { id: uid(), title: "Прочитать статью по ML", deadline: null, priority: "low", category: "study", energy: "medium", aiHint: null, status: "done", createdAt: new Date(Date.now() - 86400000).toISOString() },
      ];
      storage.saveTasks(initialTasks);
      setTasks(initialTasks);
    }

    runPrioritize(initialTasks).then((sorted) => {
      setTasks(sorted);
      storage.saveTasks(sorted);
    });
  }, []);

  function handleDone(id) {
    const task = tasks.find((t) => t.id === id);
    setCompleting((s) => new Set([...s, id]));
    setTimeout(() => {
      setCompleting((s) => { const n = new Set(s); n.delete(id); return n; });
      const updated = tasks.map((t) => t.id === id ? { ...t, status: "done", doneAt: new Date().toISOString() } : t);
      setTasks(updated);
      storage.saveTasks(updated);
      setToast(task?.title ? `"${task.title.slice(0, 28)}"` : "Задача выполнена");
    }, 420);
  }

  function handleDelete(id) {
    const updated = tasks.filter((t) => t.id !== id);
    setTasks(updated);
    storage.saveTasks(updated);
  }

  function handleEdit(task) { setEditingTask(task); }

  function handleSave(updated) {
    const newTasks = tasks.map((t) => t.id === updated.id ? { ...updated } : t);
    setTasks(newTasks);
    storage.saveTasks(newTasks);
  }

  async function handleAdd(task) {
    if (!task) { setShowModal(true); return; }
    const updated = [task, ...tasks];
    // Reprioritize after adding (force = true, skip cache)
    const sorted = await runPrioritize(updated, true);
    setTasks(sorted);
    storage.saveTasks(sorted);
  }

  async function handleReprioritize() {
    const sorted = await runPrioritize(tasks, true);
    setTasks(sorted);
    storage.saveTasks(sorted);
  }

  const navItems = [
    { id: "today", label: "Сегодня", icon: "◈" },
    { id: "all", label: "Задачи", icon: "≡" },
    { id: "analytics", label: "Аналитика", icon: "◎" },
  ];

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 flex" style={{ fontFamily: "'DM Sans', system-ui, sans-serif" }}>
      {/* Global styles */}
      <style>{`
        @keyframes toastIn {
          from { opacity: 0; transform: translate(-50%, 12px) scale(0.95); }
          to   { opacity: 1; transform: translate(-50%, 0)    scale(1);    }
        }
        @keyframes fadeSlideIn {
          from { opacity: 0; transform: translateY(6px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        @keyframes completePop {
          0%   { transform: scale(1); }
          40%  { transform: scale(1.04); }
          100% { transform: scale(1) translateX(8px); opacity: 0; }
        }
        .task-completing { animation: completePop 0.45s ease forwards; }
        .view-enter { animation: fadeSlideIn 0.2s ease both; }
        * { scrollbar-width: thin; scrollbar-color: #3f3f46 transparent; }
      `}</style>

      {/* Ambient glow */}
      <div className="fixed inset-0 pointer-events-none" style={{
        background: "radial-gradient(ellipse 50% 60% at 20% 0%, rgba(245,158,11,0.05) 0%, transparent 60%)",
      }} />

      {/* ── Sidebar ── */}
      <aside className="fixed left-0 top-0 h-full w-56 border-r border-zinc-800/60 bg-zinc-950/95 backdrop-blur-md flex flex-col z-30">
        {/* Logo */}
        <div className="flex items-center gap-2.5 px-6 py-5 border-b border-zinc-800/60">
          <span className="text-amber-400 text-xl">✦</span>
          <span className="font-bold text-zinc-100 tracking-tight text-lg">FlowMind</span>
        </div>

        {/* Nav items */}
        <nav className="flex-1 px-3 py-4 space-y-1">
          {navItems.map(({ id, label, icon }) => (
            <button
              key={id}
              onClick={() => setView(id)}
              className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm transition-all text-left ${
                view === id
                  ? "bg-amber-500/10 text-amber-400 font-medium"
                  : "text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800/60"
              }`}
            >
              <span className="text-base w-5 text-center">{icon}</span>
              {label}
            </button>
          ))}
        </nav>

        {/* Bottom stats */}
        <div className="px-5 py-5 border-t border-zinc-800/60 space-y-2">
          <div className="flex justify-between text-xs">
            <span className="text-zinc-600">Активных</span>
            <span className="text-zinc-400 font-mono">{tasks.filter((t) => t.status === "active").length}</span>
          </div>
          <div className="flex justify-between text-xs">
            <span className="text-zinc-600">Выполнено</span>
            <span className="text-emerald-500 font-mono">{tasks.filter((t) => t.status === "done").length}</span>
          </div>
        </div>

        {/* Add button */}
        <div className="px-3 pb-5">
          <button
            onClick={() => setShowModal(true)}
            className="w-full py-2.5 rounded-xl bg-amber-500 text-zinc-900 text-sm font-semibold hover:bg-amber-400 transition-colors flex items-center justify-center gap-2"
          >
            <span className="text-lg leading-none">+</span> Новая задача
          </button>
        </div>
      </aside>

      {/* ── Main content ── */}
      <main className="flex-1 ml-56 min-h-screen overflow-y-auto">
        <div key={view} className="view-enter max-w-3xl mx-auto px-10 py-8">
          {view === "today" && (
            <TodayView
              tasks={tasks}
              onDone={handleDone}
              onDelete={handleDelete}
              onEdit={handleEdit}
              onAdd={handleAdd}
              prioritizing={prioritizing}
              lastPrioritized={lastPrioritized}
              onReprioritize={handleReprioritize}
              completing={completing}
            />
          )}
          {view === "all" && (
            <AllTasksView
              tasks={tasks}
              onDone={handleDone}
              onDelete={handleDelete}
              onEdit={handleEdit}
              onAdd={handleAdd}
              completing={completing}
            />
          )}
          {view === "analytics" && <AnalyticsView tasks={tasks} />}
        </div>
      </main>

      {/* Toast */}
      {toast && <Toast message={toast} onDone={() => setToast(null)} />}

      {/* Add Modal */}
      {showModal && (
        <AddTaskModal
          onClose={() => setShowModal(false)}
          onAdd={(task) => { handleAdd(task); setShowModal(false); }}
        />
      )}

      {/* Edit Modal */}
      {editingTask && (
        <EditTaskModal
          task={editingTask}
          onClose={() => setEditingTask(null)}
          onSave={handleSave}
          onDelete={handleDelete}
        />
      )}
    </div>
  );
}
