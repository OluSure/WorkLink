import FBService, { isReady as fbIsReady, FB as FBGetter } from './firebase';

// Local storage helpers
function read(key, fallback) { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } }
function write(key, val) { localStorage.setItem(key, JSON.stringify(val)); }

if (!read('lh_users', null)) write('lh_users', []);
if (!read('lh_tasks', null)) write('lh_tasks', []);
if (!read('lh_applications', null)) write('lh_applications', []);
if (!read('lh_messages', null)) write('lh_messages', []);
if (!read('lh_payments', null)) write('lh_payments', []);

async function hashPassword(pw) {
  const enc = new TextEncoder();
  const buf = await crypto.subtle.digest('SHA-256', enc.encode(pw));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function allUsers() { return read('lh_users', []); }
function saveUsers(u) { write('lh_users', u); }
function findUserByUsername(username) { return allUsers().find(x => x.username === username); }

async function findUserByUsernameAsync(username) {
  const waitForFB = async (timeoutMs = 3000) => {
    const start = Date.now();
    while (!(window.__FB_READY__ && window.FB && window.FB.available) && Date.now() - start < timeoutMs) {
      await new Promise(r => setTimeout(r, 100));
    }
  };

  try {
    await waitForFB(3000);
    if (fbIsReady()) {
      try {
        const results = await FBGetter().queryEqual('lh_users', 'username', username);
        if (results && results.length > 0) return results[0];
      } catch (e) { console.warn('Failed to fetch user from Firestore', e); }
    }
  } catch (e) { /* ignore wait errors */ }
  return findUserByUsername(username);
}


async function createUser(username, password, displayName, email) {
  if (!username || !password) return { ok: false, message: 'Username and password required' };
  if (fbIsReady()) {
    const existing = await FBGetter().queryEqual('lh_users', 'username', username);
    if (existing && existing.length > 0) return { ok: false, message: 'Username already taken' };
    const hash = await hashPassword(password);
    const user = { username, passwordHash: hash, name: displayName || username, email: email || username, bio: '', avatar: '' };
    const added = await FBGetter().add('lh_users', user);
    try { const lu = allUsers(); lu.push(user); saveUsers(lu); } catch (e) { }
    return { ok: true, user };
  }
  if (findUserByUsername(username)) return { ok: false, message: 'Username already taken' };
  const hash = await hashPassword(password);
  const user = { username, passwordHash: hash, name: displayName, email: email || username, bio: '', avatar: '' };
  const u = allUsers(); u.push(user); saveUsers(u);
  return { ok: true, user };
}

async function signInUser(username, password) {
  if (fbIsReady()) {
    const users = await FBGetter().queryEqual('lh_users', 'username', username);
    const user = (users && users.length > 0) ? users[0] : null;
    if (!user) return { ok: false, message: 'No such user' };
    const hash = await hashPassword(password);
    if (hash !== user.passwordHash) return { ok: false, message: 'Invalid credentials' };
    try { write('lh_currentUser', { username: user.username, name: user.name }); } catch (e) { }
    try { await FBGetter().add('sessions', { username: user.username, createdAt: new Date().toISOString() }); } catch (e) { }
    return { ok: true, user };
  }
  const user = findUserByUsername(username);
  if (!user) return { ok: false, message: 'No such user' };
  const hash = await hashPassword(password);
  if (hash !== user.passwordHash) return { ok: false, message: 'Invalid credentials' };
  write('lh_currentUser', { username: user.username, name: user.name });
  return { ok: true, user };
}

function currentUser() { return read('lh_currentUser', null); }
function signOut() { localStorage.removeItem('lh_currentUser'); }

// Tasks
let __CACHED_REMOTE_TASKS__ = null;
function allTasksLocal() { return read('lh_tasks', []); }
async function allTasks() {
  if (__CACHED_REMOTE_TASKS__ !== null) return __CACHED_REMOTE_TASKS__;
  if (fbIsReady()) {
    try {
      const remote = await FBGetter().getAll('lh_tasks');
      if (remote && Array.isArray(remote)) {
        const mapped = remote.map(r => {
          const obj = Object.assign({}, r);
          if (!obj.id) obj.id = obj.localId || obj._id || Date.now();
          return obj;
        });
        __CACHED_REMOTE_TASKS__ = mapped;
        write('lh_tasks', mapped);
        return mapped;
      }
    } catch (e) { console.warn('Failed to fetch tasks from Firestore', e); }
  }
  return allTasksLocal();
}
function saveTasks(tasks) { write('lh_tasks', tasks); __CACHED_REMOTE_TASKS__ = tasks; }
function isFirestoreReady() { return fbIsReady(); }

async function addTask(task) {
  const tasks = allTasksLocal();
  task.id = Date.now();
  task.createdAt = new Date().toISOString();
  task.applications = [];
  tasks.unshift(task);
  saveTasks(tasks);
  if (isFirestoreReady()) {
    try {
      const payload = Object.assign({}, task, { localId: task.id });
      const remote = await FBGetter().add('lh_tasks', payload);
      task._remoteId = remote && remote._id ? remote._id : null;
      saveTasks(allTasksLocal());
    } catch (e) { console.error('Failed to sync task to Firestore', e); }
  }
  return task;
}

async function updateTask(updated) {
  const tasks = allTasksLocal().map(t => t.id === updated.id ? updated : t);
  saveTasks(tasks);
  if (isFirestoreReady()) {
    try {
      const rem = await FBGetter().queryEqual('lh_tasks', 'localId', updated.id);
      if (rem && rem.length > 0) {
        await FBGetter().set('lh_tasks', rem[0]._id, Object.assign({}, updated, { localId: updated.id }));
      } else {
        await FBGetter().add('lh_tasks', Object.assign({}, updated, { localId: updated.id }));
      }
    } catch (e) { console.error('Failed to update task in Firestore', e); }
  }
  return updated;
}

async function removeTask(id) {
  const tasks = allTasksLocal().filter(t => t.id !== id);
  saveTasks(tasks);
  // Clear remote cache so next read fetches fresh data from Firestore
  __CACHED_REMOTE_TASKS__ = null;
  if (isFirestoreReady()) {
    try {
      const rem = await FBGetter().queryEqual('lh_tasks', 'localId', id);
      if (rem && rem.length > 0) await FBGetter().delete('lh_tasks', rem[0]._id);
    } catch (e) { console.error('Failed to remove task from Firestore', e); }
  }
}

// Applications
let __CACHED_REMOTE_APPLICATIONS__ = null;
function allApplicationsLocal() { return read('lh_applications', []); }
async function allApplications() {
  if (__CACHED_REMOTE_APPLICATIONS__ !== null) return __CACHED_REMOTE_APPLICATIONS__;
  if (isFirestoreReady()) {
    try {
      const remote = await FBGetter().getAll('lh_applications');
      if (remote && Array.isArray(remote)) {
        const mapped = remote.map(r => {
          const obj = Object.assign({}, r);
          if (!obj.id) obj.id = obj.localId || obj._id || Date.now();
          return obj;
        });
        __CACHED_REMOTE_APPLICATIONS__ = mapped;
        write('lh_applications', mapped);
        return mapped;
      }
    } catch (e) { console.warn('Failed to fetch applications from Firestore', e); }
  }
  return allApplicationsLocal();
}
function saveApplications(a) { write('lh_applications', a); __CACHED_REMOTE_APPLICATIONS__ = a; }

async function addApplication(app) {
  const apps = allApplicationsLocal();
  app.id = Date.now() + Math.floor(Math.random() * 999);
  app.taskId = Number(app.taskId);
  app.createdAt = new Date().toISOString();
  apps.push(app); saveApplications(apps);
  if (isFirestoreReady()) {
    try { const payload = Object.assign({}, app, { localId: app.id }); await FBGetter().add('lh_applications', payload); } catch (e) { console.error('Failed to sync application to Firestore', e); }
  }
  return app;
}

async function updateApplication(id, updates) {
  const apps = allApplicationsLocal().map(a => a.id === id ? Object.assign({}, a, updates) : a);
  saveApplications(apps);
  if (isFirestoreReady()) {
    try {
      const rem = await FBGetter().queryEqual('lh_applications', 'localId', id);
      if (rem && rem.length > 0) await FBGetter().set('lh_applications', rem[0]._id, Object.assign({}, updates, { localId: id }));
      else await FBGetter().add('lh_applications', Object.assign({}, updates, { localId: id }));
    } catch (e) { console.error('Failed to sync application update to Firestore', e); }
  }
  if (updates.status === 'accepted') {
    const app = apps.find(a => a.id === id);
    if (app) {
      const tasks = allTasksLocal();
      const task = tasks.find(t => t.id === app.taskId);
      if (task) {
        task.assignedTo = app.applicant; task.status = 'assigned'; await updateTask(task);
      }
    }
  }
  const app = allApplicationsLocal().find(a => a.id === id);
  if (app) {
    const task = allTasksLocal().find(t => t.id === app.taskId);
    const title = task ? (task.title || ('#' + task.id)) : ('#' + app.taskId);
    const text = updates.status === 'accepted' ? `Your application for \"${title}\" was accepted.` : `Your application for \"${title}\" was rejected.`;
    await sendMessage(currentUser().username, app.applicant, text);
  }
  return apps.find(a => a.id === id);
}

// Messages
function allMessages() { return read('lh_messages', []); }
function saveMessages(m) { write('lh_messages', m); }
async function sendMessage(from, to, content) {
  const msgs = allMessages();
  const msg = { id: Date.now() + Math.floor(Math.random() * 99), from, to, content, createdAt: new Date().toISOString() };
  msgs.push(msg); saveMessages(msgs);
  if (isFirestoreReady()) {
    try { await FBGetter().add('lh_messages', Object.assign({}, msg, { localId: msg.id })); } catch (e) { console.error('Failed to sync message to Firestore', e); }
  }
  return msg;
}

// Payments
function allPayments() { return read('lh_payments', []); }
function savePayments(p) { write('lh_payments', p); }
async function createPayment(taskId, fromUser, toUser, amount) {
  const payments = allPayments();
  const p = { id: Date.now() + Math.floor(Math.random() * 999), taskId, from: fromUser, to: toUser, amount, status: 'completed', createdAt: new Date().toISOString() };
  payments.push(p); savePayments(payments);
  if (isFirestoreReady()) {
    try { await FBGetter().add('lh_payments', Object.assign({}, p, { localId: p.id })); } catch (e) { console.error('Failed to sync payment to Firestore', e); }
  }
  return p;
}

// User updates and permits
function updateUser(updated) { const users = allUsers(); const idx = users.findIndex(u => u.username === updated.username); if (idx === -1) return null; users[idx] = Object.assign({}, users[idx], updated); saveUsers(users); return users[idx]; }

async function purchasePermit(username, count) { count = Number(count) || 1; const users = allUsers(); const idx = users.findIndex(u => u.username === username); if (idx === -1) return null; users[idx].permits = (users[idx].permits || 0) + count; saveUsers(users); try { await createPayment(null, username, 'platform', 100 * count); } catch (e) { console.error('Failed to record payment', e); } if (isFirestoreReady()) { try { const rem = await FBGetter().queryEqual('lh_users', 'username', username); const payload = Object.assign({}, users[idx]); if (rem && rem.length > 0) await FBGetter().set('lh_users', rem[0]._id, payload); else await FBGetter().add('lh_users', payload); } catch (e) { console.error('Failed to sync user permit to Firestore', e); } } return users[idx]; }

function hasPermit(username) { const u = findUserByUsername(username); if (!u) return false; if (!u.freePermitUsed) return true; if ((u.permits || 0) > 0) return true; return false; }
function consumePermit(username) { const users = allUsers(); const idx = users.findIndex(u => u.username === username); if (idx === -1) return false; if (!users[idx].freePermitUsed) { users[idx].freePermitUsed = true; saveUsers(users); return true; } if ((users[idx].permits || 0) > 0) { users[idx].permits = (users[idx].permits || 0) - 1; saveUsers(users); return true; } return false; }

async function applyToTask(app) { if (!app || !app.applicant) return { ok: false, message: 'Invalid application' }; if (!hasPermit(app.applicant)) return { ok: false, message: 'No permit available', code: 'no_permit' }; const consumed = consumePermit(app.applicant); if (!consumed) return { ok: false, message: 'Unable to consume permit' }; const created = await addApplication(app); return { ok: true, app: created }; }

// Background sync: push local items to Firestore when available
async function syncLocalToFirestore() {
  if (!fbIsReady()) return;
  const collections = [
    { key: 'lh_tasks', col: 'lh_tasks' },
    { key: 'lh_applications', col: 'lh_applications' },
    { key: 'lh_messages', col: 'lh_messages' },
    { key: 'lh_payments', col: 'lh_payments' },
    { key: 'lh_users', col: 'lh_users' }
  ];
  for (const c of collections) {
    try {
      const local = read(c.key, []) || [];
      const remote = await FBGetter().getAll(c.col) || [];
      const remoteLocalIds = (remote || []).map(r => (r.localId || r.id || r._id) + '');
      for (const item of local) {
        const localId = (item.id || item.localId || '') + '';
        if (!localId) continue;
        if (!remoteLocalIds.includes(localId)) {
          try { await FBGetter().add(c.col, Object.assign({}, item, { localId })); } catch (e) { console.warn('Failed to push local item to Firestore', c.key, e); }
        }
      }
    } catch (e) { console.warn('syncLocalToFirestore error for', c.key, e); }
  }
}

// Poll for FB readiness once on import
(function pollAndSync() {
  if (fbIsReady()) { syncLocalToFirestore().catch(() => { }); return; }
  let attempts = 0; const iv = setInterval(() => {
    attempts++; if (fbIsReady()) { clearInterval(iv); syncLocalToFirestore().catch(() => { }); }
    else if (attempts > 60) clearInterval(iv);
  }, 100);
})();

// Expose functions
const API = {
  allTasks, allTasksLocal, addTask, updateTask, removeTask,
  allApplications, addApplication, updateApplication,
  allMessages, sendMessage, allPayments, createPayment,
  allUsers, createUser, signInUser, currentUser, signOut, findUserByUsername,
  updateUser, purchasePermit, hasPermit, consumePermit, applyToTask
};

// Attach to window for legacy pages
if (typeof window !== 'undefined') {
  window.LH = Object.assign(window.LH || {}, API);
  window.LH = Object.assign(window.LH || {}, API, { findUserByUsernameAsync });
  window.LH.formatDate = function (iso) { try { const d = new Date(iso); if (isNaN(d)) return iso; return d.toLocaleString(); } catch (e) { return iso; } };
}

export default API;
export {
  allTasks, allTasksLocal, addTask, updateTask, removeTask,
  allApplications, addApplication, updateApplication,
  allMessages, sendMessage, allPayments, createPayment,
  allUsers, createUser, signInUser, currentUser, signOut, findUserByUsername,
  updateUser, purchasePermit, hasPermit, consumePermit, applyToTask, findUserByUsernameAsync
};
