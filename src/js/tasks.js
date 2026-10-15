/**
 * tasks.js — the to-do list
 * ============================================================================
 * Rules:
 *   • only ONE task can be active (the star); starring one clears the others
 *   • completing a task clears its active status
 *   • order: active first, then open, then done (oldest first in each group)
 *   • every change is saved immediately
 */

'use strict';

const Tasks = (() => {
  let el = null;

  // Why: "the" task you're working on; done tasks can never be active.
  function active() {
    return Store.data.tasks.find((task) => task.active && !task.done) || null;
  }

  function find(id) {
    return Store.data.tasks.find((task) => task.id === id);
  }

  function sorted() {
    const rank = (task) => (task.active ? 0 : task.done ? 2 : 1);
    return [...Store.data.tasks].sort((a, b) => rank(a) - rank(b) || a.createdAt - b.createdAt);
  }

  // Why: every change must save, redraw the list AND update the taskbar
  // button / Focus page. Funnelling changes through here makes forgetting
  // one of them impossible.
  function changed() {
    Store.persist('tasks');
    render();
    Timer.render();
  }

  function add(text) {
    const clean = text.trim().slice(0, 200);
    if (!clean) return;
    Store.data.tasks.push({ id: newId(), text: clean, done: false, active: false, pomos: 0, createdAt: Date.now() });
    changed();
  }

  function toggleDone(id) {
    const task = find(id);
    if (!task) return;
    task.done = !task.done;
    if (task.done) task.active = false;
    changed();
  }

  // Why: the star is a toggle; starring a finished task re-opens it.
  function toggleActive(id) {
    const task = find(id);
    if (!task) return;
    const makeActive = !task.active;
    for (const other of Store.data.tasks) other.active = false;
    if (makeActive) {
      task.active = true;
      task.done = false;
      Timer.resetReminderClock();
    }
    changed();
  }

  function remove(id) {
    Store.data.tasks = Store.data.tasks.filter((task) => task.id !== id);
    changed();
  }

  // Why: called by the timer when a focus session ends.
  function addPomodoro() {
    const task = active();
    if (!task) return;
    task.pomos += 1;
    Store.persist('tasks');
    render();
  }

  // Why: one row, built with h() so task.text is always plain text.
  function row(task) {
    return h(
      'li',
      { class: `task${task.done ? ' done' : ''}${task.active ? ' active' : ''}` },
      h('input', {
        type: 'checkbox',
        class: 'check',
        checked: task.done,
        title: task.done ? 'Mark as not done' : 'Mark as done',
        'aria-label': `Done: ${task.text}`,
        onchange: () => toggleDone(task.id),
      }),
      h('span', { class: 'task-text', title: task.text }, task.text),
      task.pomos > 0 ? h('span', { class: 'task-pomos', title: `${task.pomos} focus sessions` }, `🍅 ${task.pomos}`) : null,
      h(
        'button',
        {
          class: `btn-icon star${task.active ? ' on' : ''}`,
          title: task.active ? 'Active task (click to clear)' : 'Make this the active task',
          'aria-label': task.active ? 'Clear active task' : 'Make active',
          onclick: () => toggleActive(task.id),
        },
        icon(task.active ? 'star-fill' : 'star'),
      ),
      h(
        'button',
        { class: 'btn-icon del', title: 'Delete task', 'aria-label': 'Delete task', onclick: () => remove(task.id) },
        icon('bin'),
      ),
    );
  }

  // Why: a full redraw is simplest and plenty fast for a personal list.
  function render() {
    const list = sorted();
    el.list.replaceChildren(...list.map(row));
    el.empty.hidden = list.length > 0;
    const open = Store.data.tasks.filter((task) => !task.done).length;
    const done = Store.data.tasks.length - open;
    el.summary.textContent = list.length ? `${open} open · ${done} done` : '';
  }

  function init() {
    el = {
      form: $('taskForm'),
      input: $('taskInput'),
      list: $('taskList'),
      empty: $('taskEmpty'),
      summary: $('taskSummary'),
    };
    // Enter submits the form, which is the "add" action.
    el.form.addEventListener('submit', (event) => {
      event.preventDefault();
      add(el.input.value);
      el.input.value = '';
    });
    render();
  }

  return { init, active, render, addPomodoro };
})();
