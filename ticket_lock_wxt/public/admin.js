(function () {
  var BASE_URL = 'https://netsus-two.vercel.app';
  var API_KEY = '-_-ErJy9v64XRiDbpuPFZ3uLs4nVFmXm';
  var REFRESH_SECS = 10;

  function escHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
  }

  var countdownInterval = null;
  var secondsLeft = REFRESH_SECS;
  var currentTab = 'live';
  var liveView = 'ticket'; // 'ticket' | 'tech'
  var lastTickets = [];
  var lastHistory = [];
  var historyFilter = '';
  var historyPeriod = 'all';
  var historyTechFilter = '';
  var dateFrom = null;
  var dateTo = null;
  var historyOffset = 0;
  var historyTotal = 0;
  var HISTORY_PAGE = 50;

  // --- Tema (claro/oscuro/auto) — misma clave que usa el resto de la extensión ---
  var THEME_KEY = 'netsus_theme';
  var currentThemePref = 'auto';

  function resolveTheme(pref) {
    if (pref === 'light' || pref === 'dark') return pref;
    if (typeof matchMedia === 'undefined') return 'dark';
    return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  function applyTheme(resolved) {
    document.documentElement.setAttribute('data-theme', resolved);
  }

  function highlightThemeButtons(pref) {
    document.querySelectorAll('.themeSeg button').forEach(function (b) {
      b.classList.toggle('active', b.dataset.themeVal === pref);
    });
  }

  function setThemePref(pref) {
    currentThemePref = pref;
    chrome.storage.local.set({ netsus_theme: pref });
    applyTheme(resolveTheme(pref));
    highlightThemeButtons(pref);
  }

  chrome.storage.local.get([THEME_KEY], function (r) {
    var pref = r[THEME_KEY];
    if (pref !== 'light' && pref !== 'dark') pref = 'auto';
    currentThemePref = pref;
    applyTheme(resolveTheme(pref));
    highlightThemeButtons(pref);
  });

  document.querySelectorAll('.themeSeg button').forEach(function (btn) {
    btn.addEventListener('click', function () { setThemePref(btn.dataset.themeVal); });
  });

  if (typeof matchMedia !== 'undefined') {
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function () {
      if (currentThemePref === 'auto') applyTheme(resolveTheme('auto'));
    });
  }

  chrome.storage.onChanged.addListener(function (changes, area) {
    if (area === 'local' && changes[THEME_KEY]) {
      currentThemePref = changes[THEME_KEY].newValue || 'auto';
      applyTheme(resolveTheme(currentThemePref));
      highlightThemeButtons(currentThemePref);
    }
  });

  // --- Iconos SVG inline (estilo Lucide) para markup generado dinámicamente ---
  var ICON_PATHS = {
    'alert-triangle': '<path d="m10.29 3.86-8.18 14.14A2 2 0 0 0 3.83 21h16.34a2 2 0 0 0 1.72-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
    'ticket': '<path d="M2 9a3 3 0 0 1 0 6v2a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-2a3 3 0 0 1 0-6V7a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2z"/><path d="M13 5v2"/><path d="M13 17v2"/><path d="M13 11v2"/>',
    'check-circle': '<circle cx="12" cy="12" r="9"/><path d="m9 12 2 2 4-4"/>',
    'clipboard-list': '<rect width="8" height="4" x="8" y="2" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><path d="M12 11h4"/><path d="M12 16h4"/><path d="M8 11h.01"/><path d="M8 16h.01"/>',
    'bar-chart-3': '<path d="M3 3v16a2 2 0 0 0 2 2h16"/><path d="M7 16h8"/><path d="M7 11h12"/><path d="M7 6h3"/>',
    'link-2': '<path d="M9 17H7A5 5 0 0 1 7 7h2"/><path d="M15 7h2a5 5 0 1 1 0 10h-2"/><line x1="8" x2="16" y1="12" y2="12"/>',
    'calendar': '<path d="M8 2v4"/><path d="M16 2v4"/><rect width="18" height="18" x="3" y="4" rx="2"/><path d="M3 10h18"/>',
    'clock': '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/>',
    'users': '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
    'briefcase': '<rect width="20" height="14" x="2" y="7" rx="2" ry="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/>',
  };
  function ic(name, size, color) {
    size = size || 16;
    return '<svg xmlns="http://www.w3.org/2000/svg" width="' + size + '" height="' + size + '" viewBox="0 0 24 24" fill="none" stroke="' + (color || 'currentColor') + '" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:middle;flex-shrink:0">' + ICON_PATHS[name] + '</svg>';
  }

  function userName(u) { return typeof u === 'string' ? u : u.name; }
  function userMinutes(u) { return typeof u === 'string' ? 0 : (u.minutes || 0); }
  function userLabel(u) {
    // El nombre viene del cliente (self-reportado) y termina renderizado sin más
    // tratamiento — escapar acá es la última línea de defensa aunque el server ya
    // valide el formato en /api/presence/[id].
    var name = escHtml(userName(u));
    var min = userMinutes(u);
    return name + (min > 0 ? '<span class="chip-time">· ' + min + 'm</span>' : '');
  }

  function normalizeTickets(data) {
    if (Array.isArray(data)) return data;
    return Object.keys(data).map(function (id) {
      return { ticketId: id, ticketNumber: null, users: (data[id] || []).map(function (u) { return { name: u, minutes: 0 }; }) };
    });
  }

  function doLogin() {
    var pwd = document.getElementById('pwdInput').value;
    var btn = document.getElementById('loginBtn');
    if (btn) { btn.disabled = true; btn.textContent = 'Verificando...'; }
    fetch(BASE_URL + '/api/admin/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: pwd }),
    }).then(function (r) {
      if (r.ok) {
        return r.json().catch(function () { return {}; }).then(function (data) {
          sessionStorage.setItem('netsus_admin', '1');
          if (data && data.token) sessionStorage.setItem('netsus_admin_token', data.token);
          showPanel();
        });
      } else {
        var err = document.getElementById('loginError');
        err.style.display = 'block';
        setTimeout(function () { err.style.display = 'none'; }, 2000);
      }
    }).catch(function () {
      var err = document.getElementById('loginError');
      err.textContent = 'Error de conexión';
      err.style.display = 'block';
      setTimeout(function () { err.style.display = 'none'; err.textContent = 'Contraseña incorrecta'; }, 3000);
    }).finally(function () {
      if (btn) { btn.disabled = false; btn.textContent = 'Ingresar'; }
    });
  }

  function showForgotStep() {
    document.getElementById('loginStep').style.display = 'none';
    document.getElementById('forgotStep').style.display = 'block';
    document.getElementById('resetFields').style.display = 'none';
    document.getElementById('forgotSendStatus').textContent = '';
    document.getElementById('resetStatus').textContent = '';
    document.getElementById('sendResetCodeBtn').style.display = '';
  }

  function showLoginStep() {
    document.getElementById('forgotStep').style.display = 'none';
    document.getElementById('loginStep').style.display = 'block';
  }

  function sendResetCode() {
    var btn = document.getElementById('sendResetCodeBtn');
    var status = document.getElementById('forgotSendStatus');
    btn.disabled = true;
    btn.textContent = 'Enviando...';
    fetch(BASE_URL + '/api/admin/forgot-password', { method: 'POST' })
      .then(function (r) { return r.json().catch(function () { return {}; }); })
      .then(function (data) {
        if (data && data.sent) {
          status.style.color = '#22c55e';
          status.textContent = '✓ Código enviado al canal de Teams. Revísalo e ingrésalo abajo.';
          document.getElementById('resetFields').style.display = 'block';
          btn.style.display = 'none';
        } else if (data && data.reason === 'no_webhook') {
          status.style.color = '#ef4444';
          status.textContent = 'No hay un canal de recuperación configurado. Contacta a quien administra Vercel para restablecer la contraseña.';
          btn.disabled = false;
          btn.textContent = 'Enviar código';
        } else {
          status.style.color = '#ef4444';
          status.textContent = 'No se pudo enviar el código. Intenta de nuevo en unos minutos.';
          btn.disabled = false;
          btn.textContent = 'Enviar código';
        }
      }).catch(function () {
        status.style.color = '#ef4444';
        status.textContent = 'Error de conexión.';
        btn.disabled = false;
        btn.textContent = 'Enviar código';
      });
  }

  function submitResetPassword() {
    var code = document.getElementById('resetCodeInput').value.trim();
    var newPwd = document.getElementById('resetNewPwdInput').value;
    var status = document.getElementById('resetStatus');
    var btn = document.getElementById('resetPwdBtn');
    if (!code || !newPwd) {
      status.style.color = '#ef4444';
      status.textContent = 'Completa el código y la contraseña nueva.';
      return;
    }
    if (newPwd.length < 8) {
      status.style.color = '#ef4444';
      status.textContent = 'La contraseña nueva debe tener al menos 8 caracteres.';
      return;
    }
    btn.disabled = true;
    btn.textContent = 'Restableciendo...';
    fetch(BASE_URL + '/api/admin/reset-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: code, newPassword: newPwd }),
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (data) { return { ok: r.ok, data: data }; });
    }).then(function (res) {
      if (!res.ok) {
        status.style.color = '#ef4444';
        status.textContent = res.data && res.data.error === 'invalid_code' ? 'Código incorrecto o vencido.'
          : res.data && res.data.error === 'weak_password' ? 'La contraseña nueva debe tener al menos 8 caracteres.'
          : 'Error al restablecer.';
        btn.disabled = false;
        btn.textContent = 'Restablecer contraseña';
        return;
      }
      status.style.color = '#22c55e';
      status.textContent = res.data && res.data.envOverride
        ? '✓ Guardada, pero ADMIN_PASSWORD sigue seteada en Vercel — no tendrá efecto hasta que la borres.'
        : '✓ Contraseña actualizada. Ya puedes iniciar sesión.';
      document.getElementById('resetFields').style.display = 'none';
      setTimeout(showLoginStep, 2500);
    }).catch(function () {
      status.style.color = '#ef4444';
      status.textContent = 'Error de conexión.';
      btn.disabled = false;
      btn.textContent = 'Restablecer contraseña';
    });
  }

  function doLogout() {
    sessionStorage.removeItem('netsus_admin');
    sessionStorage.removeItem('netsus_admin_token');
    clearInterval(countdownInterval);
    countdownInterval = null;
    document.getElementById('panel').style.display = 'none';
    document.getElementById('loginScreen').style.display = '';
    document.getElementById('pwdInput').value = '';
  }

  // Endpoints administrativos (config, sync de roster, borrar historial) exigen
  // este token de sesión además del x-api-key — ese solo, embebido en la extensión
  // pública, no alcanza para gatear acciones destructivas.
  function adminHeaders(extra) {
    var h = Object.assign({}, extra || {});
    h['x-api-key'] = API_KEY;
    h['x-admin-token'] = sessionStorage.getItem('netsus_admin_token') || '';
    return h;
  }

  function setTab(tab) {
    currentTab = tab;
    ['live', 'history', 'analytics', 'resources', 'notif', 'feedback', 'config'].forEach(function (t) {
      var btn = document.getElementById('tab' + t.charAt(0).toUpperCase() + t.slice(1));
      if (btn) btn.classList.toggle('active', t === tab);
      var el = document.getElementById(t + 'Tab');
      if (el) el.style.display = t === tab ? '' : 'none';
    });
    document.getElementById('liveViewToggle').style.display = tab === 'live' ? 'flex' : 'none';
    document.getElementById('exportCsvBtn').style.display = tab === 'history' ? '' : 'none';
    document.getElementById('filterBar').style.display = tab === 'history' ? 'flex' : 'none';
    if (tab === 'config') loadConfig();
    if (tab === 'analytics') { loadAnalytics(); loadWorkload(); }
    if (tab === 'resources') { renderActiveTechsAdmin(); fetchTeamOnline(); loadRoster(); }
    if (tab === 'notif') loadNotifications();
    if (tab === 'feedback') loadFeedback();
  }

  function updateCountdown() {
    secondsLeft--;
    if (secondsLeft <= 0) {
      secondsLeft = REFRESH_SECS;
      fetchData();
    }
    var el = document.getElementById('countdown');
    if (el) el.textContent = secondsLeft + 's';
  }

  function tickLiveClock() {
    var el = document.getElementById('lastUpdate');
    if (el) el.textContent = new Date().toLocaleTimeString('es-CL');
  }

  function showPanel() {
    document.getElementById('loginScreen').style.display = 'none';
    document.getElementById('panel').style.display = 'block';
    fetchData();
    fetchTeamOnline();
    secondsLeft = REFRESH_SECS;
    countdownInterval = setInterval(updateCountdown, 1000);
    tickLiveClock();
    setInterval(tickLiveClock, 1000);
    setInterval(fetchTeamOnline, 10000);
    // Fuerza el chequeo de colas al abrir el panel y luego cada 10 min — así el
    // admin ve tickets nuevos aunque ningún técnico tenga la extensión abierta.
    triggerNotifPoll();
    setInterval(triggerNotifPoll, 600000);
  }

  function showApiError(msg) {
    var el = document.getElementById('apiError');
    var t = document.getElementById('apiErrorTime');
    el.style.display = 'block';
    t.textContent = msg;
  }

  function hideApiError() {
    document.getElementById('apiError').style.display = 'none';
  }

  function fetchHistory(append) {
    var offset = append ? historyOffset : 0;
    var techParam = historyTechFilter ? '&tech=' + encodeURIComponent(historyTechFilter) : '';
    fetch(BASE_URL + '/api/presence/history?offset=' + offset + '&limit=' + HISTORY_PAGE + techParam, { headers: { 'x-api-key': API_KEY } })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        var events = Array.isArray(data.events) ? data.events : (Array.isArray(data) ? data : []);
        historyTotal = data.total || events.length;
        if (append) {
          lastHistory = lastHistory.concat(events);
          historyOffset += events.length;
        } else {
          lastHistory = events;
          historyOffset = events.length;
        }
        renderHistory(applyFilters(lastHistory));
      }).catch(function () {});
  }

  function fetchData() {
    Promise.all([
      fetch(BASE_URL + '/api/presence/status', { headers: { 'x-api-key': API_KEY } }),
      fetch(BASE_URL + '/api/presence/history?offset=0&limit=' + HISTORY_PAGE, { headers: { 'x-api-key': API_KEY } })
    ]).then(function (responses) {
      if (!responses[0].ok || !responses[1].ok) throw new Error('HTTP error');
      return Promise.all([
        responses[0].json().catch(function () { return []; }),
        responses[1].json().catch(function () { return {}; })
      ]);
    }).then(function (data) {
      hideApiError();
      lastTickets = normalizeTickets(data[0]);
      renderLive(lastTickets);
      var histData = data[1];
      var events = Array.isArray(histData.events) ? histData.events : (Array.isArray(histData) ? histData : []);
      historyTotal = histData.total || events.length;
      historyOffset = events.length;
      lastHistory = events;
      renderHistory(applyFilters(lastHistory));
    }).catch(function () {
      showApiError('Último intento: ' + new Date().toLocaleTimeString('es-CL'));
    });
  }

  function initials(name) {
    return name.split(' ').slice(0, 2).map(function (w) { return w[0] || ''; }).join('').toUpperCase();
  }

  function renderActiveTechsAdmin() {
    var el = document.getElementById('activeTechsAdmin');
    if (!el) return;
    if (!lastTickets.length) {
      el.innerHTML = '<div style="font-size:12px;color:var(--faint);padding:8px 0">Sin técnicos activos en este momento</div>';
      return;
    }
    var techMap = {};
    lastTickets.forEach(function (t) {
      t.users.forEach(function (u) {
        var name = userName(u);
        if (!techMap[name]) techMap[name] = [];
        techMap[name].push(t.ticketNumber || ('#' + t.ticketId));
      });
    });
    el.innerHTML = Object.keys(techMap).sort().map(function (name) {
      var tickets = techMap[name];
      return '<div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid rgba(var(--ink-rgb),0.06)">' +
        '<div style="width:8px;height:8px;border-radius:50%;background:#22c55e;box-shadow:0 0 5px #22c55e;flex-shrink:0"></div>' +
        '<div style="font-size:13px;font-weight:600;flex:1">' + escHtml(name) + '</div>' +
        '<div style="font-size:11px;color:var(--faint)">' + escHtml(tickets.join(', ')) + '</div>' +
        '</div>';
    }).join('');
  }

  // Técnicos con la extensión abierta ahora (roster activo + estado en línea).
  // Actualiza el stat "Técnicos disponibles" y, si el tab Recursos está abierto,
  // la lista con punto verde/gris por persona.
  function fetchTeamOnline() {
    fetch(BASE_URL + '/api/team/online', { headers: adminHeaders() })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        var statEl = document.getElementById('statOnline');
        if (statEl) statEl.textContent = (data.online || 0) + '/' + (data.total || 0);
        var listEl = document.getElementById('onlineTechsList');
        if (!listEl) return;
        var techs = data.techs || [];
        if (!techs.length) {
          listEl.innerHTML = '<div style="font-size:12px;color:var(--faint);padding:8px 0">Sin técnicos en el roster. Sincroniza desde Autotask primero.</div>';
          return;
        }
        techs = techs.slice().sort(function (a, b) {
          if (a.online !== b.online) return a.online ? -1 : 1;
          return a.name.localeCompare(b.name);
        });
        listEl.innerHTML = techs.map(function (t) {
          var dot = t.online
            ? '<div style="width:8px;height:8px;border-radius:50%;background:#22c55e;box-shadow:0 0 5px #22c55e;flex-shrink:0"></div>'
            : '<div style="width:8px;height:8px;border-radius:50%;background:var(--faint);flex-shrink:0"></div>';
          return '<div style="display:flex;align-items:center;gap:10px;padding:6px 0;border-bottom:1px solid rgba(var(--ink-rgb),0.06)">' +
            dot + '<div style="font-size:13px;font-weight:' + (t.online ? '600' : '400') + ';flex:1;' + (t.online ? '' : 'color:var(--faint)') + '">' + escHtml(t.name) + '</div>' +
            '<div style="font-size:11px;color:var(--faint)">' + (t.online ? 'En línea' : 'Sin conexión') + '</div>' +
            '</div>';
        }).join('');
      }).catch(function () {});
  }

  // Fuerza un ciclo del poller n1–n5 en el servidor (revisa colas vigiladas, SLA,
  // asignaciones) aunque ningún técnico tenga la extensión abierta ahora mismo —
  // así el panel admin no depende de que alguien esté navegando Autotask para
  // enterarse de un ticket nuevo. Se llama al abrir el panel y luego cada 10 min.
  function triggerNotifPoll() {
    fetch(BASE_URL + '/api/notifications/poll', { headers: adminHeaders() })
      .then(function () { if (currentTab === 'notif') loadNotifications(); })
      .catch(function () {});
  }

  var NOTIF_TYPE_LABEL = {
    n1_queue: 'Ticket en cola', n2_assign: 'Asignación', n3_client: 'Respuesta cliente',
    n4_sla: 'SLA', n5_critical: 'Crítico', collision: 'Colisión',
    identity_mismatch: '⚠ Nombre no reconocido',
  };

  function loadNotifications() {
    var el = document.getElementById('notifList');
    if (!el) return;
    el.innerHTML = '<div style="font-size:11px;color:var(--faint)">Cargando...</div>';
    fetch(BASE_URL + '/api/notifications/log?limit=40', { headers: adminHeaders() })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        var events = data.events || [];
        if (!events.length) {
          el.innerHTML = '<div style="font-size:12px;color:var(--faint);padding:8px 0">Sin notificaciones registradas todavía.</div>';
          return;
        }
        el.innerHTML = events.map(function (e) {
          var label = NOTIF_TYPE_LABEL[e.type] || e.type;
          var targets = (e.targets || []).filter(function (t) { return t !== '(sin técnicos en línea)'; });
          var who = targets.length ? escHtml(targets.join(', ')) : '<span style="color:var(--faint)">sin técnicos en línea</span>';
          var when = new Date(e.ts).toLocaleString('es-CL');
          var ticketPart = e.ticketUrl
            ? '<a href="' + escHtml(e.ticketUrl) + '" target="_blank" class="ticketLink">' + escHtml(e.ticketNumber || '') + '</a>'
            : escHtml(e.ticketNumber || '');
          // "Para: sin técnicos en línea" no aplica acá — este evento no es una
          // notificación dirigida a nadie, es un aviso de auditoría.
          var whoLine = e.type === 'identity_mismatch' ? '' : '<div style="font-size:11px;color:var(--faint);margin-top:2px">Para: ' + who + '</div>';
          return '<div style="padding:10px 0;border-bottom:1px solid rgba(var(--ink-rgb),0.06)">' +
            '<div style="display:flex;justify-content:space-between;gap:10px;align-items:baseline">' +
            '<span style="font-size:12px;font-weight:600">' + escHtml(label) + (ticketPart ? ' · ' + ticketPart : '') + '</span>' +
            '<span style="font-size:10px;color:var(--faint);white-space:nowrap">' + when + '</span></div>' +
            '<div style="font-size:12px;color:var(--dim);margin-top:2px">' + escHtml(e.body || '') + '</div>' +
            whoLine +
            '</div>';
        }).join('');
      }).catch(function () {
        el.innerHTML = '<div style="font-size:11px;color:#ef4444">Error al cargar notificaciones.</div>';
      });
  }

  var FEEDBACK_TYPE_LABEL = { mejorar: 'Mejorar algo', agregar: 'Agregar algo', quitar: 'Quitar algo', otro: 'Otro' };

  function loadFeedback() {
    var el = document.getElementById('feedbackList');
    if (!el) return;
    el.innerHTML = '<div style="font-size:11px;color:var(--faint)">Cargando...</div>';
    fetch(BASE_URL + '/api/feedback?limit=50', { headers: adminHeaders() })
      .then(function (r) {
        if (r.status === 403) throw new Error('session');
        return r.json();
      })
      .then(function (data) {
        var items = data.items || [];
        if (!items.length) {
          el.innerHTML = '<div style="font-size:12px;color:var(--faint);padding:8px 0">Sin feedback recibido todavía.</div>';
          return;
        }
        el.innerHTML = items.map(function (f) {
          var label = FEEDBACK_TYPE_LABEL[f.type] || f.type;
          var when = new Date(f.created_at).toLocaleString('es-CL');
          return '<div style="padding:10px 0;border-bottom:1px solid rgba(var(--ink-rgb),0.06)">' +
            '<div style="display:flex;justify-content:space-between;gap:10px;align-items:baseline">' +
            '<span style="font-size:12px;font-weight:600">' + escHtml(f.resource_name) + ' · <span style="color:var(--accent)">' + escHtml(label) + '</span></span>' +
            '<span style="display:flex;align-items:center;gap:8px;flex-shrink:0">' +
            '<span style="font-size:10px;color:var(--faint);white-space:nowrap">' + when + '</span>' +
            '<button class="fbDeleteBtn" data-id="' + f.id + '" title="Borrar" style="background:transparent;border:none;color:var(--faint);cursor:pointer;padding:2px;display:flex">' +
            '<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>' +
            '</button></span></div>' +
            '<div style="font-size:12px;color:var(--dim);margin-top:3px;white-space:pre-wrap">' + escHtml(f.message) + '</div>' +
            '</div>';
        }).join('');
        Array.prototype.forEach.call(el.querySelectorAll('.fbDeleteBtn'), function (btn) {
          btn.addEventListener('click', function () { deleteFeedback(btn.dataset.id); });
        });
      }).catch(function (err) {
        el.innerHTML = '<div style="font-size:11px;color:#ef4444">' + (err && err.message === 'session' ? 'Sesión expirada, vuelve a ingresar' : 'Error al cargar feedback') + '</div>';
      });
  }

  function deleteFeedback(id) {
    fetch(BASE_URL + '/api/feedback?id=' + encodeURIComponent(id), { method: 'DELETE', headers: adminHeaders() })
      .then(function (r) { if (!r.ok) throw new Error('http'); return loadFeedback(); })
      .catch(function () {});
  }

  function deleteAllFeedback() {
    fetch(BASE_URL + '/api/feedback?all=true', { method: 'DELETE', headers: adminHeaders() })
      .then(function (r) { if (!r.ok) throw new Error('http'); return loadFeedback(); })
      .catch(function () {});
  }

  function diagFeedback() {
    var out = document.getElementById('diagFeedbackOutput');
    var details = document.getElementById('diagFeedbackDetails');
    var status = document.getElementById('diagFeedbackStatus');
    details.style.display = '';
    out.textContent = 'Probando envío de correo (token + sendMail)...';
    status.className = 'configStatus';
    status.style.color = 'var(--dim)';
    status.textContent = '';
    fetch(BASE_URL + '/api/feedback/diagnostic', { headers: adminHeaders() })
      .then(function (r) {
        if (r.status === 403) throw new Error('session');
        return r.json();
      })
      .then(function (data) {
        out.textContent = JSON.stringify(data, null, 2);
        if (data.send && data.send.ok) {
          status.className = 'configStatus ok';
          status.textContent = '✓ Correo de prueba enviado — revisa la bandeja.';
        } else {
          status.className = 'configStatus err';
          status.textContent = '✗ No se pudo enviar — ver detalle abajo.';
        }
      }).catch(function (err) {
        out.textContent = err && err.message === 'session' ? 'Sesión expirada, vuelve a ingresar' : 'Error al consultar diagnóstico';
      });
  }

  function renderLive(tickets) {
    if (liveView === 'tech') { renderLiveByTech(tickets); return; }
    var allUsers = tickets.reduce(function (a, t) {
      return a.concat(t.users.map(function (u) { return userName(u); }));
    }, []);
    document.getElementById('statTickets').textContent = tickets.length;
    document.getElementById('statUsers').textContent = new Set(allUsers).size;
    if (currentTab === 'resources') renderActiveTechsAdmin();
    var el = document.getElementById('liveTab');
    if (!tickets.length) {
      el.innerHTML = '<div class="empty"><div class="emptyIcon">' + ic('check-circle', 30) + '</div><div class="emptyText">Sin colisiones activas</div><div class="emptySub">Todos los técnicos trabajan sin conflictos</div></div>';
      return;
    }
    el.innerHTML = tickets.map(function (t) {
      var isCol = t.users.length > 1;
      var label = t.ticketNumber || '#' + t.ticketId;
      var nameEl = t.ticketUrl
        ? '<a href="' + t.ticketUrl + '" target="_blank" class="ticketLink">' + label + '</a>'
        : label;
      return '<div class="ticketCard ' + (isCol ? 'collision' : '') + '">' +
        '<div class="ticketLeft"><div class="ticketIcon ' + (isCol ? 'col' : '') + '">' + ic(isCol ? 'alert-triangle' : 'ticket', 18) + '</div>' +
        '<div><div class="ticketName">' + nameEl + '</div>' +
        '<div class="ticketMeta">' + t.users.length + ' técnico' + (t.users.length > 1 ? 's' : '') + ' activo' + (t.users.length > 1 ? 's' : '') + '</div></div></div>' +
        '<div class="chips">' + t.users.map(function (u, i) {
          return '<span class="chip ' + (i === 0 ? 'primary' : '') + '">' + userLabel(u) + '</span>';
        }).join('') + '</div></div>';
    }).join('');
  }

  function renderLiveByTech(tickets) {
    var techMap = {};
    tickets.forEach(function (t) {
      t.users.forEach(function (u) {
        var name = userName(u);
        var min = userMinutes(u);
        if (!techMap[name]) techMap[name] = [];
        techMap[name].push({ number: t.ticketNumber || '#' + t.ticketId, minutes: min, collision: t.users.length > 1, url: t.ticketUrl || null });
      });
    });
    var el = document.getElementById('liveTab');
    var techs = Object.keys(techMap);
    if (!techs.length) {
      el.innerHTML = '<div class="empty"><div class="emptyIcon">' + ic('check-circle', 30) + '</div><div class="emptyText">Sin actividad activa</div><div class="emptySub">Todos los técnicos están libres</div></div>';
      return;
    }
    el.innerHTML = techs.map(function (name) {
      var tks = techMap[name];
      var hasCollision = tks.some(function (t) { return t.collision; });
      return '<div class="ticketCard ' + (hasCollision ? 'collision' : '') + '">' +
        '<div class="ticketLeft">' +
        '<div class="techAvatar">' + escHtml(initials(name)) + '</div>' +
        '<div><div class="ticketName">' + escHtml(name) + '</div>' +
        '<div class="ticketMeta">' + tks.length + ' ticket' + (tks.length > 1 ? 's' : '') + ' abierto' + (tks.length > 1 ? 's' : '') + (hasCollision ? ' · <span style="color:#ef4444">' + ic('alert-triangle', 11) + ' colisión</span>' : '') + '</div></div>' +
        '</div><div class="chips">' +
        tks.map(function (t) {
          var chip = t.url
            ? '<a href="' + escHtml(t.url) + '" target="_blank" class="chip ' + (t.collision ? 'primary' : '') + ' chipLink">' + escHtml(t.number) + (t.minutes > 0 ? '<span class="chip-time">· ' + t.minutes + 'm</span>' : '') + '</a>'
            : '<span class="chip ' + (t.collision ? 'primary' : '') + '">' + escHtml(t.number) + (t.minutes > 0 ? '<span class="chip-time">· ' + t.minutes + 'm</span>' : '') + '</span>';
          return chip;
        }).join('') +
        '</div></div>';
    }).join('');
  }

  function applyFilters(history) {
    return history.filter(function (e) {
      if (historyPeriod === 'today' && Date.now() - e.ts > 86400000) return false;
      if (historyPeriod === 'week' && Date.now() - e.ts > 7 * 86400000) return false;
      if (historyPeriod === 'custom') {
        if (dateFrom && e.ts < dateFrom) return false;
        if (dateTo && e.ts > dateTo) return false;
      }
      if (historyFilter) {
        var str = (e.ticketNumber || '') + (e.ticketId || '') + e.users.map(userName).join(' ');
        if (str.toLowerCase().indexOf(historyFilter.toLowerCase()) === -1) return false;
      }
      return true;
    });
  }

  function populateTechFilter() {
    var techSet = {};
    lastHistory.forEach(function (e) {
      (e.users || []).forEach(function (u) { techSet[userName(u)] = true; });
    });
    var sel = document.getElementById('techFilter');
    var current = sel.value;
    while (sel.options.length > 1) sel.remove(1);
    Object.keys(techSet).sort().forEach(function (name) {
      var opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name;
      sel.appendChild(opt);
    });
    sel.value = current;
  }

  function renderHistory(history) {
    var today = lastHistory.filter(function (e) { return Date.now() - e.ts < 86400000; }).length;
    document.getElementById('statHistory').textContent = today;
    populateTechFilter();
    var el = document.getElementById('historyTab');
    if (!history.length) {
      el.innerHTML = '<div class="empty"><div class="emptyIcon">' + ic('clipboard-list', 30) + '</div><div class="emptyText">Sin resultados</div><div class="emptySub">Prueba cambiando los filtros</div></div>';
      return;
    }
    var cards = history.map(function (e) {
      return '<div class="histCard"><div class="histLeft">' + ic('alert-triangle', 16) +
        '<div><div class="histTicket">' + escHtml(e.ticketNumber || '#' + e.ticketId) + '</div>' +
        '<div class="histTime">' + new Date(e.ts).toLocaleString('es-CL') + '</div></div></div>' +
        '<div style="display:flex;align-items:center;gap:8px">' +
        '<div class="chips">' + e.users.map(function (u, i) {
          return '<span class="histChip ' + (i === 0 ? 'first' : '') + '">' + escHtml(userName(u)) + '</span>';
        }).join('') + '</div>' +
        '<button class="histDeleteBtn" data-id="' + escHtml(e.id) + '" title="Borrar este registro" style="background:transparent;border:none;color:var(--faint);cursor:pointer;padding:2px;display:flex;flex-shrink:0">' +
        '<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>' +
        '</button></div></div>';
    }).join('');
    var hasMore = historyOffset < historyTotal && historyPeriod === 'all' && !historyFilter;
    el.innerHTML = cards + (hasMore
      ? '<div style="text-align:center;margin-top:12px"><button id="loadMoreBtn" class="csvBtn" style="margin:0 auto">Cargar más (' + (historyTotal - historyOffset) + ' restantes)</button></div>'
      : '');
    if (hasMore) {
      document.getElementById('loadMoreBtn').addEventListener('click', function () { fetchHistory(true); });
    }
    Array.prototype.forEach.call(el.querySelectorAll('.histDeleteBtn'), function (btn) {
      btn.addEventListener('click', function () {
        if (!confirm('¿Borrar este registro del historial? No se puede deshacer.')) return;
        var id = btn.getAttribute('data-id');
        fetch(BASE_URL + '/api/presence/history?id=' + encodeURIComponent(id), { method: 'DELETE', headers: adminHeaders() })
          .then(function (r) { if (!r.ok) throw new Error('http'); return fetchHistory(false); })
          .catch(function () { alert('Error al borrar el registro'); });
      });
    });
  }

  function exportCsv() {
    var filtered = applyFilters(lastHistory);
    if (!filtered.length) return;
    var rows = [['Fecha', 'Ticket', 'Técnicos']];
    filtered.forEach(function (e) {
      rows.push([
        new Date(e.ts).toLocaleString('es-CL'),
        e.ticketNumber || '#' + e.ticketId,
        e.users.map(userName).join('; ')
      ]);
    });
    var csv = rows.map(function (r) {
      return r.map(function (v) { return '"' + String(v).replace(/"/g, '""') + '"'; }).join(',');
    }).join('\n');
    var blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'colisiones_' + new Date().toISOString().slice(0, 10) + '.csv';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function loadWorkload() {
    var el = document.getElementById('workloadSection');
    if (!el) return;
    fetch(BASE_URL + '/api/team/workload', { headers: adminHeaders() })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (!data.configured || !data.techs || !data.techs.length) { el.innerHTML = ''; return; }
        var rows = data.techs.map(function (t) {
          var avg = t.avgResolutionHours === null ? '—'
            : t.avgResolutionHours < 1 ? Math.round(t.avgResolutionHours * 60) + ' min'
            : Math.round(t.avgResolutionHours * 10) / 10 + ' h';
          return '<tr><td>' + escHtml(t.name) + '</td>' +
            '<td style="text-align:right">' + t.openTickets + '</td>' +
            '<td style="text-align:right">' + t.resolvedLast30d + '</td>' +
            '<td style="text-align:right">' + avg + '</td></tr>';
        }).join('');
        el.innerHTML = '<div class="anlSection"><div class="anlTitle">' + ic('briefcase', 15) + ' Carga por técnico</div>' +
          '<table class="roster-table"><thead><tr><th>Técnico</th><th style="text-align:right">Abiertos</th><th style="text-align:right">Resueltos (30d)</th><th style="text-align:right">Prom. resolución</th></tr></thead><tbody>' + rows + '</tbody></table></div>';
      }).catch(function () { el.innerHTML = ''; });
  }

  function loadAnalytics() {
    var el = document.getElementById('collisionAnalyticsSection');
    el.innerHTML = '<div style="text-align:center;padding:40px;color:var(--faint)">Cargando...</div>';
    fetch(BASE_URL + '/api/presence/analytics', { headers: { 'x-api-key': API_KEY } })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (!data.total) {
          el.innerHTML = '<div class="empty"><div class="emptyIcon">' + ic('bar-chart-3', 30) + '</div><div class="emptyText">Sin datos aún</div><div class="emptySub">Las colisiones aparecerán aquí una vez registradas</div></div>';
          return;
        }
        var maxTech = data.byTech.length ? data.byTech[0].count : 1;
        var maxHour = Math.max.apply(null, data.byHour) || 1;

        var techBars = data.byTech.map(function (t) {
          var w = Math.round((t.count / maxTech) * 100);
          return '<div class="barRow"><div class="barLabel" title="' + t.name + '">' + t.name + '</div>' +
            '<div class="barTrack"><div class="barFill" style="width:' + w + '%"></div></div>' +
            '<div class="barCount">' + t.count + '</div></div>';
        }).join('');

        var hourBars = data.byHour.map(function (c, h) {
          var pct = Math.round((c / maxHour) * 100);
          return '<div class="hourBar" style="height:' + Math.max(pct, c > 0 ? 8 : 2) + '%" title="' + h + ':00 — ' + c + ' colisiones"></div>';
        }).join('');
        var hourLabels = data.byHour.map(function (_, h) {
          return '<div class="hourLbl">' + (h % 3 === 0 ? h + 'h' : '') + '</div>';
        }).join('');

        var topTickets = data.topTickets.map(function (t) {
          var w = Math.round((t.count / (data.topTickets[0].count || 1)) * 100);
          return '<div class="barRow"><div class="barLabel">' + t.ticket + '</div>' +
            '<div class="barTrack"><div class="barFill blue" style="width:' + w + '%"></div></div>' +
            '<div class="barCount">' + t.count + '</div></div>';
        }).join('');

        var pairsHtml = '';
        if (data.pairs && data.pairs.length) {
          var maxPair = data.pairs[0].count || 1;
          var pairBars = data.pairs.map(function (p) {
            var w = Math.round((p.count / maxPair) * 100);
            return '<div class="barRow"><div class="barLabel" title="' + p.pair + '">' + p.pair + '</div>' +
              '<div class="barTrack"><div class="barFill" style="width:' + w + '%;background:linear-gradient(90deg,#8C52FF,#6d28d9)"></div></div>' +
              '<div class="barCount">' + p.count + 'x</div></div>';
          }).join('');
          pairsHtml = '<div class="anlSection"><div class="anlTitle">' + ic('link-2', 15) + ' Pares que más colisionan</div>' + pairBars + '</div>';
        }

        var durStr = '';
        if (data.avgDurationSecs) {
          var avgMin = Math.floor(data.avgDurationSecs / 60);
          var avgSec = data.avgDurationSecs % 60;
          var maxMin = Math.floor((data.maxDurationSecs || 0) / 60);
          durStr = '<div class="anlSection"><div class="anlTitle">' + ic('clock', 15) + ' Duración de colisiones <span style="font-weight:400;color:var(--faint);font-size:12px">· ' + data.resolvedCount + ' registradas</span></div>' +
            '<div style="display:flex;gap:24px;margin-top:4px">' +
            '<div><div style="font-size:24px;font-weight:800;color:var(--accent)">' + (avgMin > 0 ? avgMin + 'm ' : '') + avgSec + 's</div><div style="font-size:11px;color:var(--dim);margin-top:2px">Duración promedio</div></div>' +
            '<div><div style="font-size:24px;font-weight:700;color:var(--dim)">' + (maxMin > 0 ? maxMin + 'm ' : '') + (data.maxDurationSecs % 60) + 's</div><div style="font-size:11px;color:var(--dim);margin-top:2px">Máxima registrada</div></div>' +
            '</div></div>';
        }

        var dayHtml = '';
        if (data.byDay && data.byDay.length) {
          var maxDay = Math.max.apply(null, data.byDay.map(function (d) { return d.count; })) || 1;
          var dayBars = data.byDay.map(function (d) {
            var pct = Math.round((d.count / maxDay) * 100);
            return '<div class="dayBar" style="height:' + Math.max(pct, d.count > 0 ? 8 : 2) + '%" title="' + d.date + ' — ' + d.count + ' col."></div>';
          }).join('');
          var dayLabels = data.byDay.map(function (d, i) {
            var day = d.date.slice(8); // DD
            return '<div class="dayLbl">' + (i % 5 === 0 ? day : '') + '</div>';
          }).join('');
          dayHtml = '<div class="anlSection"><div class="anlTitle">' + ic('calendar', 15) + ' Tendencia últimos 30 días</div>' +
            '<div class="dayGrid">' + dayBars + '</div>' +
            '<div class="dayLabels">' + dayLabels + '</div></div>';
        }

        el.innerHTML =
          dayHtml +
          '<div class="anlSection"><div class="anlTitle">' + ic('users', 15) + ' Técnicos con más colisiones <span style="font-weight:400;color:var(--faint);font-size:12px">· total ' + data.total + '</span></div>' + techBars + '</div>' +
          pairsHtml +
          '<div class="anlSection"><div class="anlTitle">' + ic('clock', 15) + ' Colisiones por hora del día</div>' +
            '<div class="hourGrid">' + hourBars + '</div>' +
            '<div class="hourLabels">' + hourLabels + '</div></div>' +
          (data.topTickets.length ? '<div class="anlSection"><div class="anlTitle">' + ic('ticket', 15) + ' Tickets con más colisiones</div>' + topTickets + '</div>' : '') +
          durStr;
      }).catch(function () {
        el.innerHTML = '<div class="empty"><div class="emptyIcon" style="color:#ef4444">' + ic('alert-triangle', 30) + '</div><div class="emptyText">Error al cargar análisis</div></div>';
      });
  }

  function loadErrorLog() {
    var el = document.getElementById('errorLogList');
    if (!el) return;
    el.innerHTML = '<div style="font-size:11px;color:var(--faint)">Cargando...</div>';
    fetch(BASE_URL + '/api/errors?limit=30', { headers: adminHeaders() })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        var items = data.items || [];
        if (!items.length) {
          el.innerHTML = '<div style="font-size:12px;color:var(--faint);padding:8px 0">Sin errores registrados.</div>';
          return;
        }
        el.innerHTML = items.map(function (e) {
          var when = new Date(e.created_at).toLocaleString('es-CL');
          return '<div style="padding:8px 0;border-bottom:1px solid rgba(var(--ink-rgb),0.06)">' +
            '<div style="display:flex;justify-content:space-between;gap:10px;align-items:baseline">' +
            '<span style="font-size:11px;font-weight:600;color:#ef4444">' + escHtml(e.source) + '</span>' +
            '<span style="font-size:10px;color:var(--faint);white-space:nowrap">' + when + '</span></div>' +
            '<div style="font-size:12px;color:var(--dim);margin-top:2px">' + escHtml(e.message) + '</div>' +
            (e.detail ? '<pre style="font-size:10px;color:var(--faint);margin-top:4px;white-space:pre-wrap;overflow-x:auto">' + escHtml(e.detail) + '</pre>' : '') +
            '</div>';
        }).join('');
      }).catch(function () {
        el.innerHTML = '<div style="font-size:11px;color:#ef4444">Error al cargar el registro.</div>';
      });
  }

  function loadConfig() {
    loadErrorLog();
    fetch(BASE_URL + '/api/config', { headers: { 'x-api-key': API_KEY } })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        document.getElementById('webhookInput').value = data.teamsWebhook || '';
        document.getElementById('ttlInput').value = data.presenceTtl || 40;
        document.getElementById('autotaskUiBaseInput').value = data.autotaskUiBase || '';
        var wh = data.workHours;
        if (wh) {
          document.getElementById('workHoursEnabled').checked = !!wh.enabled;
          document.getElementById('workStart').value = wh.start ?? 8;
          document.getElementById('workEnd').value = wh.end ?? 18;
          document.getElementById('workTz').value = wh.tz || 'America/Santiago';
        }
      }).catch(function () {});
  }

  function saveWorkHours() {
    var status = document.getElementById('workHoursStatus');
    var enabled = document.getElementById('workHoursEnabled').checked;
    var start = parseInt(document.getElementById('workStart').value) || 8;
    var end = parseInt(document.getElementById('workEnd').value) || 18;
    var tz = document.getElementById('workTz').value;
    fetch(BASE_URL + '/api/config', {
      method: 'POST',
      headers: adminHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ workHours: { enabled: enabled, start: start, end: end, tz: tz } })
    }).then(function (r) {
      if (!r.ok) throw new Error(r.status === 403 ? 'session' : 'http');
      status.className = 'configStatus ok';
      status.textContent = '✓ Horario guardado';
      setTimeout(function () { status.textContent = ''; }, 3000);
    }).catch(function (err) {
      status.className = 'configStatus err';
      status.textContent = err && err.message === 'session' ? '✗ Sesión expirada' : '✗ Error al guardar';
    });
  }

  function syncResources() {
    var status = document.getElementById('syncResourcesStatus');
    status.className = 'configStatus';
    status.style.color = 'var(--dim)';
    status.textContent = 'Sincronizando con Autotask...';
    fetch(BASE_URL + '/api/resources/sync', { method: 'POST', headers: adminHeaders() })
      .then(function (r) {
        if (r.status === 403) throw new Error('session');
        return r.json();
      })
      .then(function (data) {
        status.style.color = '';
        if (!data.ran) {
          status.className = 'configStatus err';
          status.textContent = '⚠ No se ejecutó: ' + (data.detail || data.error || 'sin credenciales o error de Supabase');
        } else {
          status.className = 'configStatus ok';
          status.textContent = '✓ Roster actualizado · ' + data.synced + ' activos' + (data.deactivated ? ', ' + data.deactivated + ' desactivados' : '');
        }
        setTimeout(function () { status.textContent = ''; }, 6000);
      }).catch(function (err) {
        status.style.color = '';
        status.className = 'configStatus err';
        status.textContent = err && err.message === 'session' ? '✗ Sesión expirada, vuelve a ingresar' : '✗ Error al sincronizar';
      });
  }

  function toggleResourceActive(autotaskResourceId, nextActive) {
    return fetch(BASE_URL + '/api/resources', {
      method: 'PATCH',
      headers: Object.assign({ 'Content-Type': 'application/json' }, adminHeaders()),
      body: JSON.stringify({ autotask_resource_id: autotaskResourceId, active: nextActive }),
    });
  }

  var lastRosterList = [];

  function renderRoster() {
    var el = document.getElementById('rosterList');
    if (!el) return;
    var list = lastRosterList;
    if (!list.length) { el.innerHTML = '<div style="font-size:11px;color:var(--faint)">Sin técnicos sincronizados. Usa "Sincronizar desde Autotask" primero.</div>'; return; }
    var activeCount = list.filter(function (r) { return r.active; }).length;
    var countEl = document.getElementById('rosterCount');
    if (countEl) countEl.textContent = activeCount + ' activos · ' + (list.length - activeCount) + ' inactivos · ' + list.length + ' total';
    var showInactive = document.getElementById('rosterShowInactive');
    var visible = (showInactive && showInactive.checked) ? list : list.filter(function (r) { return r.active; });
    if (!visible.length) {
      el.innerHTML = '<div style="font-size:11px;color:var(--faint)">Todos los inactivos están ocultos. Activa "Mostrar inactivos" para verlos.</div>';
      return;
    }
    var rows = visible.map(function (r) {
      var badge = r.active
        ? '<span class="roster-badge active">Activo</span>'
        : '<span class="roster-badge inactive">Inactivo</span>';
      var btnLabel = r.active ? 'Quitar del roster' : 'Reactivar';
      var btn = '<button class="rosterToggleBtn" data-id="' + r.autotask_resource_id + '" data-next="' + (!r.active) + '" style="font-size:10px;padding:2px 8px;border-radius:10px;border:1px solid var(--border);background:transparent;color:var(--dim);cursor:pointer">' + btnLabel + '</button>';
      // r.title es el cargo tal cual lo trae Autotask (ej. "Técnico", "Ingeniero de
      // Soporte") — texto libre, distinto de r.role (que es un valor interno fijo,
      // 'tech' para todos, no pensado para mostrarse).
      return '<tr><td>' + escHtml(r.name) + '</td><td>' + escHtml(r.email || '—') + '</td><td>' + escHtml(r.title || '—') + '</td><td>' + badge + '</td><td>' + btn + '</td></tr>';
    }).join('');
    el.innerHTML = '<table class="roster-table"><thead><tr><th>Nombre</th><th>Email</th><th>Cargo</th><th>Estado</th><th></th></tr></thead><tbody>' + rows + '</tbody></table>';
    Array.prototype.forEach.call(el.querySelectorAll('.rosterToggleBtn'), function (btn) {
      btn.addEventListener('click', function () {
        var id = Number(btn.getAttribute('data-id'));
        var next = btn.getAttribute('data-next') === 'true';
        btn.disabled = true;
        btn.textContent = '...';
        toggleResourceActive(id, next).then(function () { loadRoster(); }).catch(function () {
          btn.disabled = false;
          btn.textContent = next ? 'Reactivar' : 'Quitar del roster';
        });
      });
    });
  }

  function loadRoster() {
    var el = document.getElementById('rosterList');
    if (!el) return;
    el.innerHTML = '<div style="font-size:11px;color:var(--faint)">Cargando...</div>';
    fetch(BASE_URL + '/api/resources', { headers: adminHeaders() })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        lastRosterList = data.resources || [];
        renderRoster();
      }).catch(function () {
        el.innerHTML = '<div style="font-size:11px;color:#ef4444">Error al cargar el roster.</div>';
      });
  }

  function diagResources() {
    var out = document.getElementById('diagResourcesOutput');
    var details = document.getElementById('diagResourcesDetails');
    var status = document.getElementById('syncResourcesStatus');
    details.style.display = '';
    details.open = true; // recién llegó un resultado nuevo, se abre para verlo de inmediato
    out.textContent = 'Consultando API de Autotask...';
    status.className = 'configStatus';
    status.style.color = 'var(--dim)';
    status.textContent = '';
    fetch(BASE_URL + '/api/resources/diagnostic', { headers: adminHeaders() })
      .then(function (r) {
        if (r.status === 403) throw new Error('session');
        return r.json();
      })
      .then(function (data) {
        out.textContent = JSON.stringify(data, null, 2);
      }).catch(function (err) {
        out.textContent = err && err.message === 'session' ? 'Sesión expirada, vuelve a ingresar' : 'Error al consultar diagnóstico';
      });
  }

  function saveUiBase() {
    var val = document.getElementById('autotaskUiBaseInput').value.trim();
    var status = document.getElementById('uiBaseStatus');
    fetch(BASE_URL + '/api/config', {
      method: 'POST',
      headers: adminHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ autotaskUiBase: val })
    }).then(function (r) {
      if (!r.ok) throw new Error(r.status === 403 ? 'session' : 'http');
      status.className = 'configStatus ok';
      status.textContent = val ? '✓ URL guardada' : '✓ URL borrada';
      setTimeout(function () { status.textContent = ''; }, 3000);
    }).catch(function (err) {
      status.className = 'configStatus err';
      status.textContent = err && err.message === 'session' ? '✗ Sesión expirada' : '✗ Error al guardar';
    });
  }

  function saveTtl() {
    var val = parseInt(document.getElementById('ttlInput').value) || 40;
    val = Math.max(15, Math.min(300, val));
    var status = document.getElementById('ttlStatus');
    fetch(BASE_URL + '/api/config', {
      method: 'POST',
      headers: adminHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ presenceTtl: val })
    }).then(function (r) {
      if (!r.ok) throw new Error(r.status === 403 ? 'session' : 'http');
      status.className = 'configStatus ok';
      status.textContent = '✓ TTL guardado: ' + val + 's';
      setTimeout(function () { status.textContent = ''; }, 3000);
    }).catch(function (err) {
      status.className = 'configStatus err';
      status.textContent = err && err.message === 'session' ? '✗ Sesión expirada, vuelve a ingresar' : '✗ Error al guardar';
    });
  }

  function saveWebhook() {
    var url = document.getElementById('webhookInput').value.trim();
    var status = document.getElementById('webhookStatus');
    fetch(BASE_URL + '/api/config', {
      method: 'POST',
      headers: adminHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ teamsWebhook: url })
    }).then(function (r) {
      if (!r.ok) throw new Error(r.status === 403 ? 'session' : 'http');
      status.className = 'configStatus ok';
      status.textContent = '✓ Webhook guardado';
      setTimeout(function () { status.textContent = ''; }, 3000);
    }).catch(function (err) {
      status.className = 'configStatus err';
      status.textContent = err && err.message === 'session' ? '✗ Sesión expirada, vuelve a ingresar' : '✗ Error al guardar';
    });
  }

  function testWebhook() {
    var url = document.getElementById('webhookInput').value.trim();
    var status = document.getElementById('webhookStatus');
    if (!url) { status.className = 'configStatus err'; status.textContent = 'Ingresa una URL primero'; return; }
    var body = {
      '@type': 'MessageCard', '@context': 'http://schema.org/extensions',
      themeColor: '3867E9', summary: '✅ Prueba de webhook',
      sections: [{ activityTitle: '✅ Webhook configurado correctamente', activitySubtitle: 'Autotask CoView · Netsus', activityText: 'Las alertas de colisión llegarán a este canal.' }]
    };
    fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then(function () {
        status.className = 'configStatus ok';
        status.textContent = '✓ Mensaje de prueba enviado a Teams';
        setTimeout(function () { status.textContent = ''; }, 4000);
      }).catch(function () {
        status.className = 'configStatus err';
        status.textContent = '✗ Error — verifica la URL del webhook';
      });
  }

  function clearWebhook() {
    document.getElementById('webhookInput').value = '';
    saveWebhook();
  }

  // Event listeners
  document.getElementById('viewByTicket').addEventListener('click', function () {
    liveView = 'ticket';
    document.getElementById('viewByTicket').classList.add('active');
    document.getElementById('viewByTech').classList.remove('active');
    renderLive(lastTickets);
  });
  document.getElementById('viewByTech').addEventListener('click', function () {
    liveView = 'tech';
    document.getElementById('viewByTech').classList.add('active');
    document.getElementById('viewByTicket').classList.remove('active');
    renderLive(lastTickets);
  });

  document.getElementById('loginBtn').addEventListener('click', doLogin);
  document.getElementById('pwdInput').addEventListener('keydown', function (e) { if (e.key === 'Enter') doLogin(); });
  document.getElementById('forgotPwdLink').addEventListener('click', function (e) { e.preventDefault(); showForgotStep(); });
  document.getElementById('backToLoginLink').addEventListener('click', function (e) { e.preventDefault(); showLoginStep(); });
  document.getElementById('sendResetCodeBtn').addEventListener('click', sendResetCode);
  document.getElementById('resetPwdBtn').addEventListener('click', submitResetPassword);
  document.getElementById('resetNewPwdInput').addEventListener('keydown', function (e) { if (e.key === 'Enter') submitResetPassword(); });
  document.getElementById('logoutBtn').addEventListener('click', doLogout);
  document.getElementById('tabLive').addEventListener('click', function () { setTab('live'); });
  document.getElementById('tabHistory').addEventListener('click', function () { setTab('history'); });
  document.getElementById('tabAnalytics').addEventListener('click', function () { setTab('analytics'); });
  document.getElementById('tabResources').addEventListener('click', function () { setTab('resources'); });
  document.getElementById('tabNotif').addEventListener('click', function () { setTab('notif'); });
  document.getElementById('tabFeedback').addEventListener('click', function () { setTab('feedback'); });
  document.getElementById('diagFeedbackBtn').addEventListener('click', diagFeedback);
  document.getElementById('clearFeedbackBtn').addEventListener('click', function () {
    if (!confirm('¿Borrar todo el feedback recibido? Esta acción no se puede deshacer.')) return;
    deleteAllFeedback();
  });
  document.getElementById('tabConfig').addEventListener('click', function () { setTab('config'); });
  document.getElementById('clearErrorLogBtn').addEventListener('click', function () {
    if (!confirm('¿Borrar el historial de errores registrados?')) return;
    fetch(BASE_URL + '/api/errors?all=true', { method: 'DELETE', headers: adminHeaders() })
      .then(function (r) { if (!r.ok) throw new Error('http'); return loadErrorLog(); })
      .catch(function () {});
  });
  document.getElementById('exportCsvBtn').addEventListener('click', exportCsv);
  document.getElementById('saveTtlBtn').addEventListener('click', saveTtl);
  document.getElementById('saveUiBaseBtn').addEventListener('click', saveUiBase);
  document.getElementById('syncResourcesBtn').addEventListener('click', syncResources);
  document.getElementById('diagResourcesBtn').addEventListener('click', diagResources);
  document.getElementById('rosterShowInactive').addEventListener('change', renderRoster);
  document.getElementById('saveWebhookBtn').addEventListener('click', saveWebhook);
  document.getElementById('testWebhookBtn').addEventListener('click', testWebhook);
  document.getElementById('clearWebhookBtn').addEventListener('click', clearWebhook);

  document.getElementById('saveWorkHoursBtn').addEventListener('click', saveWorkHours);

  document.getElementById('historySearch').addEventListener('input', function () {
    historyFilter = this.value;
    renderHistory(applyFilters(lastHistory));
  });

  document.getElementById('techFilter').addEventListener('change', function () {
    historyTechFilter = this.value;
    historyOffset = 0;
    fetchHistory(false);
  });

  document.getElementById('clearHistoryBtn').addEventListener('click', function () {
    if (!confirm('¿Borrar todo el historial de colisiones? Esta acción no se puede deshacer.')) return;
    fetch(BASE_URL + '/api/presence/history', { method: 'DELETE', headers: adminHeaders() })
      .then(function (r) {
        if (!r.ok) throw new Error(r.status === 403 ? 'session' : 'http');
        lastHistory = [];
        historyOffset = 0;
        historyTotal = 0;
        renderHistory([]);
        document.getElementById('statHistory').textContent = '0';
      }).catch(function (err) {
        alert(err && err.message === 'session' ? 'Sesión expirada, vuelve a ingresar' : 'Error al borrar el historial');
      });
  });

  document.querySelectorAll('.periodBtn').forEach(function (btn) {
    btn.addEventListener('click', function () {
      historyPeriod = this.dataset.period;
      document.querySelectorAll('.periodBtn').forEach(function (b) { b.classList.remove('active'); });
      this.classList.add('active');
      document.getElementById('dateRangeRow').style.display = historyPeriod === 'custom' ? 'flex' : 'none';
      renderHistory(applyFilters(lastHistory));
    });
  });

  document.getElementById('dateFrom').addEventListener('change', function () {
    dateFrom = this.value ? new Date(this.value).getTime() : null;
    renderHistory(applyFilters(lastHistory));
  });
  document.getElementById('dateTo').addEventListener('change', function () {
    dateTo = this.value ? new Date(this.value + 'T23:59:59').getTime() : null;
    renderHistory(applyFilters(lastHistory));
  });

  if (sessionStorage.getItem('netsus_admin') === '1') {
    showPanel();
  }
})();
