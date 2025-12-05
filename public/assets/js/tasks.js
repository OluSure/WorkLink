
// Enhanced client-side tasks system (localStorage)
(function () {
	'use strict';

	function $(selector) { return document.querySelector(selector); }
	function $all(selector) { return Array.from(document.querySelectorAll(selector)); }

	// Helpers
	function read(key, fallback) { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } }
	function write(key, val) { localStorage.setItem(key, JSON.stringify(val)); }

	// Ensure stores
	if (!read('lh_users', null)) write('lh_users', []);
	if (!read('lh_tasks', null)) write('lh_tasks', []);
	if (!read('lh_applications', null)) write('lh_applications', []);
	if (!read('lh_messages', null)) write('lh_messages', []);
	if (!read('lh_payments', null)) write('lh_payments', []);

	// Password hashing (SHA-256)
	async function hashPassword(pw) {
		const enc = new TextEncoder();
		const buf = await crypto.subtle.digest('SHA-256', enc.encode(pw));
		return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
	}

	// Users
	function allUsers() { return read('lh_users', []); }
	function saveUsers(u) { write('lh_users', u); }
	function findUserByUsername(username) { return allUsers().find(x => x.username === username); }

	async function createUser(username, password, displayName, email) {
			if (!username || !password) return {ok:false, message:'Username and password required'};

			// Prefer Firestore when available for cross-browser persistence
			if (window.__FB_READY__ && window.FB && window.FB.available) {
				// check existing user in Firestore
				const existing = await window.FB.queryEqual('lh_users', 'username', username);
				if (existing && existing.length > 0) return {ok:false, message:'Username already taken'};
				const hash = await hashPassword(password);
				const user = {username: username, passwordHash: hash, name: displayName || username, email: email || username, bio: '', avatar: ''};
				const added = await window.FB.add('lh_users', user);
				// mirror locally for offline friendliness
				try { const lu = allUsers(); lu.push(user); saveUsers(lu); } catch(e){}
				return {ok:true, user: user};
			}

			// fallback: localStorage-only
			if (findUserByUsername(username)) return {ok:false, message:'Username already taken'};
			const hash = await hashPassword(password);
			const user = {username: username, passwordHash: hash, name: displayName, email: email || username, bio: '', avatar: ''};
			const u = allUsers(); u.push(user); saveUsers(u);
			return {ok:true, user};
	}

	async function signInUser(username, password) {
			// If Firestore available, try to authenticate against server copy
			if (window.__FB_READY__ && window.FB && window.FB.available) {
				const users = await window.FB.queryEqual('lh_users', 'username', username);
				const user = (users && users.length>0) ? users[0] : null;
				if (!user) return {ok:false, message:'No such user'};
				const hash = await hashPassword(password);
				// Firestore stores passwordHash same as local
				if (hash !== user.passwordHash) return {ok:false, message:'Invalid credentials'};
				// Persist session locally so UI can read it (and optionally write session doc to Firestore)
				try { write('lh_currentUser', {username: user.username, name: user.name}); } catch(e){}
				updateSigninButtons();
				// Optionally record a session document
				try { await window.FB.add('sessions', { username: user.username, createdAt: new Date().toISOString() }); } catch(e){}
				return {ok:true, user};
			}

			// Fallback to localStorage auth
			const user = findUserByUsername(username);
			if (!user) return {ok:false, message:'No such user'};
			const hash = await hashPassword(password);
			if (hash !== user.passwordHash) return {ok:false, message:'Invalid credentials'};
			write('lh_currentUser', {username: user.username, name: user.name});
			updateSigninButtons();
			return {ok:true, user};
	}

	function currentUser() { return read('lh_currentUser', null); }
	function signOut() { localStorage.removeItem('lh_currentUser'); updateSigninButtons(); }

	// Tasks
	function allTasks() { return read('lh_tasks', []); }
	function saveTasks(tasks) { write('lh_tasks', tasks); }

	function isFirestoreReady() {
		return window.__FB_READY__ && window.FB && window.FB.available;
	}

	function addTask(task) {
		const tasks = allTasks();
		task.id = Date.now();
		task.createdAt = new Date().toISOString();
		task.applications = [];
		tasks.unshift(task);
		saveTasks(tasks);
		// Sync to Firestore in background when available
		if (isFirestoreReady()) {
			(async function () {
				try {
					// Add localId for mapping
					const payload = Object.assign({}, task, { localId: task.id });
					await window.FB.add('lh_tasks', payload);
				} catch (e) { console.error('Failed to sync task to Firestore', e); }
			})();
		}
		return task;
	}
	function updateTask(updated) {
		const tasks = allTasks().map(t => t.id === updated.id ? updated : t);
		saveTasks(tasks);
		if (isFirestoreReady()) {
			(async function () {
				try {
					// try find remote by localId
					const rem = await window.FB.queryEqual('lh_tasks', 'localId', updated.id);
					if (rem && rem.length > 0) {
						await window.FB.set('lh_tasks', rem[0]._id, Object.assign({}, updated, { localId: updated.id }));
					} else {
						await window.FB.add('lh_tasks', Object.assign({}, updated, { localId: updated.id }));
					}
				} catch (e) { console.error('Failed to update task in Firestore', e); }
			})();
		}
	}
	function removeTask(id) {
		const tasks = allTasks().filter(t => t.id !== id);
		saveTasks(tasks);
		if (isFirestoreReady()) {
			(async function () {
				try {
					const rem = await window.FB.queryEqual('lh_tasks', 'localId', id);
					if (rem && rem.length>0) await window.FB.delete('lh_tasks', rem[0]._id);
				} catch (e) { console.error('Failed to remove task from Firestore', e); }
			})();
		}
	}

	// Applications
	function allApplications() { return read('lh_applications', []); }
	function saveApplications(a) { write('lh_applications', a); }
	function addApplication(app) {
		const apps = allApplications();
		app.id = Date.now() + Math.floor(Math.random()*999);
		app.taskId = Number(app.taskId); // Ensure taskId is a number
		app.createdAt = new Date().toISOString();
		apps.push(app); saveApplications(apps);
		if (isFirestoreReady()) {
			(async function(){
				try { await window.FB.add('lh_applications', Object.assign({}, app, { localId: app.id })); } catch(e){ console.error('Failed to sync application to Firestore', e); }
			})();
		}
		return app;
	}

	function updateApplication(id, updates) {
		const apps = allApplications().map(a => a.id === id ? Object.assign({}, a, updates) : a);
		saveApplications(apps);
		if (isFirestoreReady()) {
			(async function(){
				try {
					const rem = await window.FB.queryEqual('lh_applications', 'localId', id);
					if (rem && rem.length>0) await window.FB.set('lh_applications', rem[0]._id, Object.assign({}, updates, { localId: id }));
					else await window.FB.add('lh_applications', Object.assign({}, updates, { localId: id }));
				} catch(e){ console.error('Failed to sync application update to Firestore', e); }
			})();
		}
		// if accepted, also mark task
		if (updates.status === 'accepted') {
			const app = apps.find(a => a.id === id);
			if (app) {
				const tasks = allTasks();
				const task = tasks.find(t => t.id === app.taskId);
				if (task) {
					task.assignedTo = app.applicant;
					task.status = 'assigned';
					updateTask(task);
				}
			}
		}
		// send notification message to applicant including task title
		const app = allApplications().find(a => a.id === id);
		if (app) {
			const task = allTasks().find(t => t.id === app.taskId);
			const title = task ? (task.title || ('#'+task.id)) : ('#'+app.taskId);
			const text = updates.status === 'accepted'
				? `Your application for "${title}" was accepted.`
				: `Your application for "${title}" was rejected.`;
			sendMessage(currentUser().username, app.applicant, text);
		}
		return apps.find(a=>a.id===id);
	}

	// Messages
	function allMessages() { return read('lh_messages', []); }
	function saveMessages(m) { write('lh_messages', m); }
	function sendMessage(from, to, content) {
		const msgs = allMessages();
		const msg = {id: Date.now()+Math.floor(Math.random()*99), from, to, content, createdAt:new Date().toISOString()};
		msgs.push(msg); saveMessages(msgs);
		if (isFirestoreReady()) {
			(async function(){
				try { await window.FB.add('lh_messages', Object.assign({}, msg, { localId: msg.id })); } catch(e){ console.error('Failed to sync message to Firestore', e); }
			})();
		}
		return msg;
	}

	// Payments (demo) - minimal records only
	function allPayments() { return read('lh_payments', []); }
	function savePayments(p) { write('lh_payments', p); }
	function createPayment(taskId, fromUser, toUser, amount) {
		const payments = allPayments();
		const p = {id: Date.now()+Math.floor(Math.random()*999), taskId, from:fromUser, to:toUser, amount, status:'completed', createdAt:new Date().toISOString()};
		payments.push(p); savePayments(payments);
		if (isFirestoreReady()) {
			(async function(){
				try { await window.FB.add('lh_payments', Object.assign({}, p, { localId: p.id })); } catch(e){ console.error('Failed to sync payment to Firestore', e); }
			})();
		}
		return p;
	}

	// User updates and permit system (demo)
	function updateUser(updated) {
		const users = allUsers();
		const idx = users.findIndex(u => u.username === updated.username);
		if (idx === -1) return null;
		users[idx] = Object.assign({}, users[idx], updated);
		saveUsers(users);
		return users[idx];
	}

	function purchasePermit(username, count) {
		count = Number(count) || 1;
		const users = allUsers();
		const idx = users.findIndex(u => u.username === username);
		if (idx === -1) return null;
		users[idx].permits = (users[idx].permits || 0) + count;
		saveUsers(users);
		// record a demo payment (to: platform)
		createPayment(null, username, 'platform', 100 * count);
		return users[idx];
	}

	function hasPermit(username) {
		const u = findUserByUsername(username);
		if (!u) return false;
		if (!u.freePermitUsed) return true;
		if ((u.permits || 0) > 0) return true;
		return false;
	}

	function consumePermit(username) {
		const users = allUsers();
		const idx = users.findIndex(u => u.username === username);
		if (idx === -1) return false;
		if (!users[idx].freePermitUsed) {
			users[idx].freePermitUsed = true;
			saveUsers(users);
			return true;
		}
		if ((users[idx].permits || 0) > 0) {
			users[idx].permits = (users[idx].permits || 0) - 1;
			saveUsers(users);
			return true;
		}
		return false;
	}

	function applyToTask(app) {
		if (!app || !app.applicant) return {ok:false, message:'Invalid application'};
		if (!hasPermit(app.applicant)) return {ok:false, message:'No permit available', code:'no_permit'};
		// consume permit and add application
		const consumed = consumePermit(app.applicant);
		if (!consumed) return {ok:false, message:'Unable to consume permit'};
		const created = addApplication(app);
		return {ok:true, app: created};
	}

	// Utilities
	function escapeHtml(s) { if (!s && s !== 0) return ''; return String(s).replace(/[&<>"']/g, function (m) { return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":"&#39;"}[m]; }); }

	function formatDate(iso) {
		try {
			const d = new Date(iso);
			if (isNaN(d)) return iso;
			const opts = { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' };
			return d.toLocaleString(undefined, opts);
		} catch(e) { return iso; }
	}

	// Sign-in modal (build on demand)
	function ensureAuthModal() {
		if (document.getElementById('lhAuthModal')) return document.getElementById('lhAuthModal');
		const div = document.createElement('div');
		div.innerHTML = '\n      <div class="modal fade" id="lhAuthModal" tabindex="-1" aria-hidden="true">\n        <div class="modal-dialog modal-dialog-centered">\n          <div class="modal-content">\n            <div class="modal-header">\n              <h5 class="modal-title">Sign In / Register</h5>\n              <button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Close"></button>\n            </div>\n            <div class="modal-body">\n              <ul class="nav nav-tabs" id="lhAuthTabs" role="tablist">\n                <li class="nav-item" role="presentation"><button class="nav-link active" id="login-tab" data-bs-toggle="tab" data-bs-target="#login" type="button" role="tab">Login</button></li>\n                <li class="nav-item" role="presentation"><button class="nav-link" id="reg-tab" data-bs-toggle="tab" data-bs-target="#register" type="button" role="tab">Register</button></li>\n              </ul>\n              <div class="tab-content pt-3">\n                <div class="tab-pane fade show active" id="login" role="tabpanel">\n                  <form id="lhLoginForm">\n                    <div class="mb-2"><label class="form-label">Username</label><input class="form-control" name="username" required></div>\n                    <div class="mb-2"><label class="form-label">Password</label><input class="form-control" name="password" type="password" required></div>\n                    <div class="text-end"><button class="btn btn-primary" type="submit">Login</button></div>\n                  </form>\n                </div>\n                <div class="tab-pane fade" id="register" role="tabpanel">\n                  <form id="lhRegisterForm">\n                    <div class="mb-2"><label class="form-label">Username</label><input class="form-control" name="username" required></div>\n                    <div class="mb-2"><label class="form-label">Full name</label><input class="form-control" name="displayName"></div>\n<div class="mb-2"><label class="form-label">Email</label><input class="form-control" name="Email"></div>\n<div class="mb-2"><label class="form-label">Password</label><input class="form-control" name="password" type="password" required></div>\n                    <div class="text-end"><button class="btn btn-success" type="submit">Register</button></div>\n                  </form>\n                </div>\n              </div>\n            </div>\n          </div>\n        </div>\n      </div>';
		document.body.appendChild(div);
		// bind forms
		const loginForm = document.getElementById('lhLoginForm');
		const regForm = document.getElementById('lhRegisterForm');
		if (loginForm) loginForm.addEventListener('submit', async function (e) {
			e.preventDefault();
			const fd = new FormData(loginForm); const u = fd.get('username'); const p = fd.get('password');
			const res = await signInUser(u, p);
			if (!res.ok) return showInfo('Login failed', res.message);
			var modal = bootstrap.Modal.getInstance(document.getElementById('lhAuthModal'));
			if (modal) modal.hide();
			updateSigninButtons();
			window.location = 'account.html';
		});
		if (regForm) regForm.addEventListener('submit', async function (e) {
			e.preventDefault();
			const fd = new FormData(regForm); const u = fd.get('username'); const p = fd.get('password'); const d = fd.get('displayName');
			const res = await createUser(u,p,d);
			if (!res.ok) return showInfo('Registration failed', res.message);
			await showInfo('Registered', 'Registration successful — signing in');
			await signInUser(u,p);
			var modal = bootstrap.Modal.getInstance(document.getElementById('lhAuthModal'));
			if (modal) modal.hide();
			updateSigninButtons();
			window.location = 'account.html';
		});
		return document.getElementById('lhAuthModal');
	}

	// Modal helpers: showInfo(title, message) and showConfirm(message, onYes)
	function showInfo(title, message) {
		return new Promise(function (resolve) {
			let existing = document.getElementById('lhMsgModal');
			if (existing) existing.remove();
			const div = document.createElement('div');
			div.innerHTML = `
				<div class="modal fade" id="lhMsgModal" tabindex="-1" aria-hidden="true">
					<div class="modal-dialog modal-dialog-centered">
						<div class="modal-content">
							<div class="modal-header"><h5 class="modal-title">${escapeHtml(title||'Notice')}</h5><button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Close"></button></div>
							<div class="modal-body"><p>${escapeHtml(message||'')}</p></div>
							<div class="modal-footer"><button type="button" class="btn btn-primary" data-bs-dismiss="modal">OK</button></div>
						</div>
					</div>
				</div>`;
			document.body.appendChild(div);
			const modalEl = document.getElementById('lhMsgModal');
			const modal = new bootstrap.Modal(modalEl);
			modalEl.addEventListener('hidden.bs.modal', function () { modalEl.remove(); resolve(); });
			modal.show();
		});
	}

	function showConfirm(message, onYes) {
		let existing = document.getElementById('lhConfirmModal');
		if (existing) existing.remove();
		const div = document.createElement('div');
		div.innerHTML = `
			<div class="modal fade" id="lhConfirmModal" tabindex="-1" aria-hidden="true">
				<div class="modal-dialog modal-dialog-centered">
					<div class="modal-content">
						<div class="modal-header"><h5 class="modal-title">Confirm</h5><button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Close"></button></div>
						<div class="modal-body"><p>${escapeHtml(message||'Are you sure?')}</p></div>
						<div class="modal-footer"><button id="lhConfirmNo" type="button" class="btn btn-secondary" data-bs-dismiss="modal">Cancel</button><button id="lhConfirmYes" type="button" class="btn btn-danger">Yes</button></div>
					</div>
				</div>
			</div>`;
		document.body.appendChild(div);
		const modalEl = document.getElementById('lhConfirmModal');
		const modal = new bootstrap.Modal(modalEl);
		modalEl.querySelector('#lhConfirmYes').addEventListener('click', function () { try { if (onYes) onYes(); } finally { modal.hide(); } });
		modalEl.addEventListener('hidden.bs.modal', function () { modalEl.remove(); });
		modal.show();
	}

	// Update sign-in buttons across pages
	function updateSigninButtons() {
		const user = currentUser();
		$all('#signinBtn, #signinBtn2, #signinBtn3').forEach(function (btn) {
			if (!btn) return;
			if (user) {
				btn.textContent = 'Account';
				btn.onclick = function () { window.location = 'account.html'; };
			} else {
				btn.textContent = 'Sign In';
				btn.onclick = function () {
					const modalEl = ensureAuthModal();
					const modal = new bootstrap.Modal(modalEl);
					modal.show();
				};
			}
		});
	}

	// Rendering
	function renderTaskCard(t, container) {
		const col = document.createElement('div'); col.className = 'col-12 col-md-6';
		const card = document.createElement('div'); card.className = 'card p-3 h-100';
		let html = '';
		if (t.image) html += '<img src="'+escapeHtml(t.image)+'" class="img-fluid mb-2" style="max-height:160px;object-fit:cover;width:100%">';
		html += '<h5>' + escapeHtml(t.title) + '</h5>';
		html += '<p class="mb-1">' + escapeHtml((t.description||'').slice(0,160)) + (t.description && t.description.length>160? '...':'') + '</p>';
		html += '<p class="mb-1"><strong>Category:</strong> ' + escapeHtml(t.category || '-') + ' &nbsp; <strong>Location:</strong> ' + escapeHtml(t.location || '-') + '</p>';
		html += '<p class="mb-1"><strong>Budget:</strong> ' + escapeHtml(t.budget || '-') + ' &nbsp; <strong>Poster:</strong> ' + escapeHtml(t.poster) + '</p>';
		card.innerHTML = html;
		const actions = document.createElement('div'); actions.className = 'd-flex gap-2 mt-2';
		const view = document.createElement('a'); view.className = 'btn btn-outline-primary btn-sm'; view.textContent = 'View Details'; view.href = 'task.html?id='+t.id;
		actions.appendChild(view);
		const user = currentUser();
		if (user && user.username === t.poster) {
			const del = document.createElement('button'); del.className='btn btn-danger btn-sm'; del.textContent='Delete'; del.onclick = function (){ showConfirm('Delete this task?', function(){ removeTask(t.id); rerenderAll(); }); };
			actions.appendChild(del);
		}
		card.appendChild(actions); col.appendChild(card); container.appendChild(col);
	}

	function rerenderAll() {
		const listEl = document.getElementById('tasksList');
		if (listEl) {
			listEl.innerHTML = '';
			const q = (document.getElementById('searchInput') && document.getElementById('searchInput').value || '').toLowerCase();
			const cat = (document.getElementById('categoryFilter') && document.getElementById('categoryFilter').value) || '';
			allTasks().filter(function (t) {
				if (cat && cat !== 'all' && t.category !== cat) return false;
				if (!q) return true;
				return (t.title||'').toLowerCase().includes(q) || (t.description||'').toLowerCase().includes(q) || (t.category||'').toLowerCase().includes(q) || (t.location||'').toLowerCase().includes(q);
			}).forEach(function (t) { renderTaskCard(t, listEl); });
		}
		const myList = document.getElementById('myTasksList');
		if (myList) {
			myList.innerHTML = '';
			const user = currentUser();
			if (user) {
				const userTasks = allTasks().filter(function (t) { return t.poster === user.username; });
				if (userTasks.length === 0) {
					myList.innerHTML = '<p>You have not posted any task yet!</p>';
				} else {
					userTasks.forEach(function (t) { renderTaskCard(t, myList); });
				}
			} else {
				myList.innerHTML = '<p>Please sign in to see your tasks.</p>';
			}
		}
	}

	// File helper
	function fileToDataUrl(file) {
		return new Promise(function (resolve, reject) {
			if (!file) return resolve('');
			const fr = new FileReader(); fr.onload = function () { resolve(fr.result); }; fr.onerror = reject; fr.readAsDataURL(file);
		});
	}

	// Bind
	document.addEventListener('DOMContentLoaded', function () {
		updateSigninButtons();

		// If Firestore is available, migrate any locally-stored users and collections to Firestore
		(async function migrateLocalDataToFirestore(){
			try {
				if (window.__FB_READY__ && window.FB && window.FB.available) {
					// Collections to migrate: users, tasks, applications, messages, payments
					const collections = [
						{ key: 'lh_users', col: 'lh_users' },
						{ key: 'lh_tasks', col: 'lh_tasks' },
						{ key: 'lh_applications', col: 'lh_applications' },
						{ key: 'lh_messages', col: 'lh_messages' },
						{ key: 'lh_payments', col: 'lh_payments' }
					];
					for (const c of collections) {
						try {
							const local = read(c.key, []);
							const remote = await window.FB.getAll(c.col);
							const remoteLocalIds = (remote||[]).map(r => r.localId || r.id || r._id);
							// If remote has items, prefer remote as source of truth
							if (remote && remote.length>0) {
								// map remote docs into local store format
								const mapped = remote.map(r => {
									const obj = Object.assign({}, r);
									// normalize id field for tasks/applications/messages/payments
									if (!obj.id) {
										obj.id = obj.localId || (obj._id ? Number(obj._id) : obj._id) || Date.now();
									}
									return obj;
								});
								write(c.key, mapped);
							} else {
								// remote empty: push local items to Firestore
								for (const item of (local||[])) {
									const localId = item.id || item.localId || (Date.now()+Math.floor(Math.random()*999));
									if (!remoteLocalIds.includes(localId)) {
										try { await window.FB.add(c.col, Object.assign({}, item, { localId })); } catch(e) { /* ignore */ }
									}
								}
							}
						} catch(e) { console.warn('Migration error for', c.key, e); }
					}
				}
			} catch(e) { console.warn('Local -> Firestore migration failed', e); }
			// Refresh UI after migration
			try { rerenderAll(); updateSigninButtons(); } catch(e) {}
		})();

		// If Firestore is available, migrate any locally-stored users to Firestore
		(async function migrateLocalUsersToFirestore(){
			try {
				if (window.__FB_READY__ && window.FB && window.FB.available) {
					const localUsers = allUsers();
					if (localUsers && localUsers.length>0) {
						const remote = await window.FB.getAll('lh_users');
						const remoteUsernames = (remote||[]).map(u=>u.username);
						for (const u of localUsers) {
							if (!remoteUsernames.includes(u.username)) {
								try { await window.FB.add('lh_users', u); } catch(e) { /* ignore individual failures */ }
							}
						}
					}
				}
			} catch(e) { console.warn('User migration to Firestore failed', e); }
		})();

		const search = document.getElementById('searchInput'); if (search) search.addEventListener('input', function () { rerenderAll(); });
		const cat = document.getElementById('categoryFilter'); if (cat) cat.addEventListener('change', function(){ rerenderAll(); });

		const postForm = document.getElementById('postTaskForm');
		if (postForm) {
			// wire image preview if present
			const imageInput = document.getElementById('taskImage');
			if (imageInput) {
				imageInput.addEventListener('change', function () {
					const preview = document.getElementById('taskImagePreview');
					if (!preview) return;
					const f = imageInput.files[0];
					if (!f) { preview.innerHTML = ''; return; }
					const fr = new FileReader(); fr.onload = function () { preview.innerHTML = '<img src="'+fr.result+'" style="max-width:200px">'; }; fr.readAsDataURL(f);
				});
			}

			postForm.addEventListener('submit', async function (e) {
				e.preventDefault();
				const user = currentUser();
				if (!user) {
					showConfirm('You must sign in to post a task. Sign in now?', function(){ const modalEl = ensureAuthModal(); new bootstrap.Modal(modalEl).show(); });
					return;
				}
				// Basic validation
				const title = (document.getElementById('taskTitle')||{}).value || '';
				const description = (document.getElementById('taskDescription')||{}).value || '';
				const category = (document.getElementById('taskCategory')||{}).value || '';
				if (!title.trim() || !description.trim() || !category.trim()) { await showInfo('Validation', 'Please provide title, description and category.'); return; }
				const location = (document.getElementById('taskLocation')||{}).value || '';
				const budget = (document.getElementById('taskBudget')||{}).value || '';
				const imageFile = (document.getElementById('taskImage')||{}).files ? document.getElementById('taskImage').files[0] : null;
				const imageData = await fileToDataUrl(imageFile);
				const task = {title, description, category, location, budget, poster: currentUser().username, image: imageData};
				const added = addTask(task);
				(document.getElementById('postResult')||{}).innerHTML = '<div class="alert alert-success mt-3">Task posted successfully.</div>';
				postForm.reset(); rerenderAll();
				// navigate to task detail
				window.location = 'task.html?id=' + added.id;
			});
		}

		// Account info
		const info = document.getElementById('accountInfo');
		if (info) {
			const u = currentUser();
			if (u) {
				info.innerHTML = '<p>Signed in as <strong>' + escapeHtml(u.name) + ' ('+escapeHtml(u.username)+')</strong></p>' + '<button class="btn btn-sm btn-outline-secondary" id="signoutBtn">Sign out</button>' + ' <a class="btn btn-sm btn-primary" href="profile.html?u='+encodeURIComponent(u.username)+'">View profile</a>';
				const sb = document.getElementById('signoutBtn'); if (sb) sb.onclick = function () { showConfirm('Sign out?', function(){ signOut(); showInfo('Signed out','You have been signed out').then(function(){ window.location = 'index.html'; }); }); };
			} else {
				info.innerHTML = '<p>You are not signed in. <button class="btn btn-sm btn-primary" id="signinNow">Sign in</button></p>';
				const sn = document.getElementById('signinNow'); if (sn) sn.onclick = function () { const modalEl = ensureAuthModal(); new bootstrap.Modal(modalEl).show(); };
			}
		}

		rerenderAll();
	});

	// show some functions for task/detail/profile pages
	window.LH = {
		currentUser: currentUser,
		signOut: signOut,
		allTasks: allTasks,
		findUserByUsername: findUserByUsername,
		addApplication: addApplication,
		allApplications: allApplications,
		sendMessage: sendMessage,
		allMessages: allMessages,
		createPayment: createPayment,
		allPayments: allPayments,
		updateTask: updateTask,
		updateUser: updateUser,
		purchasePermit: purchasePermit,
		hasPermit: hasPermit,
		consumePermit: consumePermit,
		applyToTask: applyToTask,
		showInfo: showInfo,
		showConfirm: showConfirm
	};

	// show updateApplication and formatDate
	window.LH.updateApplication = updateApplication;
	window.LH.formatDate = formatDate;

})();

