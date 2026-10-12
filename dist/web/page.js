/**
 * The dashboard SPA, served as one self-contained page. Kept out of server.ts so
 * the route file stays about routing. Client code uses string concatenation
 * (not template literals) so it survives being embedded in one here.
 */
export function dashboardHtml() {
    return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Attendance Dashboard</title>
<style>
:root{--bg:#0b0e14;--panel:#121722;--line:#232a38;--fg:#e8ecf4;--muted:#93a0b8;
--accent:#5865f2;--good:#3ba55d;--warn:#e8a13a;--bad:#e04b4b;--live:#3ba55d}
*{box-sizing:border-box}
body{font-family:system-ui,-apple-system,Segoe UI,sans-serif;margin:0;background:var(--bg);color:var(--fg)}
header{padding:1.25rem 1.5rem;border-bottom:1px solid var(--line);display:flex;flex-wrap:wrap;gap:.75rem;align-items:center}
h1{font-size:1.15rem;margin:0;margin-right:auto}
main{padding:1.25rem 1.5rem;max-width:1200px}
input,select,button{padding:.45rem .6rem;background:var(--panel);color:var(--fg);
border:1px solid var(--line);border-radius:6px;font:inherit}
button{cursor:pointer}button:hover{border-color:var(--accent)}
button.primary{background:var(--accent);border-color:var(--accent)}
nav{display:flex;gap:.35rem;flex-wrap:wrap;margin-bottom:1rem}
nav button{background:transparent}
nav button.active{background:var(--panel);border-color:var(--accent);color:#fff}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:.75rem;margin-bottom:1.25rem}
.card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:.85rem 1rem}
.card .k{font-size:.75rem;color:var(--muted);text-transform:uppercase;letter-spacing:.04em}
.card .v{font-size:1.5rem;font-weight:600;margin-top:.2rem}
.wrap{overflow-x:auto;border:1px solid var(--line);border-radius:10px;background:var(--panel)}
table{border-collapse:collapse;width:100%;font-size:.92rem;min-width:640px}
th,td{padding:.55rem .75rem;text-align:left;border-bottom:1px solid var(--line);white-space:nowrap}
th{background:#161d29;font-size:.78rem;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);
position:sticky;top:0;cursor:pointer;user-select:none}
tbody tr:hover{background:#161d29}
tbody tr:last-child td{border-bottom:none}
.bar{height:8px;border-radius:4px;background:#2a3242;min-width:80px}
.bar>span{display:block;height:100%;border-radius:4px;background:var(--good)}
.pill{display:inline-block;padding:.1rem .45rem;border-radius:99px;font-size:.75rem;border:1px solid var(--line)}
.pill.live{color:#fff;background:var(--live);border-color:var(--live)}
.pill.absent{color:#fff;background:var(--bad);border-color:var(--bad)}
.pill.late{color:#20160a;background:var(--warn);border-color:var(--warn)}
.pill.present{color:#fff;background:var(--good);border-color:var(--good)}
.muted{color:var(--muted)}
.spark{display:flex;align-items:flex-end;gap:3px;height:70px;padding:.75rem;
background:var(--panel);border:1px solid var(--line);border-radius:10px;margin-bottom:1.25rem}
.spark div{flex:1;background:var(--accent);border-radius:3px 3px 0 0;min-height:2px;position:relative}
.spark div:hover{background:#7d88f7}
.msg{padding:1rem;color:var(--muted)}
#filters{display:flex;gap:.5rem;flex-wrap:wrap;align-items:center;margin-bottom:1rem}
#filters.hidden{display:none}
.pill.ok{color:#fff;background:var(--good);border-color:var(--good)}
.pill.warn{color:#20160a;background:var(--warn);border-color:var(--warn)}
.pill.bad{color:#fff;background:var(--bad);border-color:var(--bad)}
.pill.off{color:var(--muted)}
.policy{color:var(--muted);font-size:.85rem;margin:0 0 .75rem}
.hidden{display:none}
.detail td{white-space:normal;background:#0f141d}
</style></head><body>
<header>
  <h1>Attendance Dashboard</h1>
  <select id="days">
    <option value="1">Today</option>
    <option value="7" selected>Last 7 days</option>
    <option value="30">Last 30 days</option>
    <option value="90">Last 90 days</option>
    <option value="0">All time</option>
  </select>
  <button class="primary" id="reload">Refresh</button>
  <button id="auto" title="Refresh the current tab every 30 seconds">⏸ Auto</button>
  <span class="muted" id="tz"></span>
  <span class="muted" id="stamp"></span>
</header>
<main>
  <nav>
    <button data-tab="overview" class="active">Overview</button>
    <button data-tab="compliance">Rule compliance</button>
    <button data-tab="voice">Voice hours</button>
    <button data-tab="live">Live now</button>
    <button data-tab="meetings-lb">Meeting attendance</button>
    <button data-tab="meetings">Meetings</button>
  </nav>
  <div id="filters">
    <input id="search" placeholder="Filter by name, project, batch…" size="26">
    <select id="status">
      <option value="">All members</option>
      <option value="live">In voice now</option>
      <option value="active">Active (has time)</option>
      <option value="inactive">Inactive (no time)</option>
      <option value="compliant">Following rules</option>
      <option value="breach">Breaking rules</option>
      <option value="late-login">Late login</option>
      <option value="short-hours">Short hours</option>
      <option value="absent">Absent</option>
    </select>
    <input id="day" type="date" title="Compliance day">
    <span class="muted" id="count"></span>
  </div>
  <div id="view"><div class="msg">Loading…</div></div>
</main>
<script>
var state = { tab: 'overview', data: {}, sort: {}, auto: false };
var AUTO_MS = 30000;
var autoTimer = null;

function q(id){ return document.getElementById(id); }
function days(){ return q('days').value; }
function esc(s){ return String(s == null ? '' : s).replace(/[&<>"]/g, function(c){
  return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]; }); }
function hm(sec){
  sec = Math.max(0, Math.round(sec || 0));
  var h = Math.floor(sec/3600), m = Math.floor((sec%3600)/60);
  return h + 'h ' + (m < 10 ? '0' : '') + m + 'm';
}
function dt(v){ return v ? new Date(v).toLocaleString() : ''; }
function tm(v){ return v ? new Date(v).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'}) : '—'; }
function ago(v){
  if (!v) return 'never';
  var s = Math.round((Date.now() - new Date(v).getTime()) / 1000);
  if (s < 90) return 'just now';
  var m = Math.round(s/60); if (m < 60) return m + 'm ago';
  var h = Math.round(m/60); if (h < 24) return h + 'h ago';
  return Math.round(h/24) + 'd ago';
}

var STATUS_PILL = {
  'compliant':     ['ok',   'following rules'],
  'in-progress':   ['off',  'in progress'],
  'not-joined-yet':['off',  'not joined yet'],
  'late-login':    ['warn', 'late login'],
  'short-hours':   ['warn', 'short hours'],
  'late-and-short':['bad',  'late + short'],
  'absent':        ['bad',  'absent'],
  'off-day':       ['off',  'off day']
};
var BREACH = ['late-login','short-hours','late-and-short','absent'];
// Status options that only mean something on the compliance tab.
var COMPLIANCE_ONLY = ['compliant','breach','late-login','short-hours','absent'];

/**
 * Apply the search + status filter bar. The get() argument maps a row to the
 * fields the filters look at, so every tab reuses this whatever its row shape.
 */
function filt(list, get){
  var s = q('search').value.trim().toLowerCase();
  var st = q('status').value;
  var out = list.filter(function(r){
    var m = get(r);
    if (s && (m.text || '').toLowerCase().indexOf(s) === -1) return false;
    if (!st) return true;
    if (st === 'live') return !!m.live;
    if (st === 'active') return (m.seconds || 0) > 0;
    if (st === 'inactive') return (m.seconds || 0) === 0;
    if (st === 'compliant') return m.status === 'compliant';
    if (st === 'breach') return BREACH.indexOf(m.status) !== -1;
    if (st === 'late-login') return m.status === 'late-login' || m.status === 'late-and-short';
    if (st === 'short-hours') return m.status === 'short-hours' || m.status === 'late-and-short';
    if (st === 'absent') return m.status === 'absent';
    return true;
  });
  q('count').textContent = 'showing ' + out.length + ' of ' + list.length;
  return out;
}

function api(path){
  var sep = path.indexOf('?') === -1 ? '?' : '&';
  return fetch(path + sep + 'days=' + encodeURIComponent(days()))
    .then(function(r){
      if (!r.ok) return r.json().catch(function(){ return {}; }).then(function(j){
        throw new Error(j.error || ('HTTP ' + r.status));
      });
      return r.json();
    });
}

function cards(items){
  return '<div class="cards">' + items.map(function(i){
    return '<div class="card"><div class="k">' + esc(i[0]) + '</div><div class="v">' + esc(i[1]) + '</div></div>';
  }).join('') + '</div>';
}

function table(cols, rows, opts){
  opts = opts || {};
  if (!rows.length) return '<div class="msg">No data for this range.</div>';
  var head = cols.map(function(c, i){ return '<th data-col="' + i + '">' + esc(c) + '</th>'; }).join('');
  var body = rows.map(function(r){
    return '<tr' + (r.id ? ' data-user="' + esc(r.id) + '"' : '') + '>' +
      r.cells.map(function(c){ return '<td>' + c + '</td>'; }).join('') + '</tr>';
  }).join('');
  return '<div class="wrap"><table id="' + (opts.id || 'tbl') + '"><thead><tr>' + head +
    '</tr></thead><tbody>' + body + '</tbody></table></div>';
}

function sparkline(days){
  var max = Math.max.apply(null, days.map(function(d){ return d.seconds; }).concat([1]));
  return '<div class="spark">' + days.map(function(d){
    var pct = Math.max(2, Math.round(d.seconds / max * 100));
    return '<div style="height:' + pct + '%" title="' + esc(d.day) + ' — ' + hm(d.seconds) +
      ' · ' + d.members + ' member(s)"></div>';
  }).join('') + '</div>';
}

var views = {
  overview: function(){
    return Promise.all([api('/api/overview'), api('/api/voice')]).then(function(res){
      var o = res[0], v = res[1];
      var html = cards([
        ['In voice now', o.voice.liveNow],
        ['Active today', o.voice.activeToday],
        ['Voice total (range)', hm(o.voice.totalSeconds)],
        ['Members tracked', o.voice.trackedMembers],
        ['Meeting attendance', o.meetings.attendancePct + '%'],
        ['Present / Late', o.meetings.present + ' / ' + o.meetings.late],
        ['Absent / Excused', o.meetings.absent + ' / ' + o.meetings.excused],
        ['Meetings', o.meetings.totalMeetings]
      ]);
      html += '<h3>Voice seconds per day (' + esc(v.range.from) + ' → ' + esc(v.range.to) + ')</h3>';
      html += sparkline(v.days);
      html += '<h3>Top voice presence</h3>';
      html += table(['Member', 'Project', 'M/P', 'Total', 'Days', 'Avg/day', ''],
        v.members.slice(0, 15).map(function(m){
          return { id: m.userId, cells: [
            esc(m.fullName), esc(m.project || '—'),
            (m.module || '?') + '/' + (m.pod || '?'),
            hm(m.seconds), m.daysActive, hm(m.avgSecondsPerActiveDay),
            m.live ? '<span class="pill live">live</span>' : ''
          ] };
        }));
      return html;
    });
  },

  compliance: function(){
    return api('/api/compliance?day=' + encodeURIComponent(q('day').value)).then(function(c){
      var p = c.policy;
      var rows = filt(c.rows, function(r){
        return { text: r.fullName + ' ' + (r.project||'') + ' ' + (r.batch||''),
                 live: r.live, seconds: r.seconds, status: r.status };
      });
      var tally = { compliant: 0, breach: 0, live: 0 };
      c.rows.forEach(function(r){
        if (r.status === 'compliant') tally.compliant++;
        if (BREACH.indexOf(r.status) !== -1) tally.breach++;
        if (r.live) tally.live++;
      });
      var html = '<p class="policy">Rules for <b>' + esc(c.day) + '</b>' +
        (c.workday ? '' : ' — <b>not a working day</b>, everyone is marked off-day') +
        ': join by <b>' + esc(p.loginBy) + '</b> (window opens ' + esc(p.windowStart) +
        '), serve <b>' + p.minHours + 'h</b> before ' + esc(p.windowEnd) + '.</p>';
      html += cards([
        ['Following rules', tally.compliant],
        ['Breaking rules', tally.breach],
        ['In voice now', tally.live],
        ['Members', c.rows.length]
      ]);
      html += table(['Member', 'Project', 'M/P', 'First join', 'Served', 'Required', 'Last activity', 'Status'],
        rows.map(function(r){
          var pill = STATUS_PILL[r.status] || ['off', r.status];
          return { id: r.userId, cells: [
            esc(r.fullName) + (r.live ? ' <span class="pill live">live</span>' : ''),
            esc(r.project || '—'),
            (r.module || '?') + '/' + (r.pod || '?'),
            (r.firstJoinAt ? tm(r.firstJoinAt) : '—') +
              (r.firstJoinAt && !r.loginOnTime ? ' <span class="pill warn">late</span>' : ''),
            hm(r.seconds),
            hm(r.requiredSeconds),
            '<span title="' + esc(dt(r.lastSeenAt)) + '">' + esc(ago(r.lastSeenAt)) + '</span>',
            '<span class="pill ' + pill[0] + '">' + esc(pill[1]) + '</span>'
          ] };
        }), { id: 'compTbl' });
      return html;
    });
  },

  voice: function(){
    return api('/api/voice').then(function(v){
      var max = Math.max.apply(null, v.members.map(function(m){ return m.seconds; }).concat([1]));
      var html = sparkline(v.days);
      var members = filt(v.members, function(m){
        return { text: m.fullName + ' ' + (m.project||'') + ' ' + (m.batch||''),
                 live: m.live, seconds: m.seconds };
      });
      html += table(['#', 'Member', 'Batch', 'Project', 'M/P', 'Total', '', 'Days active', 'Avg/day', ''],
        members.map(function(m, i){
          var pct = Math.round(m.seconds / max * 100);
          return { id: m.userId, cells: [
            i + 1, esc(m.fullName), esc(m.batch || '—'), esc(m.project || '—'),
            (m.module || '?') + '/' + (m.pod || '?'),
            hm(m.seconds),
            '<div class="bar"><span style="width:' + pct + '%"></span></div>',
            m.daysActive, hm(m.avgSecondsPerActiveDay),
            m.live ? '<span class="pill live">live</span>' : ''
          ] };
        }), { id: 'voiceTbl' });
      html += '<p class="muted">Click a row for that member\\'s daily breakdown.</p>';
      return html;
    });
  },

  live: function(){
    return api('/api/live').then(function(all){
      var rows = filt(all, function(r){
        return { text: r.fullName + ' ' + (r.project||''), live: true, seconds: r.seconds };
      });
      return cards([['Connected now', all.length]]) +
        table(['Member', 'Project', 'M/P', 'Channel', 'Joined', 'Duration'],
          rows.map(function(r){
            return { id: r.userId, cells: [
              esc(r.fullName), esc(r.project || '—'),
              (r.module || '?') + '/' + (r.pod || '?'),
              '<span class="muted">' + esc(r.channelId) + '</span>',
              dt(r.joinedAt), hm(r.seconds)
            ] };
          }));
    });
  },

  'meetings-lb': function(){
    return api('/api/leaderboard').then(function(all){
      if (!all.length) return '<div class="msg">No meetings in this range. Try a wider range — "All time" is at the top right.</div>';
      var rows = filt(all, function(m){
        return { text: m.fullName + ' ' + (m.project||''), seconds: m.total };
      });
      return table(['#', 'Member', 'Project', 'M/P', '%', '', 'Present', 'Late', 'Absent', 'Excused', 'Meetings'],
        rows.map(function(m, i){
          return { id: m.userId, cells: [
            i + 1, esc(m.fullName), esc(m.project), (m.module || '?') + '/' + (m.pod || '?'),
            m.pct + '%',
            '<div class="bar"><span style="width:' + m.pct + '%;background:' +
              (m.pct >= 80 ? 'var(--good)' : m.pct >= 50 ? 'var(--warn)' : 'var(--bad)') + '"></span></div>',
            m.present, m.late, m.absent, m.excused, m.total
          ] };
        }), { id: 'lbTbl' });
    });
  },

  meetings: function(){
    return api('/api/meetings').then(function(rows){
      return table(['#', 'Title', 'Start', 'Duration', 'Status', 'Present', 'Late', 'Absent', 'Excused'],
        rows.map(function(m){
          var c = m.counts || {};
          return { cells: [
            m.id, esc(m.title), dt(m.startAt), m.durationMin + 'm',
            '<span class="pill">' + esc(m.status) + '</span>',
            '<span class="pill present">' + (c.present || 0) + '</span>',
            '<span class="pill late">' + (c.late || 0) + '</span>',
            '<span class="pill absent">' + (c.absent || 0) + '</span>',
            (c.excused || 0)
          ] };
        }));
    });
  }
};

function memberDetail(tr, userId){
  var next = tr.nextElementSibling;
  if (next && next.classList.contains('detail')) { next.remove(); return; }
  var cols = tr.children.length;
  var row = document.createElement('tr');
  row.className = 'detail';
  row.innerHTML = '<td colspan="' + cols + '">Loading…</td>';
  tr.parentNode.insertBefore(row, tr.nextSibling);
  api('/api/member/' + encodeURIComponent(userId)).then(function(d){
    var daily = d.days.map(function(x){
      return '<span class="pill">' + esc(x.day) + ': ' + hm(x.seconds) + '</span>';
    }).join(' ');
    var meets = d.meetings.map(function(x){
      return '<span class="pill ' + esc(x.status) + '">#' + x.meeting.id + ' ' + esc(x.meeting.title) +
        ' — ' + esc(x.status) + (x.minutesLate ? ' (' + x.minutesLate + 'm)' : '') + '</span>';
    }).join(' ') || '<span class="muted">no meeting records</span>';
    row.innerHTML = '<td colspan="' + cols + '"><b>Daily voice</b><br>' + daily +
      '<br><br><b>Recent meetings</b><br>' + meets + '</td>';
  }).catch(function(e){
    row.innerHTML = '<td colspan="' + cols + '">' + esc(e.message) + '</td>';
  });
}

function sortTable(table, col){
  var tbody = table.tBodies[0];
  var rows = [].slice.call(tbody.rows).filter(function(r){ return !r.classList.contains('detail'); });
  var key = table.id + ':' + col;
  var asc = state.sort[key] = !state.sort[key];
  var val = function(r){
    var t = r.cells[col].textContent.trim();
    var num = parseFloat(t.replace(/[^0-9.\\-]/g, ''));
    var hours = t.match(/^(\\d+)h\\s*(\\d+)m$/);
    if (hours) return Number(hours[1]) * 60 + Number(hours[2]);
    return isNaN(num) || t === '' ? t.toLowerCase() : num;
  };
  rows.sort(function(a, b){
    var x = val(a), y = val(b);
    if (x < y) return asc ? -1 : 1;
    if (x > y) return asc ? 1 : -1;
    return 0;
  });
  rows.forEach(function(r){ tbody.appendChild(r); });
}

function render(quiet){
  var view = q('view');
  if (!quiet) view.innerHTML = '<div class="msg">Loading…</div>';
  views[state.tab]().then(function(html){
    view.innerHTML = html;
    q('stamp').textContent = 'updated ' + new Date().toLocaleTimeString();
    [].forEach.call(view.querySelectorAll('table'), function(t){
      t.addEventListener('click', function(e){
        var th = e.target.closest('th');
        if (th) { sortTable(t, Number(th.dataset.col)); return; }
        var tr = e.target.closest('tr');
        if (tr && tr.dataset.user) memberDetail(tr, tr.dataset.user);
      });
    });
  }).catch(function(e){
    view.innerHTML = '<div class="msg">Error: ' + esc(e.message) + '</div>';
  });
}

/**
 * The filter bar only makes sense on member-shaped tabs, and the compliance
 * statuses only exist on the compliance tab — disable what can't apply rather
 * than silently returning nothing.
 */
function syncFilterBar(){
  var isMember = ['compliance', 'voice', 'live', 'meetings-lb'].indexOf(state.tab) !== -1;
  var isCompliance = state.tab === 'compliance';
  q('filters').classList.toggle('hidden', !isMember);
  q('day').classList.toggle('hidden', !isCompliance);
  var sel = q('status');
  [].forEach.call(sel.options, function(o){
    if (COMPLIANCE_ONLY.indexOf(o.value) === -1) return;
    o.disabled = !isCompliance;
  });
  if (sel.selectedOptions[0] && sel.selectedOptions[0].disabled) sel.value = '';
  if (!isMember) q('count').textContent = '';
}

function setAuto(on){
  state.auto = on;
  q('auto').textContent = (on ? '⏵' : '⏸') + ' Auto';
  q('auto').classList.toggle('primary', on);
  try { localStorage.setItem('attendanceAuto', on ? '1' : '0'); } catch (e) {}
  if (autoTimer) { clearInterval(autoTimer); autoTimer = null; }
  if (!on) return;
  autoTimer = setInterval(function(){
    // Don't yank the page out from under someone reading a drill-down, and
    // don't hammer the API for a tab nobody is looking at.
    if (document.hidden) return;
    if (document.querySelector('.detail')) return;
    render(true);
  }, AUTO_MS);
}

q('auto').addEventListener('click', function(){ setAuto(!state.auto); if (state.auto) render(true); });

[].forEach.call(document.querySelectorAll('nav button'), function(b){
  b.addEventListener('click', function(){
    [].forEach.call(document.querySelectorAll('nav button'), function(x){ x.classList.remove('active'); });
    b.classList.add('active');
    state.tab = b.dataset.tab;
    syncFilterBar();
    render();
  });
});

q('search').addEventListener('input', function(){
  clearTimeout(state.searchTimer);
  state.searchTimer = setTimeout(function(){ render(true); }, 200);
});
q('status').addEventListener('change', function(){ render(true); });
q('day').addEventListener('change', function(){ render(); });
function load(){
  api('/api/config').then(function(c){
    q('tz').textContent = c.timezone + ' · today ' + c.today;
    if (!q('day').value) { q('day').value = c.today; q('day').max = c.today; }
  }).catch(function(){});
  render();
}

q('reload').addEventListener('click', load);
q('days').addEventListener('change', function(){ render(); });
try { setAuto(localStorage.getItem('attendanceAuto') === '1'); } catch (e) { setAuto(false); }
syncFilterBar();
load();
</script></body></html>`;
}
//# sourceMappingURL=page.js.map