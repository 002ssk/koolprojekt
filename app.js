'use strict';

const STORAGE_KEY = 'opirahu.studyPlanner.v1';
const DEFAULT_TIMER = { mode: 'work', remaining: 25 * 60, running: false, endAt: null, taskId: '' };
const priorityLabels = { low: 'Madal', medium: 'Keskmine', high: 'Kõrge' };
const priorityOrder = { high: 0, medium: 1, low: 2 };
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

function todayKey(date = new Date()) {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}
function loadState() {
  const fallback = { tasks: [], sessions: [], timer: { ...DEFAULT_TIMER } };
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    if (!parsed) return fallback;
    return {
      tasks: Array.isArray(parsed.tasks) ? parsed.tasks.filter(task => task && typeof task.id === 'string' && typeof task.title === 'string' && typeof task.subject === 'string' && typeof task.dueDate === 'string') : [],
      sessions: Array.isArray(parsed.sessions) ? parsed.sessions.filter(session => session && typeof session.completedAt === 'string' && Number.isFinite(session.minutes)) : [],
      timer: parsed.timer && typeof parsed.timer === 'object' ? { ...DEFAULT_TIMER, ...parsed.timer, running: Boolean(parsed.timer.running) } : { ...DEFAULT_TIMER }
    };
  } catch (error) {
    console.error('Õpiandmete laadimine ebaõnnestus:', error);
    return fallback;
  }
}
let state = loadState();
let activeFilter = 'all';
let searchQuery = '';
let toastTimeout;
let timerInterval = null;
let audioContext;
function saveState() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }
  catch (error) { console.error('Õpiandmete salvestamine ebaõnnestus:', error); showToast('Andmeid ei saanud salvestada. Kontrolli brauseri salvestusruumi.'); }
}
function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}
function formatDate(dateValue, options = { day: 'numeric', month: 'short' }) {
  const date = new Date(`${dateValue}T12:00:00`);
  return Number.isNaN(date.getTime()) ? 'Kuupäev puudub' : new Intl.DateTimeFormat('et-EE', options).format(date);
}
function getWeekBounds() {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  start.setDate(start.getDate() - (start.getDay() + 6) % 7);
  const end = new Date(start);
  end.setDate(end.getDate() + 6);
  return { start: todayKey(start), end: todayKey(end) };
}
function taskIsDueThisWeek(task, bounds = getWeekBounds()) { return task.dueDate >= bounds.start && task.dueDate <= bounds.end; }
function setProgress(fill, percentage) { $(fill).style.width = `${Math.max(0, Math.min(100, percentage))}%`; }
function renderHeader() {
  const now = new Date();
  $('#top-date').textContent = new Intl.DateTimeFormat('et-EE', { weekday: 'long', day: 'numeric', month: 'long' }).format(now);
  $('#planner-date').textContent = new Intl.DateTimeFormat('et-EE', { day: 'numeric', month: 'short' }).format(now);
}
function renderStats() {
  const today = todayKey(), bounds = getWeekBounds();
  const todayTasks = state.tasks.filter(task => task.dueDate === today);
  const weekTasks = state.tasks.filter(task => taskIsDueThisWeek(task, bounds));
  const todayDone = todayTasks.filter(task => task.completed).length;
  const weekDone = weekTasks.filter(task => task.completed).length;
  const weekSessions = state.sessions.filter(session => session.completedAt >= bounds.start && session.completedAt <= bounds.end);
  const focusedMinutes = weekSessions.reduce((sum, session) => sum + session.minutes, 0);
  const todayPercent = todayTasks.length ? Math.round(todayDone / todayTasks.length * 100) : 0;
  const weekPercent = weekTasks.length ? Math.round(weekDone / weekTasks.length * 100) : 0;
  $('#stat-total').textContent = state.tasks.length;
  $('#stat-open').textContent = `${state.tasks.filter(task => !task.completed).length} ootel`;
  $('#stat-hours').textContent = (focusedMinutes / 60).toFixed(focusedMinutes % 60 === 0 ? 0 : 1).replace('.', ',');
  $('#stat-minutes').textContent = `${focusedMinutes} min`;
  $('#stat-week').textContent = `${weekPercent}%`;
  $('#stat-week-done').textContent = `${weekDone} ülesannet tehtud`;
  $('#nav-task-count').textContent = state.tasks.filter(task => !task.completed).length;
  $('#task-total-badge').textContent = state.tasks.length;
  $('#today-fraction').textContent = `${todayDone} / ${todayTasks.length}`;
  $('#week-fraction').textContent = `${weekDone} / ${weekTasks.length}`;
  $('#today-percent').textContent = `${todayPercent}%`;
  $('#week-percent').textContent = `${weekPercent}%`;
  setProgress('#today-progress', todayPercent); setProgress('#week-progress', weekPercent);
  $('#today-progress-copy').textContent = todayTasks.length ? (todayPercent === 100 ? 'Kõik tänased ülesanded tehtud!' : `${todayTasks.length - todayDone} ülesannet veel`) : 'Alusta oma esimesest ülesandest';
  $('#week-progress-copy').textContent = weekTasks.length ? (weekPercent === 100 ? 'Nädala eesmärk täidetud!' : 'Iga samm loeb') : 'Iga samm loeb';
  $('#motivation').textContent = todayPercent === 100 && todayTasks.length ? 'Suurepärane! Tänane eesmärk on täidetud. Naudi oma saavutust.' : 'Iga väike samm viib sind eesmärgile lähemale.';
  $('#filter-all-count').textContent = state.tasks.length;
  $('#filter-open-count').textContent = state.tasks.filter(task => !task.completed).length;
  $('#filter-done-count').textContent = state.tasks.filter(task => task.completed).length;
}
function taskMatchesFilter(task) {
  if (activeFilter === 'open' && task.completed) return false;
  if (activeFilter === 'done' && !task.completed) return false;
  return !searchQuery || `${task.title} ${task.subject} ${task.type}`.toLocaleLowerCase('et-EE').includes(searchQuery.toLocaleLowerCase('et-EE'));
}
function renderTasks() {
  const visible = state.tasks.filter(taskMatchesFilter).sort((a, b) => Number(a.completed) - Number(b.completed) || a.dueDate.localeCompare(b.dueDate) || (priorityOrder[a.priority] ?? 1) - (priorityOrder[b.priority] ?? 1));
  const list = $('#task-list');
  if (!visible.length) {
    const hasTasks = state.tasks.length > 0;
    list.innerHTML = `<div class="empty-state"><strong>${hasTasks ? 'Sobivaid ülesandeid ei leitud' : 'Sinu õpilaud on tühi'}</strong>${hasTasks ? 'Proovi teist otsingusõna või filtrit.' : 'Lisa esimene ülesanne ja teeme plaani koos.'}</div>`;
    return;
  }
  list.innerHTML = visible.map(task => {
    const dueText = task.dueDate === todayKey() ? 'Täna' : formatDate(task.dueDate);
    const remaining = Math.max(0, (Number(task.estimate) || 0) - (Number(task.focusedMinutes) || 0));
    return `<div class="task-row${task.completed ? ' is-done' : ''}">
      <input class="task-check" type="checkbox" data-action="toggle" data-id="${escapeHtml(task.id)}" aria-label="Märgi ülesanne ${escapeHtml(task.title)} ${task.completed ? 'tegemata' : 'tehtuks'}" ${task.completed ? 'checked' : ''}>
      <div class="task-main"><span class="task-title" title="${escapeHtml(task.title)}">${escapeHtml(task.title)}</span><div class="task-meta"><span class="task-subject">${escapeHtml(task.subject)}</span><span class="meta-separator">·</span><span>${escapeHtml(task.type)}</span><span class="meta-separator">·</span><span>${remaining ? `${remaining} min` : 'Valmis'}</span><span class="meta-separator">·</span><span>${dueText}</span></div></div>
      <span class="priority ${escapeHtml(task.priority)}">${priorityLabels[task.priority] || 'Keskmine'}</span>
      <button class="task-delete" type="button" data-action="delete" data-id="${escapeHtml(task.id)}" aria-label="Kustuta ülesanne ${escapeHtml(task.title)}" title="Kustuta ülesanne"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16m-10 4v6m4-6v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg></button>
    </div>`;
  }).join('');
}
function compareTasks(a, b) {
  return a.dueDate.localeCompare(b.dueDate) || (priorityOrder[a.priority] ?? 1) - (priorityOrder[b.priority] ?? 1) || a.title.localeCompare(b.title, 'et');
}
function renderPlanner() {
  const pending = state.tasks.filter(task => !task.completed).sort(compareTasks);
  const selected = [];
  let capacity = 180;
  for (const task of pending) {
    if (capacity <= 0) break;
    const remaining = Math.max(0, Number(task.estimate) - (Number(task.focusedMinutes) || 0));
    if (!remaining) continue;
    const minutes = Math.min(remaining, capacity);
    selected.push({ task, minutes });
    capacity -= minutes;
  }
  const schedule = $('#schedule-list');
  if (!selected.length) {
    schedule.innerHTML = `<div class="planner-empty"><strong>${pending.length ? 'Tubli, kõik on kontrolli all!' : 'Sinu päev on vaba'}</strong>${pending.length ? 'Kõik ülesanded on juba valmis või ootel.' : 'Lisa ülesanne, et luua endale rahulik õppeplaan.'}</div>`;
    $('#planner-total').textContent = '0 min planeeritud';
    return;
  }
  let startMinute = 9 * 60;
  schedule.innerHTML = selected.map(({ task, minutes }) => {
    const start = `${String(Math.floor(startMinute / 60)).padStart(2, '0')}:${String(startMinute % 60).padStart(2, '0')}`;
    const endMinute = startMinute + minutes;
    const end = `${String(Math.floor(endMinute / 60)).padStart(2, '0')}:${String(endMinute % 60).padStart(2, '0')}`;
    startMinute = endMinute + 10;
    const due = task.dueDate === todayKey() ? 'Tähtaeg täna' : `Tähtaeg ${formatDate(task.dueDate)}`;
    return `<div class="schedule-item"><span class="schedule-time">${start}</span><span class="schedule-track"><span class="schedule-marker"></span></span><div class="schedule-card"><strong title="${escapeHtml(task.title)}">${escapeHtml(task.title)}</strong><span>${escapeHtml(task.subject)} · ${minutes} min · ${start}–${end} <span class="schedule-due">${due}</span></span></div></div>`;
  }).join('');
  $('#planner-total').textContent = `${selected.reduce((sum, item) => sum + item.minutes, 0)} min planeeritud`;
}
function renderTimerSelect() {
  const select = $('#timer-task');
  const current = select.value || state.timer.taskId || '';
  const pending = state.tasks.filter(task => !task.completed).sort(compareTasks);
  select.innerHTML = '<option value="">Vali ülesanne...</option>' + pending.map(task => `<option value="${escapeHtml(task.id)}">${escapeHtml(task.subject)} — ${escapeHtml(task.title)}</option>`).join('');
  if (pending.some(task => task.id === current)) select.value = current;
  else { select.value = ''; state.timer.taskId = ''; }
}
function renderTimer() {
  const timer = state.timer;
  const duration = timer.mode === 'work' ? 1500 : 300;
  const remaining = Math.max(0, Math.min(duration, Number(timer.remaining) || duration));
  $('#timer-display').textContent = `${String(Math.floor(remaining / 60)).padStart(2, '0')}:${String(remaining % 60).padStart(2, '0')}`;
  $('#timer-mode-label').textContent = timer.mode === 'work' ? 'ÕPPIMINE' : 'PAUS';
  $('#timer-mode-label').classList.toggle('break', timer.mode === 'break');
  $('#timer-ring-progress').classList.toggle('break', timer.mode === 'break');
  $('#timer-subtitle').textContent = timer.mode === 'work' ? 'aega keskendumiseks' : 'aega puhkamiseks';
  $('#timer-start').textContent = timer.running ? 'Peata taimer' : timer.mode === 'work' ? 'Alusta fookust' : 'Alusta pausi';
  const circumference = 2 * Math.PI * 78;
  $('#timer-ring-progress').style.strokeDasharray = circumference;
  $('#timer-ring-progress').style.strokeDashoffset = circumference * (1 - remaining / duration);
  $('#timer-task').disabled = timer.running && timer.mode === 'work';
}
function renderAll() { renderHeader(); renderStats(); renderTasks(); renderPlanner(); renderTimerSelect(); renderTimer(); }
function showToast(message) {
  const toast = $('#toast');
  toast.textContent = message;
  toast.classList.add('visible');
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => toast.classList.remove('visible'), 2800);
}
function openTaskForm() {
  const form = $('#task-form');
  form.hidden = false;
  form.querySelector('[name="dueDate"]').value = todayKey();
  form.querySelector('[name="title"]').focus();
}
function closeTaskForm() { $('#task-form').hidden = true; $('#task-form').reset(); }
function handleTaskSubmit(event) {
  event.preventDefault();
  const form = event.currentTarget;
  if (!form.reportValidity()) return;
  const values = new FormData(form);
  const task = {
    id: globalThis.crypto?.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    title: String(values.get('title')).trim(), subject: String(values.get('subject')).trim(), type: String(values.get('type')),
    dueDate: String(values.get('dueDate')), priority: String(values.get('priority')),
    estimate: Math.max(5, Number(values.get('estimate'))), focusedMinutes: 0, completed: false,
    createdAt: new Date().toISOString(), completedAt: null
  };
  if (!task.title || !task.subject) return;
  state.tasks.push(task);
  saveState(); closeTaskForm(); renderAll();
  showToast('Ülesanne lisatud. Sinu plaan on uuendatud!');
}
function handleTaskAction(event) {
  const target = event.target.closest('[data-action]');
  if (!target) return;
  const task = state.tasks.find(item => item.id === target.dataset.id);
  if (!task) return;
  if (target.dataset.action === 'toggle') {
    task.completed = target.checked;
    task.completedAt = task.completed ? new Date().toISOString() : null;
    saveState(); renderAll(); showToast(task.completed ? 'Tubli! Ülesanne märgitud tehtuks.' : 'Ülesanne märgitud tegemata.');
  } else if (target.dataset.action === 'delete') {
    state.tasks = state.tasks.filter(item => item.id !== task.id);
    if (state.timer.taskId === task.id) state.timer.taskId = '';
    saveState(); renderAll(); showToast('Ülesanne kustutatud.');
  }
}
function playCompletionTone() {
  try {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return;
    audioContext = audioContext || new AudioContextClass();
    if (audioContext.state === 'suspended') audioContext.resume();
    const oscillator = audioContext.createOscillator(), gain = audioContext.createGain();
    oscillator.type = 'sine';
    oscillator.frequency.setValueAtTime(660, audioContext.currentTime);
    oscillator.frequency.setValueAtTime(880, audioContext.currentTime + .12);
    gain.gain.setValueAtTime(.0001, audioContext.currentTime);
    gain.gain.exponentialRampToValueAtTime(.12, audioContext.currentTime + .02);
    gain.gain.exponentialRampToValueAtTime(.0001, audioContext.currentTime + .4);
    oscillator.connect(gain); gain.connect(audioContext.destination);
    oscillator.start(); oscillator.stop(audioContext.currentTime + .42);
  } catch (error) { console.warn('Taimeri helimärguannet ei saanud esitada:', error); }
}
function completeTimerPhase() {
  const wasWork = state.timer.mode === 'work';
  if (wasWork) {
    const task = state.tasks.find(item => item.id === state.timer.taskId && !item.completed);
    if (task) task.focusedMinutes = (Number(task.focusedMinutes) || 0) + 25;
    state.sessions.push({ completedAt: todayKey(), minutes: 25, taskId: task?.id || null });
    if (state.sessions.length > 500) state.sessions.splice(0, state.sessions.length - 500);
    state.timer.mode = 'break'; state.timer.remaining = 300;
    showToast(task ? 'Fookussessioon tehtud! Aeg väikeseks pausiks.' : 'Fookussessioon tehtud! Võta 5 minutit pausi.');
  } else {
    state.timer.mode = 'work'; state.timer.remaining = 1500;
    showToast('Paus läbi. Kui oled valmis, alusta järgmist fookust.');
  }
  state.timer.running = false; state.timer.endAt = null;
  clearInterval(timerInterval); timerInterval = null;
  playCompletionTone(); saveState(); renderAll();
}
function updateTimerTick() {
  if (!state.timer.running || !state.timer.endAt) return;
  state.timer.remaining = Math.max(0, Math.ceil((state.timer.endAt - Date.now()) / 1000));
  if (state.timer.remaining <= 0) { completeTimerPhase(); return; }
  renderTimer();
}
function startTimer() {
  if (state.timer.running) {
    state.timer.remaining = Math.max(0, Math.ceil((state.timer.endAt - Date.now()) / 1000));
    state.timer.running = false; state.timer.endAt = null;
    clearInterval(timerInterval); timerInterval = null; saveState(); renderTimer(); return;
  }
  if (state.timer.remaining <= 0) state.timer.remaining = state.timer.mode === 'work' ? 1500 : 300;
  state.timer.taskId = $('#timer-task').value;
  state.timer.running = true; state.timer.endAt = Date.now() + state.timer.remaining * 1000;
  saveState(); clearInterval(timerInterval); timerInterval = setInterval(updateTimerTick, 250); renderTimer();
}
function resetTimer() {
  clearInterval(timerInterval); timerInterval = null;
  state.timer = { ...DEFAULT_TIMER, taskId: $('#timer-task').value };
  saveState(); renderTimer(); showToast('Taimer lähtestatud.');
}
function initialize() {
  renderAll();
  $('#add-task-shortcut').addEventListener('click', () => { openTaskForm(); $('#tasks').scrollIntoView({ behavior: 'smooth', block: 'start' }); });
  $('#add-task-button').addEventListener('click', openTaskForm);
  $('#close-form').addEventListener('click', closeTaskForm);
  $('#cancel-form').addEventListener('click', closeTaskForm);
  $('#task-form').addEventListener('submit', handleTaskSubmit);
  $('#task-list').addEventListener('change', handleTaskAction);
  $('#task-list').addEventListener('click', handleTaskAction);
  $('#task-search').addEventListener('input', event => { searchQuery = event.target.value.trim(); renderTasks(); });
  $$('.filter-tab').forEach(button => button.addEventListener('click', () => {
    activeFilter = button.dataset.filter;
    $$('.filter-tab').forEach(tab => tab.classList.toggle('selected', tab === button));
    renderTasks();
  }));
  $('#timer-task').addEventListener('change', event => { state.timer.taskId = event.target.value; saveState(); });
  $('#timer-start').addEventListener('click', startTimer);
  $('#timer-reset').addEventListener('click', resetTimer);
  if (state.timer.running) {
    const phaseDuration = state.timer.mode === 'work' ? 1500 : 300;
    if (!Number.isFinite(Number(state.timer.endAt))) {
      state.timer.running = false; state.timer.endAt = null; state.timer.remaining = phaseDuration; saveState(); renderTimer();
    } else if (state.timer.endAt <= Date.now()) completeTimerPhase();
    else { updateTimerTick(); timerInterval = setInterval(updateTimerTick, 250); }
  }
  setInterval(() => {
    const actualDate = new Intl.DateTimeFormat('et-EE', { weekday: 'long', day: 'numeric', month: 'long' }).format(new Date());
    if ($('#top-date').textContent !== actualDate) renderAll();
  }, 60_000);
}
initialize();
