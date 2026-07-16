const COLORS = ['#e64980','#3b82f6','#10b981','#8b5cf6','#f97316','#06b6d4','#ef4444','#65a30d'];
const WD = ['日','月','火','水','木','金','土'];
const NTH_LABEL = {1:'第1',2:'第2',3:'第3',4:'第4',5:'最終'};
const CAP_LANES = Infinity; // no cap: month cells grow to fit every bar instead of hiding extras behind "+N"
const IMPORTANCE_LEVELS = [
  {key:'highest', label:'最高'},
  {key:'high', label:'高'},
  {key:'medium', label:'中'},
  {key:'low', label:'低'},
];
const IMPORTANCE_RANK = {highest:0, high:1, medium:2, low:3};
function taskImportance(series){ return series.importance || 'medium'; }
function importanceRank(series){ return IMPORTANCE_RANK[taskImportance(series)] ?? 2; }

let viewDate = new Date(); // focused date, drives month/week/day views
let viewMode = 'month'; // 'month' | 'week' | 'day'
let weekMemoSaveTimer = null;

function uid(){ return Math.random().toString(36).slice(2,10); }
function todayStr(){ return fmt(new Date()); }
function fmt(d){ return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; }
function parseDate(s){ const [y,m,d]=s.split('-').map(Number); return new Date(y,m-1,d); }
function addDays(d,n){ const nd=new Date(d); nd.setDate(nd.getDate()+n); return nd; }
function daysInMonth(y,m){ return new Date(y,m+1,0).getDate(); }
function escapeHtml(s){ return s.replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

function nthWeekdayDate(y,m,weekday,nth){
  if(nth===5){
    const last = new Date(y,m+1,0);
    const diff = (last.getDay() - weekday + 7) % 7;
    return addDays(last, -diff);
  }
  const first = new Date(y,m,1);
  const diff = (weekday - first.getDay() + 7) % 7;
  const day = 1 + diff + (nth-1)*7;
  const d = new Date(y,m,day);
  return d.getMonth()===m ? d : null;
}
function computeNthOfWeekday(d){
  const nth = Math.ceil(d.getDate()/7);
  const next = addDays(d,7);
  if(next.getMonth() !== d.getMonth()) return 5;
  return Math.min(nth,4);
}

// ---- occurrence generation ----
function generateOccurrenceDates(series, gridEndStr){
  const out = [];
  const start = parseDate(series.startDate);
  const gridEnd = parseDate(gridEndStr);
  if(start > gridEnd) return out;
  const until = series.until || null;
  const deleted = new Set(series.deletedDates || []);
  const type = series.recurrence.type;

  function tryAdd(d){
    const ds = fmt(d);
    if(until && ds >= until) return;
    if(deleted.has(ds)) return;
    out.push(ds);
  }

  if(type === 'none'){
    if(start <= gridEnd) tryAdd(start);
  } else if(type === 'weekly'){
    let d = new Date(start);
    while(d <= gridEnd){ tryAdd(d); d = addDays(d,7); }
  } else if(type === 'monthly'){
    let y = start.getFullYear(), m = start.getMonth();
    const dom = start.getDate();
    let guard = 0;
    while(guard++ < 1200){
      const dim = daysInMonth(y,m);
      const d = new Date(y,m, Math.min(dom,dim));
      if(d > gridEnd) break;
      if(d >= start) tryAdd(d);
      m++; if(m>11){m=0;y++;}
    }
  } else if(type === 'monthlyNth'){
    let y = start.getFullYear(), m = start.getMonth();
    const {weekday, nth} = series.recurrence;
    let guard = 0;
    while(guard++ < 1200){
      const d = nthWeekdayDate(y,m,weekday,nth);
      if(d){ if(d > gridEnd) break; if(d >= start) tryAdd(d); }
      else { if(new Date(y,m,1) > gridEnd) break; }
      m++; if(m>11){m=0;y++;}
    }
  } else if(type === 'monthStart'){
    let y = start.getFullYear(), m = start.getMonth();
    let guard = 0;
    while(guard++ < 1200){
      const d = new Date(y,m,1);
      if(d > gridEnd) break;
      if(d >= start) tryAdd(d);
      m++; if(m>11){m=0;y++;}
    }
  } else if(type === 'monthEnd'){
    let y = start.getFullYear(), m = start.getMonth();
    let guard = 0;
    while(guard++ < 1200){
      const d = new Date(y,m+1,0);
      if(d > gridEnd) break;
      if(d >= start) tryAdd(d);
      m++; if(m>11){m=0;y++;}
    }
  } else if(type === 'yearly'){
    const mo = start.getMonth(), dom = start.getDate();
    let y = start.getFullYear();
    let guard = 0;
    while(guard++ < 200){
      const dim = daysInMonth(y, mo);
      const d = new Date(y, mo, Math.min(dom, dim)); // Feb 29 falls back to Feb 28 on non-leap years
      if(d > gridEnd) break;
      if(d >= start) tryAdd(d);
      y++;
    }
  }
  return out;
}

function occStateOf(series, occDate){
  return series.occurrences[occDate] || { completedDate: null, logs: {}, nameOverride: null, colorOverride: null, memoOverride: null, timeOverride: null, dueDateOverride: null, endOffsetOverride: null };
}
function isSchedule(series){ return series.kind === 'schedule'; }
function displayEndOffset(series, occState){ return (occState.endOffsetOverride ?? series.endOffsetDays) || 0; }
function activeEndOf(series, occState, occDate){
  if(isSchedule(series)){
    // schedules are fixed-range: they don't grow toward today and have no complete/incomplete state
    return fmt(addDays(parseDate(occDate), displayEndOffset(series, occState)));
  }
  if(occState.completedDate) return occState.completedDate;
  const t = todayStr();
  return occDate > t ? occDate : t; // future-dated tasks show as a single point until their day arrives
}
function displayName(series, occState){ return occState.nameOverride || series.name; }
function displayColor(series, occState){ return occState.colorOverride || series.color; }
function displayMemo(series, occState){ return (occState.memoOverride ?? series.memo) || ''; }
function displayTime(series, occState){ return (occState.timeOverride ?? series.time) || ''; }
function displayDueDate(series, occState){ return (occState.dueDateOverride ?? series.dueDate) || null; }
function isOverdue(series, occState){
  if(isSchedule(series)) return false;
  const due = displayDueDate(series, occState);
  if(!due || occState.completedDate) return false;
  return todayStr() > due;
}

function dueTodayItems(){
  const t = todayStr();
  return occurrencesOnDate(t).filter(it=>
    !isSchedule(it.series) && displayDueDate(it.series, it.occState) === t && !it.occState.completedDate
  );
}

function occurrencesOnDate(dateStr){
  const list = [];
  state.series.forEach(series=>{
    const occDates = generateOccurrenceDates(series, dateStr);
    occDates.forEach(occDate=>{
      const occState = occStateOf(series, occDate);
      const activeEnd = activeEndOf(series, occState, occDate);
      if(occDate <= dateStr && dateStr <= activeEnd){
        list.push({ series, occDate, occState, activeEnd });
      }
    });
  });
  list.sort((a,b)=>
    ((isOverdue(b.series,b.occState)?1:0)-(isOverdue(a.series,a.occState)?1:0)) ||
    ((a.occState.completedDate?1:0)-(b.occState.completedDate?1:0)) ||
    (importanceRank(a.series)-importanceRank(b.series)) ||
    ((a.series.order??0)-(b.series.order??0)) ||
    (a.occDate < b.occDate ? -1 : (a.occDate > b.occDate ? 1 : 0))
  );
  return list;
}

function recurrenceLabel(rec){
  if(rec.type==='none') return '繰り返しなし';
  if(rec.type==='weekly') return '毎週';
  if(rec.type==='monthly') return '毎月（同じ日にち）';
  if(rec.type==='monthlyNth') return `毎月 ${NTH_LABEL[rec.nth]} ${WD[rec.weekday]}曜日`;
  if(rec.type==='monthStart') return '毎月 月初め';
  if(rec.type==='monthEnd') return '毎月 月末';
  if(rec.type==='yearly') return '毎年';
  return '';
}

// ---- grid rendering (month / week) ----
function collectOccList(gridStartStr, gridEndStr){
  const occList = [];
  state.series.forEach(series=>{
    generateOccurrenceDates(series, gridEndStr).forEach(occDate=>{
      const occState = occStateOf(series, occDate);
      const activeEnd = activeEndOf(series, occState, occDate);
      if(activeEnd >= gridStartStr){
        occList.push({ series, occDate, occState, activeEnd });
      }
    });
  });
  return occList;
}

function buildWeekRowHtml(week, occList, capLanes, inMonthFn){
  const weekStart = week[0], weekEnd = week[6];
  const today = todayStr();
  let segments = occList
    .filter(o => o.occDate <= weekEnd && o.activeEnd >= weekStart)
    .map(o=>{
      const segStartStr = o.occDate > weekStart ? o.occDate : weekStart;
      const segEndStr = o.activeEnd < weekEnd ? o.activeEnd : weekEnd;
      const colStart = week.indexOf(segStartStr);
      const colEnd = week.indexOf(segEndStr);
      return { ...o, colStart, colEnd, isTrueStart: segStartStr===o.occDate, isTrueEnd: segEndStr===o.activeEnd };
    })
    .sort((a,b)=> ((a.series.order??0)-(b.series.order??0)) || (a.colStart - b.colStart) || ((b.colEnd-b.colStart)-(a.colEnd-a.colStart)));

  const lanes = [];
  segments.forEach(seg=>{
    let placed = false;
    for(let i=0;i<lanes.length;i++){
      if(lanes[i] < seg.colStart){ seg.lane = i; lanes[i] = seg.colEnd; placed = true; break; }
    }
    if(!placed){ seg.lane = lanes.length; lanes.push(seg.colEnd); }
  });

  let html = '<div class="week-row">';
  week.forEach((ds, dayIdx)=>{
    const d = parseDate(ds);
    const inMonth = inMonthFn ? inMonthFn(d) : true;
    const isToday = ds === today;
    const wdClass = dayIdx===0 ? 'wd-sun' : (dayIdx===6 ? 'wd-sat' : '');
    let cellHtml = `<div class="dnum">${d.getDate()}</div>`;
    const laneCount = Math.min(lanes.length, capLanes);
    for(let lane=0; lane<laneCount; lane++){
      const seg = segments.find(s=> s.lane===lane && s.colStart<=dayIdx && dayIdx<=s.colEnd);
      if(seg){
        const cls = ['bar'];
        if(dayIdx===seg.colStart && seg.isTrueStart) cls.push('is-start');
        if(dayIdx===seg.colEnd && seg.isTrueEnd) cls.push('is-end');
        if(dayIdx===seg.colStart && !seg.isTrueStart) cls.push('cont-left');
        if(seg.occState.completedDate) cls.push('done');
        if(isOverdue(seg.series, seg.occState)) cls.push('overdue');
        if(isSchedule(seg.series)) cls.push('schedule');
        const t = displayTime(seg.series, seg.occState);
        const nm = dayIdx===seg.colStart ? escapeHtml((t?t+' ':'') + displayName(seg.series, seg.occState)) : '';
        cellHtml += `<div class="${cls.join(' ')}" style="background:${displayColor(seg.series, seg.occState)}" data-sid="${seg.series.id}" data-occ="${seg.occDate}" data-date="${ds}">${nm}</div>`;
      } else {
        cellHtml += `<div class="bar-spacer"></div>`;
      }
    }
    let overflow = 0;
    segments.forEach(s=>{ if(s.lane>=capLanes && s.colStart<=dayIdx && dayIdx<=s.colEnd) overflow++; });
    if(overflow>0) cellHtml += `<div class="bar-more">+${overflow}</div>`;

    html += `<div class="day-cell ${inMonth?'':'out'} ${wdClass} ${isToday?'is-today':''}" data-date="${ds}">${cellHtml}</div>`;
  });
  const memoVal = state.weeklyMemos[weekStart] || '';
  html += `<div class="week-memo"><textarea class="week-memo-input" data-week="${weekStart}" placeholder="今週のメモ">${escapeHtml(memoVal)}</textarea></div>`;
  html += '</div>';
  return html;
}

function bindGridInteractions(host){
  host.querySelectorAll('.day-cell').forEach(el=>{
    el.addEventListener('click', ()=> openDaySheet(el.dataset.date));
  });
  host.querySelectorAll('.week-memo-input').forEach(ta=>{
    ta.addEventListener('input', ()=>{
      state.weeklyMemos[ta.dataset.week] = ta.value;
      clearTimeout(weekMemoSaveTimer);
      weekMemoSaveTimer = setTimeout(save, 500);
    });
  });
}

function renderMonthView(){
  const host = document.getElementById('monthGrid');
  host.classList.remove('week-view');
  const y = viewDate.getFullYear(), m = viewDate.getMonth();
  const firstOfMonth = new Date(y, m, 1);
  const gridStart = addDays(firstOfMonth, -firstOfMonth.getDay());
  const lastOfMonth = new Date(y, m+1, 0);
  const gridEnd = addDays(lastOfMonth, 6 - lastOfMonth.getDay());
  const gridStartStr = fmt(gridStart), gridEndStr = fmt(gridEnd);
  const occList = collectOccList(gridStartStr, gridEndStr);

  const totalDays = Math.round((gridEnd - gridStart)/86400000) + 1;
  const weeks = [];
  for(let i=0;i<totalDays;i+=7){
    const wk = [];
    for(let j=0;j<7;j++) wk.push(fmt(addDays(gridStart, i+j)));
    weeks.push(wk);
  }

  let html = '';
  weeks.forEach(week=> html += buildWeekRowHtml(week, occList, CAP_LANES, d=> d.getMonth()===m));
  host.innerHTML = html;
  bindGridInteractions(host);
}

function renderWeekView(){
  const weekStart = addDays(viewDate, -viewDate.getDay());
  const today = todayStr();
  const memoVal = state.weeklyMemos[fmt(weekStart)] || '';

  let html = `<div class="week-memo-block">
    <label>今週のメモ</label>
    <textarea class="week-memo-input" data-week="${fmt(weekStart)}" placeholder="今週のメモ">${escapeHtml(memoVal)}</textarea>
  </div>`;

  for(let j=0;j<7;j++){
    const d = addDays(weekStart, j);
    const ds = fmt(d);
    const isToday = ds === today;
    const wdClass = j===0 ? 'wd-sun' : (j===6 ? 'wd-sat' : '');
    html += `<div class="week-day-sec ${isToday?'is-today':''}" data-date="${ds}">
      <div class="week-day-head">
        <span class="week-day-num">${d.getDate()}</span>
        <span class="week-day-dow ${wdClass}">${WD[j]}曜日</span>
        <button class="week-day-add" data-act="newhere">＋</button>
      </div>
      <div class="week-day-items">${dayItemsHtml(ds)}</div>
    </div>`;
  }

  const host = document.getElementById('weekView');
  host.innerHTML = html;
  wireWeekAgenda(host);
  host.querySelectorAll('.week-memo-input').forEach(ta=>{
    ta.addEventListener('input', ()=>{
      state.weeklyMemos[ta.dataset.week] = ta.value;
      clearTimeout(weekMemoSaveTimer);
      weekMemoSaveTimer = setTimeout(save, 500);
    });
  });
}

function wireWeekAgenda(container){
  container.addEventListener('click', e=>{
    const act = e.target.closest('[data-act]');
    if(!act) return;
    const daySec = act.closest('.week-day-sec');
    const dateStr = daySec ? daySec.dataset.date : null;
    if(!dateStr) return;
    const d = parseDate(dateStr);
    const label = `${d.getFullYear()}年${d.getMonth()+1}月${d.getDate()}日（${WD[d.getDay()]}）`;
    if(act.dataset.act==='newhere'){ openTaskForm({ startDate: dateStr }); return; }
    const card = act.closest('.day-task-item');
    if(!card) return;
    const sid = card.dataset.sid, occDate = card.dataset.occ;
    const series = state.series.find(s=>s.id===sid);
    if(!series) return;
    if(act.dataset.act==='complete'){
      const occState = series.occurrences[occDate] = series.occurrences[occDate] || { completedDate:null, logs:{}, nameOverride:null, colorOverride:null, memoOverride:null, timeOverride:null, dueDateOverride:null, endOffsetOverride:null };
      occState.completedDate = occState.completedDate ? null : todayStr();
      save(); render();
    }
    if(act.dataset.act==='log'){ openLogSheet(sid, occDate, dateStr, label); }
    if(act.dataset.act==='edit'){ startEditFlow(sid, occDate, dateStr, label); }
    if(act.dataset.act==='delete'){ startDeleteFlow(sid, occDate, dateStr, label); }
    if(act.dataset.act==='moveup' || act.dataset.act==='movedown'){
      const items = occurrencesOnDate(dateStr);
      const idx = items.findIndex(it=>it.series.id===sid);
      const swapIdx = act.dataset.act==='moveup' ? idx-1 : idx+1;
      if(idx<0 || swapIdx<0 || swapIdx>=items.length) return;
      const a = items[idx].series, b = items[swapIdx].series;
      const tmp = a.order ?? 0; a.order = b.order ?? 0; b.order = tmp;
      save(); render();
    }
  });
}

// ---- day view (inline, single day) ----
function renderDayView(){
  const dateStr = fmt(viewDate);
  const label = `${viewDate.getFullYear()}年${viewDate.getMonth()+1}月${viewDate.getDate()}日（${WD[viewDate.getDay()]}）`;
  const host = document.getElementById('dayView');
  const itemsHtml = dayItemsHtml(dateStr, label);
  host.innerHTML = `
    <div id="dayItemsWrap">${itemsHtml}</div>
    <div class="sheet-actions">
      <button class="btn-outline" data-act="newhere" style="width:100%;">＋ この日から新規登録</button>
    </div>`;
  wireDayItemsContainer(host, dateStr, label);
}

function dayItemsHtml(dateStr, label){
  const items = occurrencesOnDate(dateStr);
  if(items.length===0) return `<p class="dayview-empty">この日の予定・タスクはありません。</p>`;
  return items.map((it,i)=>{
    const sched = isSchedule(it.series);
    const logs = it.occState.logs[dateStr] || [];
    const isDone = !!it.occState.completedDate;
    const due = displayDueDate(it.series, it.occState);
    const overdue = isOverdue(it.series, it.occState);
    const rangeText = sched
      ? (it.occDate === it.activeEnd ? it.occDate : `${it.occDate.slice(5)} 〜 ${it.activeEnd.slice(5)}`)
      : `${it.occDate.slice(5)} 〜 ${isDone ? it.occState.completedDate.slice(5) : '進行中'}`;
    const imp = taskImportance(it.series);
    const impBadge = imp === 'medium' ? '' : `<span class="dti-imp imp-${imp}">${IMPORTANCE_LEVELS.find(l=>l.key===imp).label}</span>`;
    return `<div class="day-task-item ${sched?'schedule':''} ${overdue?'overdue-item':''}" data-sid="${it.series.id}" data-occ="${it.occDate}">
      <div class="dti-top">
        <span class="dti-dot" style="background:${displayColor(it.series, it.occState)}"></span>
        ${impBadge}
        ${displayTime(it.series, it.occState) ? `<span class="dti-time">${displayTime(it.series, it.occState)}</span>` : ''}
        <span class="dti-name ${isDone?'done':''} ${overdue?'overdue':''}">${escapeHtml(displayName(it.series, it.occState))}</span>
        ${sched ? `<span class="dti-tag">予定</span>` : ''}
        ${overdue ? `<span class="dti-time" style="color:#c0392b; background:#fdeceb;">期限超過</span>` : ''}
        <div class="reorder-btns">
          <button data-act="moveup" ${i===0?'disabled':''}>▲</button>
          <button data-act="movedown" ${i===items.length-1?'disabled':''}>▼</button>
        </div>
      </div>
      <div class="dti-meta">${rangeText} ・ ${recurrenceLabel(it.series.recurrence)}${(!sched && due) ? ` ・ 期限 ${due.slice(5)}${overdue?'（超過）':''}` : ''}</div>
      ${displayMemo(it.series, it.occState) ? `<div class="dti-memo">${escapeHtml(displayMemo(it.series, it.occState))}</div>` : ''}
      <div class="dti-actions">
        ${sched ? '' : `<button data-act="complete" class="${isDone?'on':''}">${isDone?'完了済 ✓':'完了にする'}</button>
        <button data-act="log">この日の記録 (${logs.length})</button>`}
        <button data-act="edit">編集</button>
        <button data-act="delete">削除</button>
      </div>
    </div>`;
  }).join('');
}

function refreshDayContext(dateStr, label){
  render();
  // Always close whatever sheet triggered this (edit form, scope-choice
  // sheet, etc.) - previously this only happened in month view, so
  // editing/completing from the 日/未完了 tabs left the sheet stuck open.
  closeSheet();
  if(viewMode === 'month'){ render_daySheetBody(dateStr, label); }
}
function backToDayContext(dateStr, label){
  closeSheet();
  if(viewMode === 'month') render_daySheetBody(dateStr, label);
}

// ---- todo view (all incomplete tasks, sorted by registration date then due date) ----
function collectIncompleteItems(){
  const today = todayStr();
  const list = [];
  state.series.forEach(series=>{
    if(isSchedule(series)) return; // schedules have no complete/incomplete concept
    generateOccurrenceDates(series, today).forEach(occDate=>{
      const occState = occStateOf(series, occDate);
      if(!occState.completedDate){
        list.push({ series, occDate, occState });
      }
    });
  });
  list.sort((a,b)=>{
    if(a.occDate !== b.occDate) return a.occDate < b.occDate ? -1 : 1;
    const ad = displayDueDate(a.series, a.occState), bd = displayDueDate(b.series, b.occState);
    if(ad === bd) return 0;
    if(!ad) return 1;
    if(!bd) return -1;
    return ad < bd ? -1 : 1;
  });
  return list;
}

function renderTodoView(){
  const host = document.getElementById('todoView');
  const items = collectIncompleteItems();
  host.innerHTML = `<div id="todoItemsWrap">${todoItemsHtml(items)}</div>`;
  wireTodoItemsContainer(host);
}

function todoItemsHtml(items){
  if(items.length===0) return `<p class="dayview-empty">未完了のタスクはありません。</p>`;
  return items.map(it=>{
    const due = displayDueDate(it.series, it.occState);
    const overdue = isOverdue(it.series, it.occState);
    return `<div class="todo-row" data-sid="${it.series.id}" data-occ="${it.occDate}">
      <label class="todo-check-wrap">
        <input type="checkbox" class="todo-checkbox" data-act="complete">
      </label>
      <span class="dti-dot" style="background:${displayColor(it.series, it.occState)}"></span>
      <span class="todo-name" data-act="detail">${escapeHtml(displayName(it.series, it.occState))}</span>
      <span class="todo-due ${overdue?'overdue':''}" data-act="detail">${due ? due.slice(5).replace('-','/') + (overdue?'（超過）':'') : ''}</span>
      <button class="todo-icon-btn" data-act="edit" title="編集">✎</button>
      <button class="todo-icon-btn" data-act="delete" title="削除">🗑</button>
    </div>`;
  }).join('');
}

function openTodoDetailSheet(sid, occDate){
  const series = state.series.find(s=>s.id===sid);
  if(!series) return;
  const occState = occStateOf(series, occDate);
  const due = displayDueDate(series, occState);
  const overdue = isOverdue(series, occState);
  const dateStr = todayStr();
  const label = '未完了タスク一覧';
  const overlay = openSheet(`
    <button class="close-x" data-act="close">×</button>
    <h2>
      <span class="dti-dot" style="display:inline-block; margin-right:6px; background:${displayColor(series, occState)}"></span>
      ${escapeHtml(displayName(series, occState))}
    </h2>
    <div class="dti-meta" style="margin-left:0; margin-bottom:12px;">
      登録日 ${occDate} ・ ${recurrenceLabel(series.recurrence)}${due ? ` ・ 期限 ${due}${overdue?'（超過）':''}` : ' ・ 期限なし'}
      ${displayTime(series, occState) ? ` ・ ${displayTime(series, occState)}` : ''}
    </div>
    ${displayMemo(series, occState) ? `<div class="dti-memo" style="margin-left:0;">${escapeHtml(displayMemo(series, occState))}</div>` : `<p class="dayview-empty" style="padding:6px 0;">メモはありません。</p>`}
    <div class="sheet-actions" style="margin-top:16px;">
      <button class="btn-outline" data-act="edit">編集</button>
      <button class="btn-danger" data-act="delete">削除</button>
    </div>
  `);
  overlay.addEventListener('click', e=>{
    const act = e.target.closest('[data-act]'); if(!act) return;
    if(act.dataset.act==='close'){ closeSheet(); return; }
    if(act.dataset.act==='edit'){ closeSheet(); startEditFlow(sid, occDate, dateStr, label); return; }
    if(act.dataset.act==='delete'){ closeSheet(); startDeleteFlow(sid, occDate, dateStr, label); return; }
  });
}


function wireTodoItemsContainer(container){
  // see the comment in wireDayItemsContainer: #todoView is persistent and
  // re-rendered in place, so this must only wire once or clicks/checkbox
  // toggles fire multiple times and cancel each other out.
  if(container.dataset.wired) return;
  container.dataset.wired = '1';
  container.addEventListener('click', e=>{
    const act = e.target.closest('[data-act]');
    if(!act) return;
    if(act.dataset.act==='complete') return; // handled by the checkbox's change event
    const card = act.closest('.todo-row');
    if(!card) return;
    const sid = card.dataset.sid, occDate = card.dataset.occ;
    const series = state.series.find(s=>s.id===sid);
    if(!series) return;
    const dateStr = todayStr();
    const label = '未完了タスク一覧';
    if(act.dataset.act==='detail'){ openTodoDetailSheet(sid, occDate); return; }
    if(act.dataset.act==='edit'){ startEditFlow(sid, occDate, dateStr, label); }
    if(act.dataset.act==='delete'){ startDeleteFlow(sid, occDate, dateStr, label); }
  });
  container.addEventListener('change', e=>{
    const box = e.target.closest('.todo-checkbox');
    if(!box) return;
    const card = box.closest('.todo-row');
    if(!card) return;
    const sid = card.dataset.sid, occDate = card.dataset.occ;
    const series = state.series.find(s=>s.id===sid);
    if(!series) return;
    if(box.checked){
      const occState = series.occurrences[occDate] = series.occurrences[occDate] || { completedDate:null, logs:{}, nameOverride:null, colorOverride:null, memoOverride:null, timeOverride:null, dueDateOverride:null, endOffsetOverride:null };
      occState.completedDate = todayStr();
      card.classList.add('checked-off');
      save();
      setTimeout(render, 220); // brief pause so the check animation is visible before the row disappears
    }
  });
}

// ---- inbox (GTD-style quick capture, triaged into tasks later) ----
function renderInboxView(){
  const host = document.getElementById('inboxView');
  host.innerHTML = `
    <div class="inbox-add-row">
      <input type="text" id="inboxAddInput" placeholder="思いついたことをメモ...">
      <button id="inboxAddBtn">追加</button>
    </div>
    <div id="inboxItemsWrap">${inboxItemsHtml()}</div>
    <p class="inbox-sub">メモをタップすると、タスク登録フォームに内容が入った状態で開きます。登録すると、このインボックスからは消えます。</p>`;
  wireInboxContainer(host);
  // #inboxItemsWrap is recreated every time renderInboxView() runs (e.g.
  // switching tabs away and back), even though the outer container only
  // gets its add-button/keydown listeners wired once - so this needs to
  // run unconditionally, not just from inside that one-time wiring.
  wireInboxRowClicks(host);
}

function inboxItemsHtml(){
  const items = [...state.inbox].sort((a,b)=> b.createdAt.localeCompare(a.createdAt));
  if(items.length===0) return `<p class="dayview-empty">インボックスは空です。</p>`;
  return items.map(m=>`
    <div class="inbox-row" data-id="${m.id}">
      <span class="inbox-text" data-act="triage">${escapeHtml(m.text)}</span>
      <button class="todo-icon-btn" data-act="delete" title="削除">🗑</button>
    </div>`).join('');
}

function wireInboxContainer(container){
  if(container.dataset.wired) return;
  container.dataset.wired = '1';
  const confirmAdd = ()=>{
    const input = container.querySelector('#inboxAddInput');
    const text = input.value.trim();
    if(!text) return;
    const overlay = openSheet(`
      <h2>インボックスに追加しますか？</h2>
      <p class="sheet-sub">${escapeHtml(text)}</p>
      <div class="sheet-actions">
        <button class="btn-cancel" data-act="cancel">キャンセル</button>
        <button class="btn-primary" data-act="confirm">追加する</button>
      </div>
    `);
    overlay.addEventListener('click', e=>{
      const act = e.target.closest('[data-act]'); if(!act) return;
      if(act.dataset.act==='cancel'){ closeSheet(); return; }
      if(act.dataset.act==='confirm'){
        state.inbox.push({ id: uid(), text, createdAt: new Date().toISOString() });
        save();
        closeSheet();
        // update the list in place; don't call render() here, since that
        // would tear down and recreate #inboxAddInput mid-IME-composition
        // on some mobile keyboards, leaving stray uncommitted text behind.
        input.value = '';
        container.querySelector('#inboxItemsWrap').innerHTML = inboxItemsHtml();
        wireInboxRowClicks(container);
        input.focus();
      }
    });
  };
  container.addEventListener('click', e=>{
    if(e.target.closest('#inboxAddBtn')){ confirmAdd(); return; }
  });
  container.addEventListener('keydown', e=>{
    if(e.target.id==='inboxAddInput' && e.key==='Enter' && !e.isComposing) confirmAdd();
  });
}

function wireInboxRowClicks(container){
  const wrap = container.querySelector('#inboxItemsWrap');
  if(!wrap || wrap.dataset.wired) return;
  wrap.dataset.wired = '1';
  wrap.addEventListener('click', e=>{
    const act = e.target.closest('[data-act]'); if(!act) return;
    const row = act.closest('.inbox-row'); if(!row) return;
    const id = row.dataset.id;
    const memo = state.inbox.find(m=>m.id===id);
    if(!memo) return;
    if(act.dataset.act==='triage'){ openTaskForm({ name: memo.text, fromInboxId: memo.id }); return; }
    if(act.dataset.act==='delete'){
      state.inbox = state.inbox.filter(m=>m.id!==id);
      save();
      container.querySelector('#inboxItemsWrap').innerHTML = inboxItemsHtml();
    }
  });
}

function wireDayItemsContainer(container, dateStr, label){
  // #dayView is a persistent element whose innerHTML gets replaced on every
  // render (day navigation, completing a task, etc.) without ever being
  // removed itself. Re-running this function on every render (as callers
  // do) used to attach a new listener each time, so a single click fired
  // N times and toggled "complete" back off. Wire it once per container,
  // and for #dayView specifically recompute dateStr/label from the current
  // viewDate at click time instead of trusting the (possibly stale) values
  // captured when it was first wired.
  if(container.dataset.wired) return;
  container.dataset.wired = '1';
  const isPersistentDayView = container.id === 'dayView';
  container.addEventListener('click', e=>{
    let curDateStr = dateStr, curLabel = label;
    if(isPersistentDayView){
      curDateStr = fmt(viewDate);
      curLabel = `${viewDate.getFullYear()}年${viewDate.getMonth()+1}月${viewDate.getDate()}日（${WD[viewDate.getDay()]}）`;
    }
    const act = e.target.closest('[data-act]');
    if(!act) return;
    if(act.dataset.act==='close'){ closeSheet(); return; }
    if(act.dataset.act==='newhere'){ closeSheet(); openTaskForm({ startDate: curDateStr }); return; }
    const card = act.closest('.day-task-item');
    if(!card) return;
    const sid = card.dataset.sid, occDate = card.dataset.occ;
    const series = state.series.find(s=>s.id===sid);
    if(!series) return;
    if(act.dataset.act==='complete'){
      const occState = series.occurrences[occDate] = series.occurrences[occDate] || { completedDate:null, logs:{}, nameOverride:null, colorOverride:null, memoOverride:null, timeOverride:null, dueDateOverride:null, endOffsetOverride:null };
      occState.completedDate = occState.completedDate ? null : todayStr();
      save(); refreshDayContext(curDateStr, curLabel);
    }
    if(act.dataset.act==='log'){
      closeSheet();
      openLogSheet(sid, occDate, curDateStr, curLabel);
    }
    if(act.dataset.act==='edit'){
      closeSheet();
      startEditFlow(sid, occDate, curDateStr, curLabel);
    }
    if(act.dataset.act==='delete'){
      closeSheet();
      startDeleteFlow(sid, occDate, curDateStr, curLabel);
    }
    if(act.dataset.act==='moveup' || act.dataset.act==='movedown'){
      const items = occurrencesOnDate(curDateStr);
      const idx = items.findIndex(it=>it.series.id===sid);
      const swapIdx = act.dataset.act==='moveup' ? idx-1 : idx+1;
      if(idx<0 || swapIdx<0 || swapIdx>=items.length) return;
      const a = items[idx].series, b = items[swapIdx].series;
      const tmp = a.order ?? 0; a.order = b.order ?? 0; b.order = tmp;
      save(); refreshDayContext(curDateStr, curLabel);
    }
  });
}

// ---- view dispatch ----
function updateLabel(){
  const el = document.getElementById('monthLabel');
  if(viewMode==='month'){
    el.textContent = `${viewDate.getFullYear()}年 ${viewDate.getMonth()+1}月`;
  } else if(viewMode==='week'){
    const ws = addDays(viewDate, -viewDate.getDay()), we = addDays(ws,6);
    const sameMonth = ws.getMonth()===we.getMonth();
    el.textContent = sameMonth
      ? `${ws.getFullYear()}年 ${ws.getMonth()+1}月 ${ws.getDate()}〜${we.getDate()}日`
      : `${ws.getMonth()+1}/${ws.getDate()} 〜 ${we.getMonth()+1}/${we.getDate()}`;
  } else if(viewMode==='todo'){
    el.textContent = '未完了タスク一覧';
  } else {
    el.textContent = `${viewDate.getFullYear()}年${viewDate.getMonth()+1}月${viewDate.getDate()}日（${WD[viewDate.getDay()]}）`;
  }
}

function render(){
  if(!loaded) return;
  updateLabel();
  const weekdayRow = document.getElementById('weekdayRow');
  const monthGrid = document.getElementById('monthGrid');
  const weekView = document.getElementById('weekView');
  const dayView = document.getElementById('dayView');
  const todoView = document.getElementById('todoView');
  const inboxView = document.getElementById('inboxView');
  weekdayRow.style.display = viewMode==='month' ? 'grid' : 'none';
  monthGrid.style.display = viewMode==='month' ? 'flex' : 'none';
  weekView.style.display = viewMode==='week' ? 'block' : 'none';
  dayView.style.display = viewMode==='day' ? 'block' : 'none';
  todoView.style.display = viewMode==='todo' ? 'block' : 'none';
  inboxView.style.display = viewMode==='inbox' ? 'block' : 'none';
  if(viewMode==='month') renderMonthView();
  else if(viewMode==='week') renderWeekView();
  else if(viewMode==='todo') renderTodoView();
  else if(viewMode==='inbox') renderInboxView();
  else renderDayView();
  checkDueBanner();
}

// ---- due-today banner ----
function checkDueBanner(){
  const banner = document.getElementById('dueBanner');
  const t = todayStr();
  const dismissed = localStorage.getItem('dueBannerDismissed') === t;
  const items = dueTodayItems();
  if(dismissed || items.length===0){ banner.style.display = 'none'; return; }
  const names = items.slice(0,3).map(it=>displayName(it.series, it.occState)).join('、');
  const more = items.length > 3 ? ` 他${items.length-3}件` : '';
  document.getElementById('dueBannerMsg').textContent = `今日期限: ${names}${more}`;
  banner.style.display = 'flex';
}

// ---- drag to move a task bar ----
let dragState = null;

function bindGridDragHandlers(){
  const host = document.getElementById('monthGrid');
  host.addEventListener('click', e=>{
    if(e.target.closest('.bar')) e.stopPropagation();
  }, true);
  host.addEventListener('pointerdown', e=>{
    const bar = e.target.closest('.bar');
    if(!bar) return;
    e.preventDefault();
    dragState = {
      sid: bar.dataset.sid, occDate: bar.dataset.occ, grabbedDate: bar.dataset.date,
      startX: e.clientX, startY: e.clientY, moved: false, targetCell: null, pointerId: e.pointerId, barEl: bar
    };
    try{ bar.setPointerCapture(e.pointerId); }catch(err){}
    document.addEventListener('pointermove', onDragMove);
    document.addEventListener('pointerup', onDragEnd);
  });
}

function onDragMove(e){
  if(!dragState) return;
  const dx = e.clientX - dragState.startX, dy = e.clientY - dragState.startY;
  if(!dragState.moved && Math.hypot(dx,dy) > 10){
    dragState.moved = true;
    dragState.barEl.classList.add('dragging');
  }
  if(!dragState.moved) return;
  const el = document.elementFromPoint(e.clientX, e.clientY);
  const cell = el && el.closest ? el.closest('.day-cell') : null;
  if(dragState.targetCell && dragState.targetCell !== cell) dragState.targetCell.classList.remove('drop-target');
  if(cell){ cell.classList.add('drop-target'); dragState.targetCell = cell; }
}

function onDragEnd(e){
  document.removeEventListener('pointermove', onDragMove);
  document.removeEventListener('pointerup', onDragEnd);
  if(!dragState) return;
  const ds = dragState; dragState = null;
  ds.barEl.classList.remove('dragging');
  if(ds.targetCell) ds.targetCell.classList.remove('drop-target');
  if(!ds.moved){
    openDaySheet(ds.grabbedDate);
    return;
  }
  if(!ds.targetCell){ render(); return; }
  const targetDate = ds.targetCell.dataset.date;
  const delta = Math.round((parseDate(targetDate) - parseDate(ds.grabbedDate)) / 86400000);
  if(delta === 0) return;
  moveOccurrence(ds.sid, ds.occDate, delta);
}

function shiftOccStateDates(occState, deltaDays){
  if(!occState) return occState;
  if(occState.completedDate) occState.completedDate = fmt(addDays(parseDate(occState.completedDate), deltaDays));
  const newLogs = {};
  Object.keys(occState.logs || {}).forEach(dk=>{
    newLogs[fmt(addDays(parseDate(dk), deltaDays))] = occState.logs[dk];
  });
  occState.logs = newLogs;
  return occState;
}

function moveOccurrence(sid, occDate, deltaDays){
  const series = state.series.find(s=>s.id===sid);
  if(!series) return;

  if(series.recurrence.type === 'none'){
    const newStart = fmt(addDays(parseDate(series.startDate), deltaDays));
    const occState = series.occurrences[occDate];
    series.startDate = newStart;
    if(occState){
      delete series.occurrences[occDate];
      series.occurrences[newStart] = shiftOccStateDates(occState, deltaDays);
    }
    save(); render();
    return;
  }
  askMoveScope(series, occDate, deltaDays);
}

function askMoveScope(series, occDate, deltaDays){
  const newDate = fmt(addDays(parseDate(occDate), deltaDays));
  const overlay = openSheet(`
    <h2>「${escapeHtml(series.name)}」の移動範囲</h2>
    <p class="sheet-sub">繰り返しタスクです。${occDate.slice(5)} → ${newDate.slice(5)} への移動をどこまで反映しますか？</p>
    <div class="sheet-actions" style="flex-direction:column;">
      <button class="btn-outline" data-act="onlythis">この回のみ移動</button>
      <button class="btn-primary" data-act="future">これ以降すべて移動</button>
      <button class="btn-cancel" data-act="cancel">キャンセル</button>
    </div>`);
  overlay.addEventListener('click', e=>{
    const act = e.target.closest('[data-act]'); if(!act) return;
    if(act.dataset.act==='cancel'){ closeSheet(); render(); return; }
    if(act.dataset.act==='onlythis'){
      series.deletedDates = series.deletedDates || [];
      series.deletedDates.push(occDate);
      const occState = series.occurrences[occDate];
      delete series.occurrences[occDate];
      const oneOff = {
        id: uid(), name: series.name, color: series.color, recurrence: {type:'none'},
        startDate: newDate, until: null, deletedDates: [], occurrences: {}, order: series.order
      };
      if(occState) oneOff.occurrences[newDate] = shiftOccStateDates(occState, deltaDays);
      state.series.push(oneOff);
    }
    if(act.dataset.act==='future'){
      const occState = series.occurrences[occDate];
      delete series.occurrences[occDate];
      series.until = occDate;
      const newSeries = {
        id: uid(), name: series.name, color: series.color, recurrence: series.recurrence,
        startDate: newDate, until: null, deletedDates: [], occurrences: {}, order: series.order
      };
      if(occState) newSeries.occurrences[newDate] = shiftOccStateDates(occState, deltaDays);
      state.series.push(newSeries);
    }
    save(); render(); closeSheet();
  });
}

// ---- sheets ----
function openSheet(html){
  const overlay = document.createElement('div');
  overlay.className = 'overlay';
  overlay.innerHTML = `<div class="sheet">${html}</div>`;
  overlay.addEventListener('click', e=>{ if(e.target===overlay) closeSheet(); });
  document.body.appendChild(overlay);
  return overlay;
}
function closeSheet(){ document.querySelectorAll('.overlay').forEach(o=>o.remove()); }
function closeTopSheet(){ closeSheet(); }

// ---- day sheet: list tasks active on a date ----
function openDaySheet(dateStr){
  const d = parseDate(dateStr);
  const label = `${d.getFullYear()}年${d.getMonth()+1}月${d.getDate()}日（${WD[d.getDay()]}）`;
  render_daySheetBody(dateStr, label);
}
function render_daySheetBody(dateStr, label){
  const overlay = openSheet(`
    <button class="close-x" data-act="close">×</button>
    <h2>${label}</h2>
    <p class="sheet-sub">この日に有効なタスク</p>
    <div id="dayItemsWrap">${dayItemsHtml(dateStr, label)}</div>
    <div class="sheet-actions">
      <button class="btn-outline" data-act="newhere">＋ この日から新規登録</button>
    </div>
  `);
  wireDayItemsContainer(overlay, dateStr, label);
}

// ---- log sheet for a specific date within an occurrence ----
function openLogSheet(sid, occDate, dateStr, backLabel){
  const series = state.series.find(s=>s.id===sid);
  if(!series) return;
  const occState = series.occurrences[occDate] = series.occurrences[occDate] || { completedDate:null, logs:{}, nameOverride:null, colorOverride:null, dueDateOverride:null, endOffsetOverride:null };
  const d = parseDate(dateStr);
  const label = `${d.getMonth()+1}月${d.getDate()}日（${WD[d.getDay()]}）`;

  function itemsHtml(){
    const logs = occState.logs[dateStr] || [];
    if(logs.length===0) return `<p class="noentries" style="margin-left:0;">この日の記録はまだありません。</p>`;
    return `<ul class="loglist" style="margin-left:0;">${logs.map(l=>`
      <li class="logitem" data-lid="${l.id}">
        <span class="txt">${escapeHtml(l.text)}</span>
        <button class="del" data-act="dellog" data-lid="${l.id}">×</button>
      </li>`).join('')}</ul>`;
  }

  const overlay = openSheet(`
    <button class="close-x" data-act="close">×</button>
    <h2>${escapeHtml(displayName(series, occState))}</h2>
    <p class="sheet-sub">${label} の作業ログ</p>
    <div id="logListWrap">${itemsHtml()}</div>
    <div class="field">
      <label>追加する</label>
      <textarea id="logText" placeholder="この日行ったタスクを記録"></textarea>
    </div>
    <div class="sheet-actions">
      <button class="btn-cancel" data-act="back">戻る</button>
      <button class="btn-primary" data-act="addlog">追加</button>
    </div>
  `);
  overlay.addEventListener('click', e=>{
    const act = e.target.closest('[data-act]');
    if(!act) return;
    if(act.dataset.act==='close'){ closeSheet(); return; }
    if(act.dataset.act==='back'){ backToDayContext(dateStr, backLabel); return; }
    if(act.dataset.act==='addlog'){
      const ta = overlay.querySelector('#logText');
      const text = ta.value.trim();
      if(!text) return;
      if(!occState.logs[dateStr]) occState.logs[dateStr] = [];
      occState.logs[dateStr].push({ id: uid(), text });
      save(); render();
      ta.value='';
      overlay.querySelector('#logListWrap').innerHTML = itemsHtml();
    }
    if(act.dataset.act==='dellog'){
      occState.logs[dateStr] = (occState.logs[dateStr]||[]).filter(l=>l.id!==act.dataset.lid);
      save(); render();
      overlay.querySelector('#logListWrap').innerHTML = itemsHtml();
    }
  });
}

// ---- edit flow: form, then this-only vs future-all scope prompt ----
function startEditFlow(sid, occDate, backDateStr, backLabel){
  const series = state.series.find(s=>s.id===sid);
  if(!series) return;
  const occState = occStateOf(series, occDate);
  openTaskForm({
    mode:'edit', seriesId: sid, occDate,
    name: displayName(series, occState),
    color: displayColor(series, occState),
    memo: displayMemo(series, occState),
    time: displayTime(series, occState),
    dueDate: displayDueDate(series, occState),
    startDate: series.startDate,
    recurrence: series.recurrence,
    isRecurring: series.recurrence.type !== 'none',
    kind: series.kind || 'task',
    importance: taskImportance(series),
    endDate: fmt(addDays(parseDate(occDate), displayEndOffset(series, occState))),
    backDateStr, backLabel
  });
}
function startDeleteFlow(sid, occDate, dateStr, label){
  const series = state.series.find(s=>s.id===sid);
  if(!series) return;
  if(series.recurrence.type === 'none'){
    const overlay = openSheet(`
      <h2>「${escapeHtml(series.name)}」を削除しますか？</h2>
      <p class="sheet-sub">記録した作業ログもすべて削除されます。</p>
      <div class="sheet-actions">
        <button class="btn-cancel" data-act="back">キャンセル</button>
        <button class="btn-danger" data-act="del">削除する</button>
      </div>`);
    overlay.addEventListener('click', e=>{
      const act = e.target.closest('[data-act]'); if(!act) return;
      if(act.dataset.act==='back'){ backToDayContext(dateStr, label); }
      if(act.dataset.act==='del'){ state.series = state.series.filter(s=>s.id!==sid); save(); refreshDayContext(dateStr, label); }
    });
    return;
  }
  const overlay = openSheet(`
    <h2>「${escapeHtml(series.name)}」の削除範囲</h2>
    <p class="sheet-sub">繰り返しタスクです。どこまで削除しますか？</p>
    <div class="sheet-actions" style="flex-direction:column;">
      <button class="btn-outline" data-act="onlythis">この回のみ削除</button>
      <button class="btn-danger" data-act="future">これ以降すべて削除</button>
      <button class="btn-cancel" data-act="back">キャンセル</button>
    </div>`);
  overlay.addEventListener('click', e=>{
    const act = e.target.closest('[data-act]'); if(!act) return;
    if(act.dataset.act==='back'){ backToDayContext(dateStr, label); return; }
    if(act.dataset.act==='onlythis'){
      series.deletedDates = series.deletedDates || [];
      series.deletedDates.push(occDate);
      delete series.occurrences[occDate];
    }
    if(act.dataset.act==='future'){
      series.until = occDate;
    }
    save(); refreshDayContext(dateStr, label);
  });
}

// ---- task create / edit form ----
function openTaskForm(opts){
  opts = opts || {};
  const isEdit = opts.mode==='edit';
  let chosenColor = opts.color || COLORS[state.series.length % COLORS.length];
  let chosenKind = opts.kind || 'task';
  let chosenImportance = opts.importance || 'medium';
  let recType = (opts.recurrence && opts.recurrence.type) || 'none';
  let recWeekday = (opts.recurrence && opts.recurrence.weekday) ?? new Date().getDay();
  let recNth = (opts.recurrence && opts.recurrence.nth) || 1;
  const startVal = isEdit ? (opts.occDate || opts.startDate || todayStr()) : (opts.startDate || todayStr());
  const endVal = opts.endDate || startVal;

  const swatches = COLORS.map(c=>`<div class="swatch ${c===chosenColor?'sel':''}" style="background:${c}" data-color="${c}"></div>`).join('');
  const impHtml = IMPORTANCE_LEVELS.map(l=>`<button type="button" class="view-tab ${l.key===chosenImportance?'sel':''}" data-imp="${l.key}">${l.label}</button>`).join('');
  const recDefs = [
    {key:'none', label:'繰り返しなし'},
    {key:'weekly', label:'毎週（同じ曜日）'},
    {key:'monthly', label:'毎月（同じ日にち）'},
    {key:'monthlyNth', label:'毎月 第◯ ◯曜日'},
    {key:'monthStart', label:'毎月 月初め（1日）'},
    {key:'monthEnd', label:'毎月 月末（最終日）'},
    {key:'yearly', label:'毎年（同じ月日）'},
  ];
  const recHtml = recDefs.map(r=>`<div class="recur-opt ${r.key===recType?'sel':''}" data-rec="${r.key}">
      <input type="radio" name="rec" ${r.key===recType?'checked':''} style="pointer-events:none;"><span>${r.label}</span>
    </div>`).join('');

  const nthdayField = `
    <div class="field" id="nthdayField" style="display:${recType==='monthlyNth'?'block':'none'};">
      <label>曜日と週</label>
      <div class="row2">
        <div><select id="nthWeekday">${WD.map((w,i)=>`<option value="${i}" ${i===recWeekday?'selected':''}>${w}曜日</option>`).join('')}</select></div>
        <div><select id="nthNum">${[1,2,3,4,5].map(n=>`<option value="${n}" ${n===recNth?'selected':''}>${NTH_LABEL[n]}</option>`).join('')}</select></div>
      </div>
    </div>`;

  const overlay = openSheet(`
    <button class="close-x" data-act="close">×</button>
    <h2 id="formTitle">${isEdit ? (chosenKind==='schedule'?'予定を編集':'タスクを編集') : '登録'}</h2>
    <p class="sheet-sub" id="formSub">${isEdit ? '内容を変更して保存してください。' : (chosenKind==='schedule' ? '決まった日程を、完了・未完了の概念なしで表示します。' : '登録した日から今日までブロックが自動で伸びます。')}</p>
    <div class="field">
      <label>種別</label>
      <div class="recur-options" id="kindOptions">
        <div class="recur-opt ${chosenKind==='task'?'sel':''}" data-kind="task"><input type="radio" name="kind" ${chosenKind==='task'?'checked':''} style="pointer-events:none;"><span>タスク（完了まで育つブロック）</span></div>
        <div class="recur-opt ${chosenKind==='schedule'?'sel':''}" data-kind="schedule"><input type="radio" name="kind" ${chosenKind==='schedule'?'checked':''} style="pointer-events:none;"><span>スケジュール（決まった日程の予定）</span></div>
      </div>
    </div>
    <div class="field">
      <label id="nameLabel">タスク名</label>
      <input type="text" id="tName" value="${opts.name ? escapeHtml(opts.name) : ''}" placeholder="例）〇〇様 対応">
    </div>
    <div class="field">
      <label>メモ（任意）</label>
      <textarea id="tMemo" placeholder="詳細や補足事項など">${opts.memo ? escapeHtml(opts.memo) : ''}</textarea>
    </div>
    <div class="field">
      <label>開始日${isEdit ? '（この回の日付）' : ''}</label>
      <input type="date" id="tDate" value="${startVal}">
      ${isEdit ? `<div class="preview-line" style="color:var(--sub); font-weight:400;">${opts.isRecurring ? '繰り返しの場合は変更後に反映範囲（この回のみ／これ以降）を選べます。' : ''}</div>` : ''}
    </div>
    <div class="field" id="dueField" style="display:${chosenKind==='schedule'?'none':'block'};">
      <label>期限（任意）</label>
      <div class="row2">
        <div><input type="date" id="tDue" value="${opts.dueDate || ''}"></div>
        <div style="flex:0 0 auto;"><button type="button" class="btn-outline" id="tDueClear" style="height:100%; padding:0 14px; white-space:nowrap;">期限なし</button></div>
      </div>
    </div>
    <div class="field" id="endField" style="display:${chosenKind==='schedule'?'block':'none'};">
      <label>終了日（任意・複数日にわたる予定の場合）</label>
      <input type="date" id="tEndDate" value="${endVal}">
    </div>
    <div class="field">
      <label>時刻（任意）</label>
      <input type="time" id="tTime" value="${opts.time || ''}">
    </div>
    <div class="field">
      <label>色</label>
      <div class="colorset" id="tColors">${swatches}</div>
    </div>
    <div class="field">
      <label>重要度</label>
      <div style="display:flex; gap:6px;" id="impOptions">${impHtml}</div>
    </div>
    <div class="field">
      <label>繰り返し</label>
      <div class="recur-options" id="recOptions">${recHtml}</div>
      <div class="preview-line" id="recPreview"></div>
    </div>
    ${nthdayField}
    <div class="sheet-actions">
      <button class="btn-cancel" data-act="close">キャンセル</button>
      <button class="btn-primary" data-act="save">${isEdit ? '保存' : '登録する'}</button>
    </div>
  `);

  overlay.querySelector('#kindOptions').addEventListener('click', e=>{
    const opt = e.target.closest('[data-kind]'); if(!opt) return;
    chosenKind = opt.dataset.kind;
    overlay.querySelectorAll('#kindOptions .recur-opt').forEach(o=>{
      o.classList.remove('sel');
      o.querySelector('input').checked = false;
    });
    opt.classList.add('sel');
    opt.querySelector('input').checked = true;
    overlay.querySelector('#dueField').style.display = chosenKind==='schedule' ? 'none' : 'block';
    overlay.querySelector('#endField').style.display = chosenKind==='schedule' ? 'block' : 'none';
    overlay.querySelector('#nameLabel').textContent = chosenKind==='schedule' ? '予定名' : 'タスク名';
    overlay.querySelector('#formTitle').textContent = isEdit ? (chosenKind==='schedule'?'予定を編集':'タスクを編集') : (chosenKind==='schedule'?'スケジュールを登録':'タスクを登録');
    if(!isEdit){
      overlay.querySelector('#formSub').textContent = chosenKind==='schedule' ? '決まった日程を、完了・未完了の概念なしで表示します。' : '登録した日から今日までブロックが自動で伸びます。';
    }
  });

  overlay.querySelector('#impOptions').addEventListener('click', e=>{
    const opt = e.target.closest('[data-imp]'); if(!opt) return;
    chosenImportance = opt.dataset.imp;
    overlay.querySelectorAll('#impOptions .view-tab').forEach(o=>o.classList.remove('sel'));
    opt.classList.add('sel');
  });

  function updatePreview(){
    const dateVal = overlay.querySelector('#tDate').value || todayStr();
    const d = parseDate(dateVal);
    let text = '';
    if(recType==='monthly') text = `毎月 ${d.getDate()}日 に作成されます`;
    else if(recType==='monthlyNth') text = `毎月 ${NTH_LABEL[recNth]} ${WD[recWeekday]}曜日 に作成されます`;
    else if(recType==='monthStart') text = '毎月1日に作成されます';
    else if(recType==='monthEnd') text = '毎月末日に作成されます';
    else if(recType==='weekly') text = `毎週 ${WD[d.getDay()]}曜日 に作成されます`;
    else if(recType==='yearly') text = `毎年 ${d.getMonth()+1}月${d.getDate()}日 に作成されます`;
    overlay.querySelector('#recPreview').textContent = text;
  }
  updatePreview();

  overlay.querySelector('#tColors').addEventListener('click', e=>{
    const sw = e.target.closest('.swatch'); if(!sw) return;
    overlay.querySelectorAll('.swatch').forEach(s=>s.classList.remove('sel'));
    sw.classList.add('sel'); chosenColor = sw.dataset.color;
  });
  overlay.querySelector('#recOptions').addEventListener('click', e=>{
    const opt = e.target.closest('.recur-opt'); if(!opt) return;
    recType = opt.dataset.rec;
    overlay.querySelectorAll('.recur-opt').forEach(o=>o.classList.remove('sel'));
    opt.classList.add('sel');
    overlay.querySelectorAll('.recur-opt input').forEach(i=>i.checked=false);
    opt.querySelector('input').checked = true;
    overlay.querySelector('#nthdayField').style.display = recType==='monthlyNth' ? 'block' : 'none';
    if(recType==='monthlyNth'){
      const dateVal = overlay.querySelector('#tDate').value || todayStr();
      const d = parseDate(dateVal);
      recWeekday = d.getDay();
      recNth = computeNthOfWeekday(d);
      overlay.querySelector('#nthWeekday').value = recWeekday;
      overlay.querySelector('#nthNum').value = recNth;
    }
    updatePreview();
  });
  overlay.querySelector('#tDate').addEventListener('change', updatePreview);
  overlay.querySelector('#tDueClear').addEventListener('click', ()=>{ overlay.querySelector('#tDue').value = ''; });
  const nw = overlay.querySelector('#nthWeekday'), nn = overlay.querySelector('#nthNum');
  if(nw) nw.addEventListener('change', ()=>{ recWeekday = Number(nw.value); updatePreview(); });
  if(nn) nn.addEventListener('change', ()=>{ recNth = Number(nn.value); updatePreview(); });

  overlay.addEventListener('click', e=>{
    const act = e.target.closest('[data-act]'); if(!act) return;
    if(act.dataset.act==='close'){
      closeSheet();
      if(isEdit) backToDayContext(opts.backDateStr, opts.backLabel);
      return;
    }
    if(act.dataset.act==='save'){
      const name = overlay.querySelector('#tName').value.trim();
      if(!name){ overlay.querySelector('#tName').focus(); return; }
      const memo = overlay.querySelector('#tMemo').value.trim();
      const time = overlay.querySelector('#tTime').value;
      const dateVal = overlay.querySelector('#tDate').value || todayStr();
      const kindVal = chosenKind;
      const dueVal = kindVal==='schedule' ? null : (overlay.querySelector('#tDue').value || null);
      const endValRaw = overlay.querySelector('#tEndDate').value || dateVal;
      const endOffsetDays = kindVal==='schedule' ? Math.max(0, Math.round((parseDate(endValRaw) - parseDate(dateVal)) / 86400000)) : 0;
      const recurrence = recType==='monthlyNth' ? {type:'monthlyNth', weekday:recWeekday, nth:recNth} : {type:recType};

      if(!isEdit){
        const nextOrder = state.series.length ? Math.max(...state.series.map(s=>s.order??0)) + 1 : 0;
        state.series.push({ id: uid(), name, color: chosenColor, memo, time, dueDate: dueVal, kind: kindVal, importance: chosenImportance, endOffsetDays, recurrence, startDate: dateVal, until: null, deletedDates: [], occurrences: {}, order: nextOrder });
        if(opts.fromInboxId) state.inbox = state.inbox.filter(m=>m.id!==opts.fromInboxId);
        save(); render(); closeSheet();
        return;
      }

      // edit mode
      const series = state.series.find(s=>s.id===opts.seriesId);
      if(!series) { closeSheet(); return; }
      const originalOccDate = opts.occDate;
      const dateChanged = dateVal !== originalOccDate;
      const daysDelta = dateChanged ? Math.round((parseDate(dateVal) - parseDate(originalOccDate)) / 86400000) : 0;

      if(!opts.isRecurring){
        // single (non-recurring) item: the occurrence date IS the series' start date, so move both together
        if(dateChanged){
          const oldOccState = series.occurrences[originalOccDate];
          if(oldOccState){
            delete series.occurrences[originalOccDate];
            series.occurrences[dateVal] = shiftOccStateDates(oldOccState, daysDelta);
          }
          series.startDate = dateVal;
        }
        series.name = name; series.color = chosenColor; series.memo = memo; series.time = time; series.dueDate = dueVal; series.kind = kindVal; series.importance = chosenImportance; series.endOffsetDays = endOffsetDays; series.recurrence = recurrence;
        save(); refreshDayContext(opts.backDateStr, opts.backLabel);
        return;
      }
      // recurring: importance always applies to the whole series (it isn't a
      // per-occurrence concept), independent of the this-only/future choice below
      series.importance = chosenImportance;
      // recurring: ask scope
      closeSheet();
      const fieldsNote = kindVal==='schedule' ? '名前・色・終了日' : '名前・色・期限';
      const scopeOverlay = openSheet(`
        <h2>変更の範囲</h2>
        <p class="sheet-sub">繰り返しです。どこまで変更を反映しますか？<br>（繰り返し設定・日付の変更は「これ以降すべて」にのみ適用されます）</p>
        <div class="sheet-actions" style="flex-direction:column;">
          <button class="btn-outline" data-act="onlythis">この回のみ変更（${fieldsNote}${dateChanged?'・日付':''}）</button>
          <button class="btn-primary" data-act="future">これ以降すべて変更</button>
          <button class="btn-cancel" data-act="back">キャンセル</button>
        </div>`);
      scopeOverlay.addEventListener('click', ev=>{
        const a = ev.target.closest('[data-act]'); if(!a) return;
        if(a.dataset.act==='back'){ backToDayContext(opts.backDateStr, opts.backLabel); return; }
        if(a.dataset.act==='onlythis'){
          if(dateChanged){
            // split this single occurrence off into its own standalone item at the new date
            const oldOccState = series.occurrences[originalOccDate];
            series.deletedDates = series.deletedDates || [];
            series.deletedDates.push(originalOccDate);
            delete series.occurrences[originalOccDate];
            const oneOff = {
              id: uid(), name, color: chosenColor, memo, time, dueDate: dueVal, kind: kindVal, importance: chosenImportance, endOffsetDays, recurrence: {type:'none'},
              startDate: dateVal, until: null, deletedDates: [], occurrences: {}, order: series.order
            };
            if(oldOccState) oneOff.occurrences[dateVal] = shiftOccStateDates(oldOccState, daysDelta);
            state.series.push(oneOff);
          } else {
            const occState = series.occurrences[originalOccDate] = series.occurrences[originalOccDate] || { completedDate:null, logs:{}, nameOverride:null, colorOverride:null, memoOverride:null, timeOverride:null, dueDateOverride:null, endOffsetOverride:null };
            occState.nameOverride = name !== series.name ? name : null;
            occState.colorOverride = chosenColor !== series.color ? chosenColor : null;
            occState.memoOverride = memo !== (series.memo||'') ? memo : null;
            occState.timeOverride = time !== (series.time||'') ? time : null;
            occState.dueDateOverride = dueVal !== (series.dueDate||null) ? dueVal : null;
            occState.endOffsetOverride = endOffsetDays !== (series.endOffsetDays||0) ? endOffsetDays : null;
          }
        }
        if(a.dataset.act==='future'){
          series.until = originalOccDate;
          const newStart = dateChanged ? dateVal : originalOccDate;
          const newSeries = {
            id: uid(), name, color: chosenColor, memo, time, dueDate: dueVal, kind: kindVal, importance: chosenImportance, endOffsetDays, recurrence,
            startDate: newStart, until: null, deletedDates: [],
            occurrences: {}, order: series.order
          };
          const carry = series.occurrences[originalOccDate];
          if(carry) newSeries.occurrences[newStart] = dateChanged ? shiftOccStateDates(carry, daysDelta) : carry;
          state.series.push(newSeries);
        }
        save(); refreshDayContext(opts.backDateStr, opts.backLabel);
      });
    }
  });
}

// ---- reorder / priority sheet ----
function openReorderSheet(){
  function itemsHtml(){
    const sorted = [...state.series].sort((a,b)=>(a.order??0)-(b.order??0));
    if(sorted.length===0) return '<p class="noentries" style="margin-left:0;">タスクがありません。</p>';
    return sorted.map((s,i)=>`
      <div class="reorder-item" data-sid="${s.id}">
        <span class="dti-dot" style="background:${s.color}"></span>
        <span class="reorder-name">${escapeHtml(s.name)}</span>
        <span class="reorder-meta">${recurrenceLabel(s.recurrence)}</span>
        <div class="reorder-btns">
          <button data-act="up" ${i===0?'disabled':''}>▲</button>
          <button data-act="down" ${i===sorted.length-1?'disabled':''}>▼</button>
        </div>
      </div>`).join('');
  }
  const overlay = openSheet(`
    <button class="close-x" data-act="close">×</button>
    <h2>並び替え</h2>
    <p class="sheet-sub">上にあるタスクほど優先されます。タスクが増えて隠れてしまう（＋N表示になる）場合、上に置いたものから表示されます。</p>
    <div id="reorderList">${itemsHtml()}</div>
    <div class="sheet-actions">
      <button class="btn-cancel" data-act="close">閉じる</button>
    </div>
  `);
  overlay.addEventListener('click', e=>{
    const act = e.target.closest('[data-act]');
    if(!act) return;
    if(act.dataset.act==='close'){ closeSheet(); return; }
    const item = act.closest('.reorder-item');
    if(!item) return;
    const sid = item.dataset.sid;
    const sorted = [...state.series].sort((a,b)=>(a.order??0)-(b.order??0));
    const idx = sorted.findIndex(s=>s.id===sid);
    if(act.dataset.act==='up' && idx>0){
      [sorted[idx-1], sorted[idx]] = [sorted[idx], sorted[idx-1]];
    }
    if(act.dataset.act==='down' && idx<sorted.length-1){
      [sorted[idx+1], sorted[idx]] = [sorted[idx], sorted[idx+1]];
    }
    sorted.forEach((s,i)=> s.order = i);
    save(); render();
    overlay.querySelector('#reorderList').innerHTML = itemsHtml();
  });
}

// ---- more menu: reorder / export / import ----
function openMoreSheet(){
  const overlay = openSheet(`
    <button class="close-x" data-act="close">×</button>
    <h2>その他の操作</h2>
    <p class="sheet-sub">タスクの並び替えのほか、データのバックアップ書き出し・読み込みができます。<br>
      このカレンダーを新しく作り直したときは、書き出しておいたファイルを読み込むとタスクを引き継げます。</p>
    <div class="sheet-actions" style="flex-direction:column;">
      <button class="btn-outline" data-act="reorder">⇅ 並び替え</button>
      <button class="btn-outline" data-act="export">⬇ データを書き出す（バックアップ保存）</button>
      <button class="btn-outline" data-act="import">⬆ データを読み込む（バックアップから復元）</button>
      <button class="btn-outline" data-act="signout">ログアウト</button>
      <button class="btn-cancel" data-act="close">閉じる</button>
    </div>
  `);
  overlay.addEventListener('click', e=>{
    const act = e.target.closest('[data-act]'); if(!act) return;
    if(act.dataset.act==='close'){ closeSheet(); return; }
    if(act.dataset.act==='reorder'){ closeSheet(); openReorderSheet(); return; }
    if(act.dataset.act==='export'){ exportData(); return; }
    if(act.dataset.act==='import'){ closeSheet(); document.getElementById('importFileInput').click(); return; }
    if(act.dataset.act==='signout'){ closeSheet(); sb.auth.signOut(); return; }
  });
}

function exportData(){
  const payload = JSON.stringify({ series: state.series, weeklyMemos: state.weeklyMemos, inbox: state.inbox }, null, 2);
  const blob = new Blob([payload], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `task-calendar-backup-${todayStr()}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function importDataFromFile(file){
  const reader = new FileReader();
  reader.onload = () => {
    let incomingSeries, incomingMemos, incomingInbox;
    try{
      const raw = JSON.parse(reader.result);
      incomingSeries = Array.isArray(raw) ? raw : (raw.series || []);
      incomingMemos = Array.isArray(raw) ? {} : (raw.weeklyMemos || {});
      incomingInbox = Array.isArray(raw) ? [] : (raw.inbox || []);
      if(!Array.isArray(incomingSeries)) throw new Error('invalid shape');
    }catch(e){
      openImportResultSheet('読み込みエラー', 'ファイルの読み込みに失敗しました。正しいバックアップファイル（.json）か確認してください。');
      return;
    }
    openImportConfirmSheet(incomingSeries, incomingMemos, incomingInbox);
  };
  reader.onerror = () => { openImportResultSheet('読み込みエラー', 'ファイルの読み込みに失敗しました。'); };
  reader.readAsText(file);
}

function openImportConfirmSheet(incomingSeries, incomingMemos, incomingInbox){
  const overlay = openSheet(`
    <button class="close-x" data-act="cancel">×</button>
    <h2>データを読み込みます</h2>
    <p class="sheet-sub">${incomingSeries.length}件のタスクが見つかりました。現在表示中のデータを置き換えます。よろしいですか？</p>
    <div class="sheet-actions">
      <button class="btn-cancel" data-act="cancel">キャンセル</button>
      <button class="btn-primary" data-act="confirm">読み込む</button>
    </div>
  `);
  overlay.addEventListener('click', e=>{
    const act = e.target.closest('[data-act]'); if(!act) return;
    if(act.dataset.act==='cancel'){ closeSheet(); return; }
    if(act.dataset.act==='confirm'){
      state.series = incomingSeries;
      state.weeklyMemos = incomingMemos;
      state.inbox = incomingInbox || [];
      state.series.forEach((s,i)=>{ if(typeof s.order !== 'number') s.order = i; });
      save();
      closeSheet();
      render();
      setTimeout(()=> openImportResultSheet('読み込み完了', `${incomingSeries.length}件のタスクを読み込みました。`), 150);
    }
  });
}

function openImportResultSheet(title, msg){
  const overlay = openSheet(`
    <button class="close-x" data-act="close">×</button>
    <h2>${escapeHtml(title)}</h2>
    <p class="sheet-sub">${escapeHtml(msg)}</p>
    <div class="sheet-actions">
      <button class="btn-primary" data-act="close">OK</button>
    </div>
  `);
  overlay.addEventListener('click', e=>{
    const act = e.target.closest('[data-act]'); if(!act) return;
    if(act.dataset.act==='close') closeSheet();
  });
}

// ---- nav ----
document.getElementById('prevMonth').addEventListener('click', ()=>{
  if(viewMode==='month') viewDate = new Date(viewDate.getFullYear(), viewDate.getMonth()-1, 1);
  else if(viewMode==='week') viewDate = addDays(viewDate, -7);
  else viewDate = addDays(viewDate, -1);
  render();
});
document.getElementById('nextMonth').addEventListener('click', ()=>{
  if(viewMode==='month') viewDate = new Date(viewDate.getFullYear(), viewDate.getMonth()+1, 1);
  else if(viewMode==='week') viewDate = addDays(viewDate, 7);
  else viewDate = addDays(viewDate, 1);
  render();
});
document.getElementById('btnToday').addEventListener('click', ()=>{
  viewDate = new Date(); render();
});
document.getElementById('btnMore').addEventListener('click', openMoreSheet);
document.getElementById('btnAdd').addEventListener('click', ()=> openTaskForm({}));
document.getElementById('fabAdd').addEventListener('click', ()=> openTaskForm({}));
document.getElementById('importFileInput').addEventListener('change', (e)=>{
  const file = e.target.files && e.target.files[0];
  if(file) importDataFromFile(file);
  e.target.value = '';
});
document.querySelectorAll('.view-tab').forEach(tab=>{
  tab.addEventListener('click', ()=>{
    viewMode = tab.dataset.mode;
    document.querySelectorAll('.view-tab').forEach(t=>t.classList.remove('sel'));
    tab.classList.add('sel');
    render();
  });
});
document.getElementById('retrySaveBtn').addEventListener('click', ()=>{
  if(saveDebounceTimer){ clearTimeout(saveDebounceTimer); saveDebounceTimer = null; }
  flushSave();
});
document.getElementById('dueBannerClose').addEventListener('click', ()=>{
  localStorage.setItem('dueBannerDismissed', todayStr());
  document.getElementById('dueBanner').style.display = 'none';
});
bindGridDragHandlers();

initApp();
