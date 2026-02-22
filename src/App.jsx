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


// ─── Smart Reminder Engine ────────────────────────────────────────────────────

const reminderStorage = {
  getScheduled: () => JSON.parse(localStorage.getItem("fm_reminders") || "[]"),
  save: (r) => localStorage.setItem("fm_reminders", JSON.stringify(r)),
  clear: () => localStorage.removeItem("fm_reminders"),
};

async function requestNotificationPermission() {
  if (!("Notification" in window)) return false;
  if (Notification.permission === "granted") return true;
  if (Notification.permission === "denied") return false;
  const result = await Notification.requestPermission();
  return result === "granted";
}

function sendNotification(title, body, icon = "✦") {
  if (Notification.permission !== "granted") return;
  const n = new Notification(`${icon} ${title}`, {
    body,
    icon: "/favicon.svg",
    badge: "/favicon.svg",
    tag: title, // prevent duplicates
  });
  n.onclick = () => { window.focus(); n.close(); };
  setTimeout(() => n.close(), 8000);
}

async function generateSmartReminders(tasks) {
  const active = tasks.filter(t => t.status === "active" && t.deadline);
  if (!active.length) return [];

  const now = new Date();
  const today = now.toISOString().split("T")[0];

  const system = `You are a smart reminder AI. Return ONLY valid JSON array, no markdown.`;
  const prompt = `Analyze these tasks and suggest smart reminders.
Today: ${today}, Current hour: ${now.getHours()}

Tasks with deadlines:
${active.map(t => `- "${t.title}" deadline: ${t.deadline}, priority: ${t.priority}, energy: ${t.energy}`).join("\n")}

Return array of reminders (max 4, only the most important):
[
  {
    "taskId": "...",
    "taskTitle": "...",
    "message": "short reminder message in Russian (max 12 words)",
    "minutesFromNow": 5,
    "urgency": "high or medium"
  }
]

Rules:
- Overdue tasks: remind in 2-5 min
- Today deadline: remind in 10-15 min  
- Tomorrow deadline: remind in 30-60 min
- High priority: always include
- Make messages warm and specific, not robotic`;

  try {
    const apiKey = import.meta.env.VITE_ANTHROPIC_KEY;
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
        max_tokens: 500,
        system,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    const data = await res.json();
    const text = data.content?.[0]?.text || "[]";
    const clean = text.replace(/```json|```/g, "").trim();
    return JSON.parse(clean);
  } catch {
    return [];
  }
}

function useSmartReminders(tasks) {
  const [permission, setPermission] = useState(Notification.permission || "default");
  const [reminders, setReminders] = useState([]);
  const [loading, setLoading] = useState(false);
  const timersRef = useRef([]);

  async function requestPermission() {
    const granted = await requestNotificationPermission();
    setPermission(granted ? "granted" : "denied");
    return granted;
  }

  async function scheduleReminders(taskList) {
    // Clear existing timers
    timersRef.current.forEach(clearTimeout);
    timersRef.current = [];

    setLoading(true);
    const suggestions = await generateSmartReminders(taskList);
    setLoading(false);

    if (!suggestions.length) return;

    const scheduled = suggestions.map(r => {
      const fireAt = Date.now() + r.minutesFromNow * 60 * 1000;
      const timerId = setTimeout(() => {
        sendNotification(r.taskTitle, r.message, r.urgency === "high" ? "🔥" : "⏰");
      }, r.minutesFromNow * 60 * 1000);
      timersRef.current.push(timerId);
      return { ...r, fireAt };
    });

    setReminders(scheduled);
    reminderStorage.save(scheduled);
    return scheduled;
  }

  function clearAll() {
    timersRef.current.forEach(clearTimeout);
    timersRef.current = [];
    setReminders([]);
    reminderStorage.clear();
  }

  return { permission, reminders, loading, requestPermission, scheduleReminders, clearAll };
}

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
      className="fixed bottom-20 left-1/2 -translate-x-1/2 z-50 flex items-center gap-2 px-4 py-2.5 rounded-full bg-slate-100 border border-slate-200 shadow-xl"
      style={{ animation: "toastIn 0.3s ease" }}
    >
      <span className="text-emerald-400 text-sm">✓</span>
      <span className="text-sm text-slate-800 whitespace-nowrap">{message}</span>
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
          ? "bg-white border-amber-500/30"
          : "bg-white border-slate-200"
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
          className="mt-0.5 w-5 h-5 rounded-full border-2 border-slate-300 hover:border-amber-400 flex-shrink-0 transition-colors duration-200 hover:bg-amber-400/10"
        />

        <div className="flex-1 min-w-0">
          <p className="text-slate-900 text-sm font-medium leading-snug">{task.title}</p>

          <div className="flex flex-wrap gap-2 mt-2">
            {dl && (
              <span
                className={`text-xs px-2 py-0.5 rounded-full font-mono ${
                  dl.warn ? "bg-red-500/15 text-red-400" : "bg-slate-200 text-slate-500"
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
            <span className="text-xs px-2 py-0.5 rounded-full bg-slate-200 text-slate-500">
              {ENERGY_LABELS[task.energy]}
            </span>
          </div>

          <p className="mt-1.5 text-xs text-slate-300 opacity-0 group-hover:opacity-100 transition-opacity">нажми чтобы редактировать</p>
          {(task.priorityReason || task.aiHint) && (
            <p className="mt-2 text-xs text-slate-400 italic">
              ✦ {task.priorityReason || task.aiHint}
            </p>
          )}
        </div>

        <button
          onClick={(e) => { e.stopPropagation(); onDelete(task.id); }}
          className="opacity-0 group-hover:opacity-100 text-slate-400 hover:text-slate-500 transition-all text-lg leading-none mt-0.5"
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
      <div className="bg-white border border-slate-200 rounded-2xl w-full max-w-md shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="p-6 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-slate-900 font-semibold text-lg">Редактировать задачу</h2>
            <button onClick={onClose} className="text-slate-400 hover:text-slate-500 text-xl leading-none">×</button>
          </div>

          {/* Title */}
          <div>
            <label className="text-xs text-slate-400 mb-1 block">Название</label>
            <input
              value={form.title}
              onChange={(e) => set("title", e.target.value)}
              className="w-full bg-slate-100 border border-slate-200 rounded-xl px-3 py-2 text-sm text-slate-800 focus:outline-none focus:border-amber-500/50"
            />
          </div>

          {/* Deadline */}
          <div>
            <label className="text-xs text-slate-400 mb-1 block">Дедлайн</label>
            <input
              type="date"
              value={form.deadline || ""}
              onChange={(e) => set("deadline", e.target.value || null)}
              className="w-full bg-slate-100 border border-slate-200 rounded-xl px-3 py-2 text-sm text-slate-800 focus:outline-none focus:border-amber-500/50"
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
                <label className="text-xs text-slate-400 mb-1 block">{label}</label>
                <select
                  value={form[key]}
                  onChange={(e) => set(key, e.target.value)}
                  className="w-full bg-slate-100 border border-slate-200 rounded-lg px-2 py-2 text-xs text-slate-800 focus:outline-none"
                >
                  {options.map((o) => <option key={o} value={o}>{labels[o]}</option>)}
                </select>
              </div>
            ))}
          </div>

          {/* Note */}
          <div>
            <label className="text-xs text-slate-400 mb-1 block">Заметка</label>
            <textarea
              value={form.note || ""}
              onChange={(e) => set("note", e.target.value)}
              placeholder="Добавь детали..."
              rows={2}
              className="w-full bg-slate-100 border border-slate-200 rounded-xl px-3 py-2 text-sm text-slate-800 placeholder-zinc-600 resize-none focus:outline-none focus:border-amber-500/50"
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
          <button onClick={onClose} className="px-4 py-2 rounded-xl border border-slate-200 text-slate-500 text-sm hover:bg-slate-100 transition-colors">
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
      <div className="bg-white border border-slate-200 rounded-2xl w-full max-w-md shadow-2xl">
        <div className="p-6">
          <h2 className="text-slate-900 font-semibold text-lg mb-1">Новая задача</h2>
          <p className="text-slate-400 text-sm mb-4">Опишите задачу как угодно — ИИ разберётся</p>

          <textarea
            ref={inputRef}
            value={raw}
            onChange={(e) => { setRaw(e.target.value); setParsed(null); }}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleParse(); } }}
            placeholder='Например: "Сдать отчёт Серику до пятницы, срочно"'
            className="w-full bg-slate-100 border border-slate-200 rounded-xl p-3 text-sm text-slate-800 placeholder-zinc-600 resize-none focus:outline-none focus:border-amber-500/50 transition-colors"
            rows={3}
          />

          {loading && <div className="mt-3"><Loader /></div>}

          {parsed && !loading && (
            <div className="mt-4 bg-white border border-slate-200 rounded-xl p-4 space-y-3">
              <p className="text-xs text-amber-400 font-mono uppercase tracking-wider">ИИ распознал</p>

              <div>
                <label className="text-xs text-slate-400">Название</label>
                <input
                  value={parsed.title}
                  onChange={(e) => setParsed({ ...parsed, title: e.target.value })}
                  className="mt-1 w-full bg-slate-200/50 border border-slate-300 rounded-lg px-3 py-1.5 text-sm text-slate-800 focus:outline-none focus:border-amber-500/50"
                />
              </div>

              <div className="grid grid-cols-3 gap-2">
                {[
                  { key: "priority", label: "Приоритет", options: ["high", "medium", "low"], labels: PRIORITY_LABELS },
                  { key: "category", label: "Категория", options: ["work", "study", "personal"], labels: { work: "Работа", study: "Учёба", personal: "Личное" } },
                  { key: "energy", label: "Энергия", options: ["high", "medium", "low"], labels: ENERGY_LABELS },
                ].map(({ key, label, options, labels }) => (
                  <div key={key}>
                    <label className="text-xs text-slate-400">{label}</label>
                    <select
                      value={parsed[key]}
                      onChange={(e) => setParsed({ ...parsed, [key]: e.target.value })}
                      className="mt-1 w-full bg-slate-200/50 border border-slate-300 rounded-lg px-2 py-1.5 text-xs text-slate-800 focus:outline-none"
                    >
                      {options.map((o) => <option key={o} value={o}>{labels[o]}</option>)}
                    </select>
                  </div>
                ))}
              </div>

              <div>
                <label className="text-xs text-slate-400">Дедлайн</label>
                <input
                  type="date"
                  value={parsed.deadline || ""}
                  onChange={(e) => setParsed({ ...parsed, deadline: e.target.value || null })}
                  className="mt-1 w-full bg-slate-200/50 border border-slate-300 rounded-lg px-3 py-1.5 text-sm text-slate-800 focus:outline-none focus:border-amber-500/50"
                />
              </div>

              {parsed.aiHint && (
                <p className="text-xs text-slate-400 italic">✦ {parsed.aiHint}</p>
              )}
            </div>
          )}
        </div>

        <div className="flex gap-2 p-6 pt-0">
          <button
            onClick={onClose}
            className="flex-1 py-2.5 rounded-xl border border-slate-200 text-slate-500 text-sm hover:bg-slate-100 transition-colors"
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
          <span className="text-xs text-slate-400">{d.label}</span>
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
      <circle cx={cx} cy={cy} r={r - 8} fill="#f8fafc" />
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
        <span className="text-xs font-mono text-slate-400 uppercase tracking-widest">{title}</span>
        <div className="flex-1 h-px bg-slate-100" />
        <span className="text-xs text-slate-400">{items.length}</span>
      </div>
      {items.length === 0 ? (
        <p className="text-slate-300 text-sm text-center py-4">Пусто</p>
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
          <h1 className="text-2xl font-bold text-slate-900">Сегодня</h1>
          <p className="text-slate-400 text-sm mt-0.5">
            {new Date().toLocaleDateString("ru-RU", { weekday: "long", day: "numeric", month: "long" })}
          </p>
        </div>

      </div>

      {/* AI Priority Status Banner */}
      <div className="flex items-center justify-between px-3 py-2 rounded-lg bg-slate-100/80 border border-slate-200">
        {prioritizing ? (
          <Loader text="ИИ расставляет приоритеты" />
        ) : (
          <div className="flex items-center gap-2">
            <span className="text-amber-400 text-xs">✦</span>
            <span className="text-xs text-slate-400">
              {lastPrioritized
                ? `Приоритизировано в ${new Date(lastPrioritized).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}`
                : "Ещё не приоритизировано"}
            </span>
          </div>
        )}
        <button
          onClick={onReprioritize}
          disabled={prioritizing}
          className="text-xs text-slate-400 hover:text-amber-400 transition-colors disabled:opacity-30 font-mono"
        >
          ↺ обновить
        </button>
      </div>

      {active.length === 0 ? (
        <div className="text-center py-16 space-y-3">
          <p className="text-5xl">✦</p>
          <p className="text-slate-700 font-medium">Все задачи выполнены!</p>
          <p className="text-slate-400 text-sm">Добавь новые или отдохни — ты заслужил</p>
        </div>
      ) : (
        <>
          <RemindersPanel tasks={tasks} />

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
        <h1 className="text-2xl font-bold text-slate-900">Все задачи</h1>

      </div>

      <div className="flex gap-1 bg-white rounded-xl p-1">
        {[["active", "Активные"], ["done", "Готово"], ["all", "Все"]].map(([v, l]) => (
          <button
            key={v}
            onClick={() => setFilter(v)}
            className={`flex-1 py-1.5 rounded-lg text-sm transition-all ${
              filter === v
                ? "bg-slate-200 text-slate-900 font-medium"
                : "text-slate-400 hover:text-slate-500"
            }`}
          >
            {l}
          </button>
        ))}
      </div>

      {filtered.length === 0 ? (
        <div className="text-center py-16">
          <p className="text-slate-400 text-4xl mb-3">✦</p>
          <p className="text-slate-400 text-sm">Здесь пока пусто</p>
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
      <h1 className="text-2xl font-bold text-slate-900">Аналитика</h1>

      {/* Flow Score — hero metric */}
      <div className="relative bg-white rounded-2xl p-5 border border-slate-200 overflow-hidden">
        <div
          className="absolute inset-0 opacity-5"
          style={{ background: `radial-gradient(circle at 80% 50%, ${flowScore >= 50 ? "#10b981" : "#f59e0b"}, transparent 60%)` }}
        />
        <div className="flex items-center justify-between">
          <div>
            <p className="text-xs font-mono text-slate-400 uppercase tracking-widest mb-1">Flow Score</p>
            <p className="text-5xl font-bold text-slate-900">{flowScore}<span className="text-2xl text-slate-400">%</span></p>
            <p className="text-sm mt-1" style={{ color: flowScore >= 50 ? "#10b981" : "#f59e0b" }}>{flowLabel}</p>
          </div>
          <div className="text-right space-y-2">
            {[
              { label: "Выполнено", value: done.length, color: "text-emerald-400" },
              { label: "Активных", value: active.length, color: "text-slate-700" },
              { label: "Просрочено", value: overdue.length, color: overdue.length > 0 ? "text-red-400" : "text-slate-400" },
            ].map(({ label, value, color }) => (
              <div key={label}>
                <span className={`text-lg font-bold ${color}`}>{value}</span>
                <span className="text-xs text-slate-400 ml-1.5">{label}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Progress bar */}
        <div className="mt-4 h-1.5 bg-slate-200 rounded-full overflow-hidden">
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
      <div className="bg-white rounded-xl p-5 border border-slate-200">
        <div className="flex items-center justify-between mb-4">
          <p className="text-xs font-mono text-slate-400 uppercase tracking-widest">Активность за неделю</p>
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-1.5">
              <div className="w-2 h-2 rounded-full bg-amber-500" />
              <span className="text-xs text-slate-400">создано</span>
            </div>
            <div className="flex items-center gap-1.5">
              <div className="w-2 h-2 rounded-full bg-emerald-500" />
              <span className="text-xs text-slate-400">выполнено</span>
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
                <span className={`text-xs ${isToday ? "text-amber-400" : "text-slate-400"}`}>{d.label}</span>
              </div>
            );
          })}
        </div>
      </div>

      {/* Category breakdown */}
      <div className="bg-white rounded-xl p-5 border border-slate-200">
        <p className="text-xs font-mono text-slate-400 uppercase tracking-widest mb-4">По категориям</p>
        <div className="space-y-3">
          {byCat.map(({ label, value, done: d, color, pct }) => (
            <div key={label}>
              <div className="flex items-center justify-between mb-1.5">
                <div className="flex items-center gap-2">
                  <div className="w-2 h-2 rounded-full" style={{ backgroundColor: color }} />
                  <span className="text-sm text-slate-700">{label}</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-slate-400">{d}/{value}</span>
                  <span className="text-xs font-mono" style={{ color }}>{pct}%</span>
                </div>
              </div>
              <div className="h-1.5 bg-slate-200 rounded-full overflow-hidden">
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
      <div className="bg-white rounded-xl p-5 border border-slate-200">
        <p className="text-xs font-mono text-slate-400 uppercase tracking-widest mb-4">По приоритету</p>
        <div className="flex gap-3">
          {byPriority.map(({ label, total, done: d, color }) => (
            <div key={label} className="flex-1 text-center">
              <div
                className="text-2xl font-bold"
                style={{ color: total > 0 ? color : "#3f3f46" }}
              >
                {d}/{total}
              </div>
              <div className="text-xs text-slate-400 mt-1">{label}</div>
              <div className="mt-2 h-1 bg-slate-200 rounded-full overflow-hidden">
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
      <div className="bg-white rounded-xl p-5 border border-amber-500/20">
        <div className="flex items-center justify-between mb-3">
          <p className="text-xs font-mono text-amber-400 uppercase tracking-widest">ИИ-анализ</p>
          <button
            onClick={loadInsight}
            disabled={loadingInsight}
            className="text-xs text-slate-400 hover:text-amber-400 transition-colors disabled:opacity-40"
          >
            {loadingInsight ? "..." : insight ? "↺ обновить" : "получить анализ →"}
          </button>
        </div>
        {loadingInsight ? (
          <Loader text="ИИ анализирует продуктивность" />
        ) : insightLines.length > 0 ? (
          <div className="space-y-2.5">
            {insightLines.map((line, i) => (
              <p key={i} className="text-sm text-slate-700 leading-relaxed">{line}</p>
            ))}
            <p className="text-xs text-slate-400 mt-3">
              Обновлено {new Date(insight.at).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}
            </p>
          </div>
        ) : (
          <button
            onClick={loadInsight}
            className="w-full text-center py-4 text-sm text-slate-400 hover:text-amber-400 transition-colors border border-dashed border-slate-200 rounded-lg"
          >
            ✦ Нажми чтобы получить персональный анализ
          </button>
        )}
      </div>
    </div>
  );
}




// ─── Reminders Panel ─────────────────────────────────────────────────────────

function RemindersPanel({ tasks }) {
  const { permission, reminders, loading, requestPermission, scheduleReminders, clearAll } = useSmartReminders(tasks);
  const [scheduled, setScheduled] = useState(false);
  const [expanded, setExpanded] = useState(false);

  async function handleEnable() {
    const granted = await requestPermission();
    if (granted) {
      const result = await scheduleReminders(tasks);
      if (result?.length) setScheduled(true);
    }
  }

  async function handleRefresh() {
    clearAll();
    const result = await scheduleReminders(tasks);
    if (result?.length) setScheduled(true);
  }

  function formatFireAt(ms) {
    const diff = Math.round((ms - Date.now()) / 60000);
    if (diff <= 0) return "сейчас";
    if (diff < 60) return `через ${diff} мин`;
    return `через ${Math.round(diff / 60)} ч`;
  }

  const urgencyColor = { high: "#f59e0b", medium: "#6366f1" };

  return (
    <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
      {/* Header */}
      <div
        className="flex items-center justify-between p-5 cursor-pointer hover:bg-slate-50 transition-colors"
        onClick={() => setExpanded(e => !e)}
      >
        <div className="flex items-center gap-3">
          <div className={`w-8 h-8 rounded-lg flex items-center justify-center text-base ${
            permission === "granted" ? "bg-amber-50" : "bg-slate-100"
          }`}>
            {permission === "granted" ? "🔔" : "🔕"}
          </div>
          <div>
            <p className="text-sm font-semibold text-slate-800">Умные напоминания</p>
            <p className="text-xs text-slate-400 mt-0.5">
              {permission === "denied" ? "Доступ запрещён в браузере" :
               permission !== "granted" ? "Нажми чтобы включить" :
               scheduled ? `${reminders.length} активных напоминаний` : "Готово к настройке"}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {loading && <span className="text-xs text-amber-500 font-mono animate-pulse">ИИ думает...</span>}
          {permission === "granted" && scheduled && !loading && (
            <button
              onClick={(e) => { e.stopPropagation(); handleRefresh(); }}
              className="text-xs text-slate-400 hover:text-amber-500 transition-colors px-2 py-1 rounded-lg hover:bg-amber-50"
            >
              ↺ обновить
            </button>
          )}
          <span className="text-slate-300 text-sm">{expanded ? "▲" : "▼"}</span>
        </div>
      </div>

      {/* Body */}
      {expanded && (
        <div className="px-5 pb-5 border-t border-slate-100 pt-4 space-y-4">
          {permission !== "granted" ? (
            <div className="text-center py-4 space-y-3">
              <p className="text-sm text-slate-500">
                ИИ проанализирует твои дедлайны и сам решит когда напомнить — за час, за день, или прямо сейчас если что-то горит.
              </p>
              <button
                onClick={handleEnable}
                disabled={permission === "denied"}
                className="px-6 py-2.5 rounded-xl bg-amber-400 text-slate-900 text-sm font-semibold hover:bg-amber-300 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {permission === "denied" ? "Разреши в настройках браузера" : "Включить напоминания →"}
              </button>
            </div>
          ) : !scheduled ? (
            <div className="text-center py-4 space-y-3">
              <p className="text-sm text-slate-500">ИИ проанализирует задачи и расставит напоминания умно</p>
              <button
                onClick={handleRefresh}
                className="px-6 py-2.5 rounded-xl bg-amber-400 text-slate-900 text-sm font-semibold hover:bg-amber-300 transition-colors"
              >
                Запустить ИИ-анализ →
              </button>
            </div>
          ) : reminders.length === 0 ? (
            <p className="text-sm text-slate-400 text-center py-3">Нет задач с дедлайнами для напоминаний</p>
          ) : (
            <div className="space-y-2.5">
              {reminders.map((r, i) => (
                <div key={i} className="flex items-start gap-3 p-3 rounded-xl bg-slate-50 border border-slate-100">
                  <div className="w-2 h-2 rounded-full mt-1.5 flex-shrink-0" style={{ backgroundColor: urgencyColor[r.urgency] || "#94a3b8" }} />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-slate-700 truncate">{r.taskTitle}</p>
                    <p className="text-xs text-slate-400 mt-0.5">"{r.message}"</p>
                  </div>
                  <span className="text-xs font-mono text-amber-500 whitespace-nowrap">{formatFireAt(r.fireAt)}</span>
                </div>
              ))}
              <button
                onClick={clearAll}
                className="text-xs text-slate-400 hover:text-red-400 transition-colors mt-1"
              >
                Отменить все напоминания
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Focus Mode ───────────────────────────────────────────────────────────────

function useSound() {
  function playTick() {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.connect(g); g.connect(ctx.destination);
      o.frequency.value = 880;
      o.type = "sine";
      g.gain.setValueAtTime(0.08, ctx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.08);
      o.start(ctx.currentTime);
      o.stop(ctx.currentTime + 0.08);
    } catch {}
  }

  function playDone() {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      [[523, 0], [659, 0.12], [784, 0.24], [1047, 0.38]].forEach(([freq, delay]) => {
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.connect(g); g.connect(ctx.destination);
        o.frequency.value = freq;
        o.type = "sine";
        g.gain.setValueAtTime(0, ctx.currentTime + delay);
        g.gain.linearRampToValueAtTime(0.18, ctx.currentTime + delay + 0.04);
        g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + delay + 0.35);
        o.start(ctx.currentTime + delay);
        o.stop(ctx.currentTime + delay + 0.4);
      });
    } catch {}
  }

  function playStart() {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.connect(g); g.connect(ctx.destination);
      o.frequency.value = 528;
      o.type = "sine";
      g.gain.setValueAtTime(0.15, ctx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4);
      o.start(ctx.currentTime);
      o.stop(ctx.currentTime + 0.4);
    } catch {}
  }

  return { playTick, playDone, playStart };
}

const FOCUS_DURATIONS = [
  { label: "25 мин", seconds: 25 * 60 },
  { label: "15 мин", seconds: 15 * 60 },
  { label: "45 мин", seconds: 45 * 60 },
  { label: "5 мин",  seconds: 5 * 60  },
];

function FocusView({ tasks, onDone, onSetFullscreen }) {
  const activeTasks = tasks.filter(t => t.status === "active");
  const [selectedTask, setSelectedTask] = useState(activeTasks[0] || null);
  const [duration, setDuration] = useState(FOCUS_DURATIONS[0]);
  const [timeLeft, setTimeLeft] = useState(FOCUS_DURATIONS[0].seconds);
  const [running, setRunning] = useState(false);
  const [finished, setFinished] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const intervalRef = useRef(null);
  const { playTick, playDone, playStart } = useSound();

  const pct = ((duration.seconds - timeLeft) / duration.seconds) * 100;
  const mins = String(Math.floor(timeLeft / 60)).padStart(2, "0");
  const secs = String(timeLeft % 60).padStart(2, "0");
  const radius = 95;
  const circ = 2 * Math.PI * radius;

  useEffect(() => {
    if (running) {
      intervalRef.current = setInterval(() => {
        setTimeLeft(t => {
          if (t <= 1) {
            clearInterval(intervalRef.current);
            setRunning(false);
            setFinished(true);
            playDone();
            return 0;
          }
          if ((t - 1) % 60 === 0) playTick();
          return t - 1;
        });
      }, 1000);
    }
    return () => clearInterval(intervalRef.current);
  }, [running]);

  function handleStart() {
    if (finished) {
      setFinished(false);
      setTimeLeft(duration.seconds);
      return;
    }
    playStart();
    setRunning(true);
    setFullscreen(true);
  }

  function handlePause() { setRunning(false); }
  function handleReset() {
    setRunning(false);
    setFinished(false);
    setTimeLeft(duration.seconds);
    setFullscreen(false);
  }

  function handleChangeDuration(d) {
    setDuration(d);
    setTimeLeft(d.seconds);
    setRunning(false);
    setFinished(false);
  }

  function handleComplete() {
    if (selectedTask) onDone(selectedTask.id);
    handleReset();
    setSelectedTask(activeTasks.find(t => t.id !== selectedTask?.id) || null);
  }

  const catColor = CATEGORY_COLORS[selectedTask?.category] || "#f59e0b";

  // ── Fullscreen overlay — rendered via prop callback ──
  useEffect(() => {
    if (fullscreen) {
      onSetFullscreen({
        mins, secs, pct, running, finished, selectedTask, catColor,
        radius, circ,
        onPause: handlePause,
        onStart: handleStart,
        onReset: handleReset,
        onExit: () => setFullscreen(false),
        onComplete: handleComplete,
      });
    } else {
      onSetFullscreen(null);
    }
  }, [fullscreen, mins, secs, running, finished]);

  // ── Setup screen ──
  return (
    <div className="space-y-6 max-w-xl">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Режим фокуса</h1>
        <p className="text-slate-400 text-sm mt-0.5">Одна задача. Один таймер. Полная концентрация.</p>
      </div>

      {/* Task picker */}
      <div className="bg-white rounded-2xl border border-slate-200 p-5 shadow-sm">
        <p className="text-xs font-mono text-slate-400 uppercase tracking-widest mb-3">Выбери задачу</p>
        {activeTasks.length === 0 ? (
          <p className="text-slate-400 text-sm">Нет активных задач — добавь их в разделе Сегодня</p>
        ) : (
          <div className="space-y-2">
            {activeTasks.slice(0, 6).map(t => {
              const color = CATEGORY_COLORS[t.category];
              const selected = selectedTask?.id === t.id;
              return (
                <button
                  key={t.id}
                  onClick={() => setSelectedTask(t)}
                  className={`w-full flex items-center gap-3 p-3 rounded-xl border-2 transition-all text-left ${
                    selected
                      ? "border-amber-400 bg-amber-50"
                      : "border-slate-100 hover:border-slate-200 bg-slate-50"
                  }`}
                >
                  <div className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: color }} />
                  <span className={`text-sm font-medium ${selected ? "text-slate-900" : "text-slate-600"}`}>
                    {t.title}
                  </span>
                  {selected && <span className="ml-auto text-amber-500 text-xs">✓</span>}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* Duration picker */}
      <div className="bg-white rounded-2xl border border-slate-200 p-5 shadow-sm">
        <p className="text-xs font-mono text-slate-400 uppercase tracking-widest mb-3">Длительность</p>
        <div className="grid grid-cols-4 gap-2">
          {FOCUS_DURATIONS.map(d => (
            <button
              key={d.label}
              onClick={() => handleChangeDuration(d)}
              className={`py-3 rounded-xl border-2 text-sm font-semibold transition-all ${
                duration.label === d.label
                  ? "border-amber-400 bg-amber-50 text-amber-700"
                  : "border-slate-200 text-slate-500 hover:border-amber-300"
              }`}
            >
              {d.label}
            </button>
          ))}
        </div>
      </div>

      {/* Mini timer preview + start */}
      <div className="bg-white rounded-2xl border border-slate-200 p-6 shadow-sm flex items-center justify-between">
        <div>
          <p className="text-4xl font-bold text-slate-900 tabular-nums">{mins}:{secs}</p>
          <p className="text-slate-400 text-sm mt-1">
            {selectedTask ? `"${selectedTask.title.slice(0, 28)}${selectedTask.title.length > 28 ? "…" : ""}"` : "задача не выбрана"}
          </p>
        </div>
        <button
          onClick={handleStart}
          disabled={!selectedTask}
          className="px-8 py-4 rounded-2xl font-bold text-base transition-all disabled:opacity-30 disabled:cursor-not-allowed shadow-lg"
          style={{
            background: "#f59e0b",
            color: "#1c1917",
            boxShadow: selectedTask ? "0 8px 24px rgba(245,158,11,0.35)" : "none",
          }}
        >
          Войти в фокус →
        </button>
      </div>
    </div>
  );
}

// ─── Voice Assistant ──────────────────────────────────────────────────────────

function useVoiceSynth() {
  const audioRef = useRef(null);

  async function speakElevenLabs(text) {
    const apiKey = import.meta.env.VITE_ELEVEN_KEY;
    if (!apiKey) return false;

    try {
      // Rachel — multilingual, warm natural voice, works well for Russian
      const voiceId = "21m00Tcm4TlvDq8ikWAM";

      const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "xi-api-key": apiKey,
        },
        body: JSON.stringify({
          text,
          model_id: "eleven_multilingual_v2",
          voice_settings: {
            stability: 0.45,
            similarity_boost: 0.82,
            style: 0.3,
            use_speaker_boost: true,
          },
        }),
      });

      if (!res.ok) return false;

      const blob = await res.blob();
      const url = URL.createObjectURL(blob);

      if (audioRef.current) {
        audioRef.current.pause();
        URL.revokeObjectURL(audioRef.current.src);
      }

      const audio = new Audio(url);
      audioRef.current = audio;
      audio.play();
      return audio;
    } catch {
      return false;
    }
  }

  function speakFallback(text) {
    if (!window.speechSynthesis) return null;
    window.speechSynthesis.cancel();
    const utter = new SpeechSynthesisUtterance(text);
    utter.lang = "ru-RU";
    utter.rate = 0.88;
    utter.pitch = 1.05;
    const voices = window.speechSynthesis.getVoices();
    const ruVoice = voices.find(v => v.lang.startsWith("ru") && !v.name.includes("Google"))
      || voices.find(v => v.lang.startsWith("ru"));
    if (ruVoice) utter.voice = ruVoice;
    window.speechSynthesis.speak(utter);
    return utter;
  }

  async function speak(text, onEnd) {
    const result = await speakElevenLabs(text);
    if (result) {
      result.onended = onEnd || null;
      return result;
    }
    // fallback to browser TTS
    const utter = speakFallback(text);
    if (utter && onEnd) utter.onend = onEnd;
    return utter;
  }

  function stop() {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
    }
    window.speechSynthesis?.cancel();
  }

  return { speak, stop };
}

function OrbVisualizer({ state }) {
  // state: idle | listening | thinking | speaking
  const rings = [1, 2, 3];
  const isActive = state !== "idle";

  const orbColor = {
    idle:      { bg: "from-amber-100 to-amber-200", shadow: "shadow-amber-200" },
    listening: { bg: "from-amber-300 to-amber-400", shadow: "shadow-amber-300" },
    thinking:  { bg: "from-slate-300 to-slate-400", shadow: "shadow-slate-300" },
    speaking:  { bg: "from-emerald-200 to-emerald-400", shadow: "shadow-emerald-300" },
  }[state];

  return (
    <div className="relative flex items-center justify-center w-48 h-48">
      {/* Animated rings */}
      {isActive && rings.map((r) => (
        <div
          key={r}
          className="absolute rounded-full border border-amber-300/40"
          style={{
            width: `${r * 56 + 80}px`,
            height: `${r * 56 + 80}px`,
            animation: `orbRing ${1.2 + r * 0.4}s ease-in-out infinite`,
            animationDelay: `${r * 0.15}s`,
            borderColor: state === "speaking" ? "rgba(52,211,153,0.3)" :
                         state === "thinking" ? "rgba(148,163,184,0.3)" :
                         "rgba(251,191,36,0.35)",
          }}
        />
      ))}

      {/* Core orb */}
      <div
        className={`relative w-28 h-28 rounded-full bg-gradient-to-br ${orbColor.bg} shadow-2xl ${orbColor.shadow} flex items-center justify-center transition-all duration-500`}
        style={{
          animation: isActive ? "orbPulse 2s ease-in-out infinite" : "none",
          boxShadow: isActive ? `0 0 60px 10px ${
            state === "speaking" ? "rgba(52,211,153,0.25)" :
            state === "thinking" ? "rgba(148,163,184,0.2)" :
            "rgba(251,191,36,0.3)"
          }` : undefined,
        }}
      >
        {/* Icon inside orb */}
        <span className="text-3xl select-none">
          {state === "idle"      && "✦"}
          {state === "listening" && "◎"}
          {state === "thinking"  && "⋯"}
          {state === "speaking"  && "♪"}
        </span>
      </div>
    </div>
  );
}

function VoiceView({ tasks, onAddTask }) {
  const [orbState, setOrbState] = useState("idle"); // idle | listening | thinking | speaking
  const [messages, setMessages] = useState([
    { role: "assistant", text: "Привет! Я FlowMind. Скажи мне о своей задаче, или спроси что угодно — я помогу спланировать твой день." }
  ]);
  const [transcript, setTranscript] = useState("");
  const [supported, setSupported] = useState(true);
  const recognitionRef = useRef(null);
  const messagesEndRef = useRef(null);
  const { speak, stop } = useVoiceSynth();

  useEffect(() => {
    if (!("webkitSpeechRecognition" in window) && !("SpeechRecognition" in window)) {
      setSupported(false);
    }
    // Load voices async
    window.speechSynthesis?.getVoices();
    window.speechSynthesis?.addEventListener("voiceschanged", () => window.speechSynthesis.getVoices());
  }, []);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  async function handleUserInput(text) {
    if (!text.trim()) return;

    const userMsg = { role: "user", text };
    setMessages((m) => [...m, userMsg]);
    setTranscript("");
    setOrbState("thinking");
    stop();

    // Build context for Claude
    const activeTasks = tasks.filter(t => t.status === "active").slice(0, 8);
    const system = `Ты FlowMind — голосовой ИИ-ассистент планировщика задач. Отвечай ТОЛЬКО на русском языке. 
Будь кратким (2-4 предложения), тёплым и конкретным. Не используй markdown, списки с дефисами или звёздочки.
Если пользователь говорит о задаче — помоги её добавить. Если спрашивает о плане дня — дай совет исходя из задач.
Текущие задачи пользователя: ${activeTasks.map(t => t.title).join(", ") || "нет задач"}.
Если пользователь хочет добавить задачу, в конце ответа добавь строку: ДОБАВИТЬ_ЗАДАЧУ: <название задачи>`;

    const history = messages.slice(-6).map(m => ({
      role: m.role === "user" ? "user" : "assistant",
      content: m.text,
    }));

    try {
      const apiKey = import.meta.env.VITE_ANTHROPIC_KEY;
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
          max_tokens: 300,
          system,
          messages: [...history, { role: "user", content: text }],
        }),
      });
      const data = await res.json();
      let reply = data.content?.[0]?.text || "Извини, не смог ответить.";

      // Check if AI wants to add a task
      const taskMatch = reply.match(/ДОБАВИТЬ_ЗАДАЧУ:\s*(.+)/);
      if (taskMatch) {
        const taskTitle = taskMatch[1].trim();
        reply = reply.replace(/ДОБАВИТЬ_ЗАДАЧУ:\s*.+/, "").trim();
        // Auto-add via parseTask
        parseTask(taskTitle).then((parsed) => {
          onAddTask({ id: Math.random().toString(36).slice(2), ...parsed, status: "active", createdAt: new Date().toISOString() });
        });
        reply += " Я добавил эту задачу в твой список.";
      }

      setMessages((m) => [...m, { role: "assistant", text: reply }]);
      setOrbState("speaking");
      speak(reply, () => setOrbState("idle")).then(result => {
        if (!result) setTimeout(() => setOrbState("idle"), 2000);
      });
    } catch {
      setMessages((m) => [...m, { role: "assistant", text: "Произошла ошибка. Попробуй ещё раз." }]);
      setOrbState("idle");
    }
  }

  function startListening() {
    if (!supported) return;
    stop();
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    const recognition = new SpeechRecognition();
    recognition.lang = "ru-RU";
    recognition.continuous = false;
    recognition.interimResults = true;

    recognition.onstart = () => setOrbState("listening");
    recognition.onresult = (e) => {
      const t = Array.from(e.results).map(r => r[0].transcript).join("");
      setTranscript(t);
      if (e.results[e.results.length - 1].isFinal) {
        recognition.stop();
        handleUserInput(t);
      }
    };
    recognition.onerror = () => setOrbState("idle");
    recognition.onend = () => { if (orbState === "listening") setOrbState("idle"); };
    recognitionRef.current = recognition;
    recognition.start();
  }

  function stopListening() {
    recognitionRef.current?.stop();
    setOrbState("idle");
    setTranscript("");
  }

  function handleOrbClick() {
    if (orbState === "idle") startListening();
    else if (orbState === "listening") stopListening();
    else if (orbState === "speaking") { stop(); setOrbState("idle"); }
  }

  const stateLabel = {
    idle:      "Нажми чтобы говорить",
    listening: "Слушаю...",
    thinking:  "Думаю...",
    speaking:  "Говорю... (нажми чтобы остановить)",
  }[orbState];

  return (
    <div className="flex flex-col h-screen max-h-screen">
      <div className="px-2 pt-6 pb-2">
        <h1 className="text-2xl font-bold text-slate-900">Голосовой ИИ</h1>
        <p className="text-slate-400 text-sm mt-0.5">Говори — FlowMind слушает и отвечает</p>
      </div>

      {/* Chat messages */}
      <div className="flex-1 overflow-y-auto px-2 py-4 space-y-3">
        {messages.map((msg, i) => (
          <div key={i} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
            <div
              className={`max-w-xs lg:max-w-md px-4 py-2.5 rounded-2xl text-sm leading-relaxed ${
                msg.role === "user"
                  ? "bg-amber-400 text-slate-900 rounded-tr-sm"
                  : "bg-white border border-slate-200 text-slate-700 rounded-tl-sm shadow-sm"
              }`}
            >
              {msg.role === "assistant" && (
                <span className="text-amber-500 text-xs font-mono block mb-1">✦ FlowMind</span>
              )}
              {msg.text}
            </div>
          </div>
        ))}
        {transcript && (
          <div className="flex justify-end">
            <div className="max-w-xs px-4 py-2.5 rounded-2xl rounded-tr-sm bg-amber-200/60 text-slate-600 text-sm italic">
              {transcript}...
            </div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Orb + controls */}
      <div className="flex flex-col items-center pb-8 pt-4 border-t border-slate-100">
        <button
          onClick={handleOrbClick}
          disabled={orbState === "thinking"}
          className="focus:outline-none disabled:cursor-wait transition-transform hover:scale-105 active:scale-95"
        >
          <OrbVisualizer state={orbState} />
        </button>

        <p className="text-sm text-slate-400 mt-2 font-mono">{stateLabel}</p>

        {!supported && (
          <p className="text-xs text-red-400 mt-2">Браузер не поддерживает голосовой ввод. Используй Chrome.</p>
        )}

        {/* Text input fallback */}
        <div className="mt-4 flex gap-2 w-full max-w-sm px-4">
          <input
            type="text"
            placeholder="Или напиши сюда..."
            onKeyDown={(e) => {
              if (e.key === "Enter" && e.target.value.trim()) {
                handleUserInput(e.target.value);
                e.target.value = "";
              }
            }}
            className="flex-1 bg-white border border-slate-200 rounded-xl px-3 py-2 text-sm text-slate-700 placeholder-slate-400 focus:outline-none focus:border-amber-400 shadow-sm"
          />
          <button
            onClick={(e) => {
              const input = e.target.closest("div").querySelector("input");
              if (input.value.trim()) { handleUserInput(input.value); input.value = ""; }
            }}
            className="px-4 py-2 rounded-xl bg-amber-400 text-slate-900 text-sm font-semibold hover:bg-amber-300 transition-colors"
          >
            →
          </button>
        </div>
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
  const [focusOverlay, setFocusOverlay] = useState(null);
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
    { id: "voice", label: "Ассистент", icon: "◉" },
    { id: "focus", label: "Фокус", icon: "◐" },
  ];

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 flex" style={{ fontFamily: "'DM Sans', system-ui, sans-serif" }}>
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
        background: "radial-gradient(ellipse 50% 60% at 20% 0%, rgba(245,158,11,0.08) 0%, transparent 60%)",
      }} />

      {/* ── Sidebar ── */}
      <aside className="fixed left-0 top-0 h-full w-56 border-r border-slate-200/80 bg-slate-50/95 backdrop-blur-md flex flex-col z-30">
        {/* Logo */}
        <div className="flex items-center gap-2.5 px-6 py-5 border-b border-slate-200/80">
          <span className="text-amber-400 text-xl">✦</span>
          <span className="font-bold text-slate-900 tracking-tight text-lg">FlowMind</span>
        </div>

        {/* Nav items */}
        <nav className="flex-1 px-3 py-4 space-y-1">
          {navItems.map(({ id, label, icon }) => (
            <button
              key={id}
              onClick={() => setView(id)}
              className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm transition-all text-left ${
                view === id
                  ? "bg-amber-50 text-amber-400 font-medium"
                  : "text-slate-400 hover:text-slate-700 hover:bg-white"
              }`}
            >
              <span className="text-base w-5 text-center">{icon}</span>
              {label}
            </button>
          ))}
        </nav>

        {/* Bottom stats */}
        <div className="px-5 py-5 border-t border-slate-200/80 space-y-2">
          <div className="flex justify-between text-xs">
            <span className="text-slate-400">Активных</span>
            <span className="text-slate-500 font-mono">{tasks.filter((t) => t.status === "active").length}</span>
          </div>
          <div className="flex justify-between text-xs">
            <span className="text-slate-400">Выполнено</span>
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
          {view === "voice" && <VoiceView tasks={tasks} onAddTask={handleAdd} />}
          {view === "focus" && <FocusView tasks={tasks} onDone={handleDone} onSetFullscreen={setFocusOverlay} />}
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

      {/* Focus Fullscreen Overlay — rendered at root to cover sidebar */}
      {focusOverlay && (
        <div
          className="fixed inset-0 flex flex-col items-center justify-center overflow-hidden"
          style={{ zIndex: 9999, background: "linear-gradient(135deg, #fffbeb 0%, #fef3c7 40%, #fff7ed 100%)" }}
        >
          {/* Dot pattern */}
          <div className="absolute inset-0 opacity-20 pointer-events-none"
            style={{ backgroundImage: "radial-gradient(circle at 1px 1px, rgba(180,130,0,0.2) 1px, transparent 0)", backgroundSize: "28px 28px" }} />

          {/* Task name */}
          <div className="mb-8 text-center px-8 relative z-10">
            <p className="text-xs font-mono text-amber-500/80 uppercase tracking-widest mb-3">Сейчас в фокусе</p>
            <h2 className="text-3xl font-bold text-slate-800 max-w-lg leading-tight">
              {focusOverlay.selectedTask?.title || "Свободный фокус"}
            </h2>
            {focusOverlay.selectedTask && (
              <div className="flex items-center justify-center gap-2 mt-3">
                <div className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: focusOverlay.catColor }} />
                <span className="text-sm text-slate-500">{focusOverlay.selectedTask.category}</span>
              </div>
            )}
          </div>

          {/* Ring timer */}
          <div className="relative flex items-center justify-center w-72 h-72 relative z-10">
            <svg width="288" height="288" className="-rotate-90">
              <circle cx="144" cy="144" r="128" fill="none" stroke="#fde68a" strokeWidth="10" />
              <circle
                cx="144" cy="144" r="128"
                fill="none"
                stroke={focusOverlay.finished ? "#10b981" : "#f59e0b"}
                strokeWidth="10"
                strokeLinecap="round"
                strokeDasharray={2 * Math.PI * 128}
                strokeDashoffset={2 * Math.PI * 128 - (focusOverlay.pct / 100) * 2 * Math.PI * 128}
                style={{ transition: "stroke-dashoffset 0.9s linear, stroke 0.5s" }}
              />
            </svg>
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2">
              <span
                className="text-7xl font-bold tabular-nums"
                style={{ color: focusOverlay.finished ? "#10b981" : "#1e293b" }}
              >
                {focusOverlay.mins}:{focusOverlay.secs}
              </span>
              <span className="text-slate-400 text-base font-mono tracking-widest uppercase text-sm">
                {focusOverlay.finished ? "готово!" : focusOverlay.running ? "фокус" : "пауза"}
              </span>
            </div>
          </div>

          {/* Controls */}
          <div className="flex items-center gap-5 mt-10 relative z-10">
            {!focusOverlay.finished ? (
              <>
                <button
                  onClick={focusOverlay.onReset}
                  className="w-14 h-14 rounded-full border-2 border-slate-300 text-slate-400 hover:border-amber-400 hover:text-amber-500 transition-all flex items-center justify-center text-xl"
                >↺</button>
                <button
                  onClick={focusOverlay.running ? focusOverlay.onPause : focusOverlay.onStart}
                  className="w-24 h-24 rounded-full text-3xl font-bold transition-all flex items-center justify-center shadow-2xl"
                  style={{ background: "#f59e0b", color: "#1c1917", boxShadow: "0 12px 40px rgba(245,158,11,0.4)" }}
                >
                  {focusOverlay.running ? "⏸" : "▶"}
                </button>
                <button
                  onClick={focusOverlay.onExit}
                  className="w-14 h-14 rounded-full border-2 border-slate-300 text-slate-400 hover:border-amber-400 hover:text-amber-500 transition-all flex items-center justify-center text-xl"
                >↙</button>
              </>
            ) : (
              <div className="flex flex-col items-center gap-4">
                <p className="text-slate-600 text-lg text-center">Время вышло! Задача выполнена?</p>
                <div className="flex gap-3">
                  <button onClick={focusOverlay.onComplete}
                    className="px-8 py-3 rounded-xl bg-emerald-500 text-white font-semibold hover:bg-emerald-400 transition-colors shadow-lg text-base">
                    ✓ Да, выполнено
                  </button>
                  <button onClick={focusOverlay.onReset}
                    className="px-8 py-3 rounded-xl border-2 border-slate-300 text-slate-600 font-semibold hover:bg-white transition-colors text-base">
                    Продолжить
                  </button>
                </div>
              </div>
            )}
          </div>

          {focusOverlay.running && (
            <p className="absolute bottom-10 text-slate-400/50 text-sm font-mono italic">
              не отвлекайся — ты в потоке ✦
            </p>
          )}
        </div>
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
