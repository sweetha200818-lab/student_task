const $ = id => document.getElementById(id);
const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const monthFormatter = new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' });
const displayDateFormatter = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
const today = new Date();
let appData = {};
let attendance = {};
let studentNames = {};
let teachers = [];
let events = [];
let selectedDate = toDateKey(today);
let calendarMonth = new Date(today.getFullYear(), today.getMonth(), 1);
let saveQueue = Promise.resolve();
let saveMessageTimer;

function toDateKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, character => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[character]);
}

function showSaveMessage(message, isError = false) {
  const element = $('save-message');
  element.textContent = message;
  element.classList.toggle('error', isError);
  clearTimeout(saveMessageTimer);
  if (!isError && message) {
    saveMessageTimer = setTimeout(() => {
      element.textContent = '';
    }, 2200);
  }
}

function saveData() {
  const payload = JSON.stringify(appData);
  saveQueue = saveQueue
    .then(async () => {
      const response = await fetch('/api/data', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: payload
      });
      if (!response.ok) throw new Error('Unable to save your changes.');
      showSaveMessage('Changes saved.');
    })
    .catch(error => {
      showSaveMessage(error.message || 'Could not save your changes. Check your connection and try again.', true);
    });
}

function showAuthMessage(message, isError = false) {
  const element = $('auth-message');
  element.textContent = message;
  element.classList.toggle('error', isError);
}

function showAuthMode(mode) {
  const registering = mode === 'register';
  $('loginForm').hidden = registering;
  $('registerForm').hidden = !registering;
  $('auth-title').textContent = registering ? 'Create your account' : 'Welcome back';
  $('auth-description').textContent = registering
    ? 'Create an account to continue to your portal.'
    : 'Sign in to continue to your portal.';
  showAuthMessage('');
}

function showAuth() {
  $('auth-screen').hidden = false;
  $('portal-app').hidden = true;
}

function showPage(page) {
  const pageElement = document.getElementById(page) || $('home');
  document.querySelectorAll('.page').forEach(element => {
    element.classList.toggle('active', element === pageElement);
  });
  document.querySelectorAll('.nav[data-page]').forEach(button => {
    button.classList.toggle('active', button.dataset.page === pageElement.id);
  });
  const titles = {
    home: 'Home Page',
    students: 'Students',
    teachers: 'Teachers',
    events: 'Events'
  };
  $('heading').textContent = titles[pageElement.id];
}

function createDefaultNames() {
  const names = {};
  for (let roll = 1; roll <= 100; roll++) {
    names[roll] = `Student ${String(roll).padStart(3, '0')}`;
  }
  return names;
}

function getStudents() {
  const rolls = new Set(Array.from({ length: 100 }, (_, index) => index + 1));
  Object.keys(studentNames).forEach(key => {
    const roll = Number(key);
    if (Number.isSafeInteger(roll) && roll > 0) rolls.add(roll);
  });
  return [...rolls].sort((a, b) => a - b);
}

function renderAttendance() {
  const students = getStudents();
  const present = students.filter(roll => !!attendance[roll]).length;
  const query = $('studentSearch').value.trim().toLowerCase();
  const filtered = students.filter(roll => {
    const paddedRoll = String(roll).padStart(3, '0');
    const name = studentNames[roll] || `Student ${paddedRoll}`;
    return !query || paddedRoll.includes(query) || String(roll).includes(query) || name.toLowerCase().includes(query);
  });

  $('totalStudents').textContent = students.length;
  $('presentStat').textContent = present;
  $('absentStat').textContent = students.length - present;
  $('percentStat').textContent = students.length ? `${Math.round(present / students.length * 100)}%` : '0%';
  $('studentRows').innerHTML = filtered.length
    ? filtered.map(roll => {
      const paddedRoll = String(roll).padStart(3, '0');
      const name = studentNames[roll] || `Student ${paddedRoll}`;
      const isPresent = !!attendance[roll];
      return `<tr>
        <td>${paddedRoll}</td>
        <td>${escapeHtml(name)}</td>
        <td><span class="status ${isPresent ? 'present' : 'absent'}">${isPresent ? 'Present' : 'Absent'}</span></td>
        <td><button class="toggle" type="button" data-toggle-roll="${roll}">${isPresent ? 'Mark absent' : 'Mark present'}</button></td>
      </tr>`;
    }).join('')
    : '<tr><td class="no-results" colspan="4">No matching student found.</td></tr>';

  $('dashboardStudentCount').textContent = students.length.toLocaleString();
  $('dashboardAttendance').textContent = $('percentStat').textContent;
}

function sortedEvents() {
  return [...events].sort((first, second) =>
    first.date.localeCompare(second.date) || first.time.localeCompare(second.time));
}

function formatEventDate(dateKey) {
  return displayDateFormatter.format(new Date(`${dateKey}T00:00:00`));
}

function eventMarkup(event, allowDelete) {
  const audience = event.audience ? `<small>${escapeHtml(event.audience)}</small>` : '';
  const description = event.description ? `<p>${escapeHtml(event.description)}</p>` : '';
  const deleteButton = allowDelete
    ? `<button class="delete" type="button" data-delete-event="${escapeHtml(event.id)}" aria-label="Delete ${escapeHtml(event.title)}">×</button>`
    : '';
  return `<article class="event-item">
    <div class="event-date"><b>${escapeHtml(formatEventDate(event.date))}</b><span>${escapeHtml(event.time)}</span></div>
    <div class="event-details"><strong>${escapeHtml(event.title)}</strong>${audience}${description}</div>
    ${deleteButton}
  </article>`;
}

function renderTeachers() {
  $('teacherCount').textContent = `${teachers.length} ${teachers.length === 1 ? 'teacher' : 'teachers'}`;
  $('dashboardTeacherCount').textContent = teachers.length.toLocaleString();
  $('teacherRows').innerHTML = teachers.length
    ? teachers.map(teacher => `<tr>
      <td>${escapeHtml(teacher.name)}</td>
      <td>${escapeHtml(teacher.subject)}</td>
      <td>${escapeHtml(teacher.email || '—')}</td>
      <td><button class="delete" type="button" data-delete-teacher="${escapeHtml(teacher.id)}" aria-label="Remove ${escapeHtml(teacher.name)}">Remove</button></td>
    </tr>`).join('')
    : '<tr><td class="no-results" colspan="4">No teachers added yet.</td></tr>';
}

function renderEventList() {
  const upcoming = sortedEvents().filter(event => event.date >= toDateKey(today));
  $('eventCount').textContent = `${events.length} ${events.length === 1 ? 'event' : 'events'}`;
  $('dashboardEventCount').textContent = upcoming.length.toLocaleString();
  $('eventsList').innerHTML = events.length
    ? sortedEvents().map(event => eventMarkup(event, true)).join('')
    : '<div class="empty">No events yet. Add your first school event above.</div>';
  $('upcomingEvents').innerHTML = upcoming.length
    ? upcoming.slice(0, 5).map(event => eventMarkup(event, false)).join('')
    : '<div class="empty">No upcoming events. Add an event to see it here.</div>';
  renderSelectedDateEvents();
}

function renderSelectedDateEvents() {
  const selectedEvents = sortedEvents().filter(event => event.date === selectedDate);
  $('selectedDateLabel').textContent = `Events on ${formatEventDate(selectedDate)}`;
  $('selectedDateEvents').innerHTML = selectedEvents.length
    ? selectedEvents.map(event => `<div class="selected-event"><b>${escapeHtml(event.time)}</b><span>${escapeHtml(event.title)}</span></div>`).join('')
    : '<p class="empty-inline">No events on this date.</p>';
}

function renderCalendar() {
  $('calendarMonth').textContent = monthFormatter.format(calendarMonth);
  const firstDay = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth(), 1);
  const offset = firstDay.getDay();
  const cells = [];

  for (let index = 0; index < 42; index++) {
    const date = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth(), index - offset + 1);
    const dateKey = toDateKey(date);
    const inMonth = date.getMonth() === calendarMonth.getMonth();
    const dayEvents = events.filter(event => event.date === dateKey).length;
    const classes = ['calendar-day'];
    if (!inMonth) classes.push('muted');
    if (dateKey === selectedDate) classes.push('selected');
    if (dateKey === toDateKey(today)) classes.push('today');
    if (dayEvents) classes.push('marked');
    cells.push(`<button class="${classes.join(' ')}" type="button" data-calendar-date="${dateKey}" aria-label="${escapeHtml(formatEventDate(dateKey))}${dayEvents ? `, ${dayEvents} events` : ''}">${date.getDate()}${dayEvents ? '<i></i>' : ''}</button>`);
  }

  $('calendarGrid').innerHTML = [
    ...dayNames.map(name => `<span class="weekday" aria-hidden="true">${name.slice(0, 2)}</span>`),
    ...cells
  ].join('');
}

function renderDashboard() {
  renderAttendance();
  renderTeachers();
  renderEventList();
  renderCalendar();
}

function renderAll() {
  renderAttendance();
  renderTeachers();
  renderEventList();
  renderCalendar();
}

async function loadPortal() {
  const sessionResponse = await fetch('/api/session');
  if (!sessionResponse.ok) throw new Error('Unable to check your sign-in status.');
  const session = await sessionResponse.json();
  if (!session.authenticated) {
    showAuth();
    return;
  }

  const dataResponse = await fetch('/api/data');
  if (!dataResponse.ok) throw new Error('Unable to load your portal data.');
  const savedData = await dataResponse.json();
  appData = {
    ...savedData,
    bd_classes: Array.isArray(savedData.bd_classes) ? savedData.bd_classes : [],
    bd_attendance: savedData.bd_attendance && typeof savedData.bd_attendance === 'object' ? savedData.bd_attendance : {},
    bd_tasks: Array.isArray(savedData.bd_tasks) ? savedData.bd_tasks : [],
    bd_student_names: savedData.bd_student_names && typeof savedData.bd_student_names === 'object' ? savedData.bd_student_names : {},
    bd_teachers: Array.isArray(savedData.bd_teachers) ? savedData.bd_teachers : [],
    bd_events: Array.isArray(savedData.bd_events) ? savedData.bd_events : []
  };
  attendance = appData.bd_attendance;
  studentNames = { ...createDefaultNames(), ...appData.bd_student_names };
  teachers = appData.bd_teachers;
  events = appData.bd_events;
  $('profileName').textContent = session.username || 'BrightDesk';
  $('headerDate').textContent = displayDateFormatter.format(today);
  $('auth-screen').hidden = true;
  $('portal-app').hidden = false;
  $('eventDate').value = selectedDate;
  renderAll();
  showPage('home');
}

function readLegacyPortalData() {
  try {
    const data = {
      bd_classes: JSON.parse(localStorage.getItem('bd_classes') || '[]'),
      bd_attendance: JSON.parse(localStorage.getItem('bd_attendance') || '{}'),
      bd_tasks: JSON.parse(localStorage.getItem('bd_tasks') || '[]'),
      bd_student_names: JSON.parse(localStorage.getItem('bd_student_names') || '{}'),
      bd_teachers: [],
      bd_events: []
    };
    if (!Array.isArray(data.bd_classes) || !data.bd_attendance || typeof data.bd_attendance !== 'object' ||
        Array.isArray(data.bd_attendance) || !Array.isArray(data.bd_tasks) || !data.bd_student_names ||
        typeof data.bd_student_names !== 'object' || Array.isArray(data.bd_student_names)) {
      throw new Error();
    }
    return data;
  } catch {
    throw new Error('Could not import existing browser data. Check your saved portal data and try again.');
  }
}

async function submitAuth(endpoint, username, password) {
  showAuthMessage('');
  const body = { username, password };
  const form = endpoint === '/api/register' ? $('registerForm') : $('loginForm');
  const button = form.querySelector('button[type="submit"]');
  const label = button.querySelector('span');
  const originalLabel = label.textContent;
  button.disabled = true;
  label.textContent = 'Please wait...';
  try {
    if (endpoint === '/api/register' && localStorage.getItem('bd_legacy_migrated') !== 'true') {
      body.data = readLegacyPortalData();
    }
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Unable to sign in.');
    if (endpoint === '/api/register') {
      try {
        localStorage.setItem('bd_legacy_migrated', 'true');
      } catch {
        showAuthMessage('Account created, but the browser data migration marker could not be saved.', true);
      }
    }
    await loadPortal();
  } finally {
    button.disabled = false;
    label.textContent = originalLabel;
  }
}

document.querySelectorAll('.nav[data-page]').forEach(button => {
  button.addEventListener('click', () => showPage(button.dataset.page));
});

document.querySelectorAll('[data-open-page]').forEach(button => {
  button.addEventListener('click', () => showPage(button.dataset.openPage));
});

$('showRegister').addEventListener('click', () => showAuthMode('register'));
$('showLogin').addEventListener('click', () => showAuthMode('login'));
$('loginForm').addEventListener('submit', async event => {
  event.preventDefault();
  try {
    await submitAuth('/api/login', $('loginUsername').value.trim(), $('loginPassword').value);
  } catch (error) {
    showAuthMessage(error.message, true);
  }
});
$('registerForm').addEventListener('submit', async event => {
  event.preventDefault();
  try {
    await submitAuth('/api/register', $('registerUsername').value.trim(), $('registerPassword').value);
  } catch (error) {
    showAuthMessage(error.message, true);
  }
});
$('logoutButton').addEventListener('click', async () => {
  try {
    const response = await fetch('/api/logout', { method: 'POST' });
    if (!response.ok) throw new Error('Could not log out. Please try again.');
    showAuth();
    showAuthMode('login');
    $('loginForm').reset();
  } catch (error) {
    showSaveMessage(error.message, true);
  }
});

$('studentSearch').addEventListener('input', renderAttendance);
$('studentRows').addEventListener('click', event => {
  const button = event.target.closest('[data-toggle-roll]');
  if (!button) return;
  const roll = button.dataset.toggleRoll;
  attendance[roll] = !attendance[roll];
  appData.bd_attendance = attendance;
  saveData();
  renderDashboard();
});
$('studentForm').addEventListener('submit', event => {
  event.preventDefault();
  const roll = Number($('studentRoll').value);
  const name = $('studentName').value.trim();
  if (!Number.isSafeInteger(roll) || roll < 1 || !name) return;
  if (studentNames[roll]) {
    showSaveMessage('A student already exists with this roll number.', true);
    return;
  }
  studentNames[roll] = name;
  appData.bd_student_names = studentNames;
  saveData();
  event.target.reset();
  renderDashboard();
});
$('allPresent').addEventListener('click', () => {
  getStudents().forEach(roll => { attendance[roll] = true; });
  appData.bd_attendance = attendance;
  saveData();
  renderDashboard();
});
$('resetAttendance').addEventListener('click', () => {
  if (!confirm('Reset attendance for all students?')) return;
  attendance = {};
  appData.bd_attendance = attendance;
  saveData();
  renderDashboard();
});

$('teacherForm').addEventListener('submit', event => {
  event.preventDefault();
  teachers.push({
    id: crypto.randomUUID(),
    name: $('teacherName').value.trim(),
    subject: $('teacherSubject').value.trim(),
    email: $('teacherEmail').value.trim()
  });
  appData.bd_teachers = teachers;
  saveData();
  event.target.reset();
  renderDashboard();
});
$('teacherRows').addEventListener('click', event => {
  const button = event.target.closest('[data-delete-teacher]');
  if (!button) return;
  teachers = teachers.filter(teacher => teacher.id !== button.dataset.deleteTeacher);
  appData.bd_teachers = teachers;
  saveData();
  renderDashboard();
});

$('eventForm').addEventListener('submit', event => {
  event.preventDefault();
  const title = $('eventTitle').value.trim();
  const date = $('eventDate').value;
  const time = $('eventTime').value;
  if (!title || !date || !time) return;
  events.push({
    id: crypto.randomUUID(),
    title,
    date,
    time,
    audience: $('eventAudience').value.trim(),
    description: $('eventDescription').value.trim()
  });
  selectedDate = date;
  calendarMonth = new Date(`${date}T00:00:00`);
  appData.bd_events = events;
  saveData();
  event.target.reset();
  $('eventDate').value = selectedDate;
  renderDashboard();
});
$('eventsList').addEventListener('click', event => {
  const button = event.target.closest('[data-delete-event]');
  if (!button) return;
  events = events.filter(item => item.id !== button.dataset.deleteEvent);
  appData.bd_events = events;
  saveData();
  renderDashboard();
});

$('calendarPrev').addEventListener('click', () => {
  calendarMonth = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() - 1, 1);
  renderCalendar();
});
$('calendarNext').addEventListener('click', () => {
  calendarMonth = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() + 1, 1);
  renderCalendar();
});
$('calendarGrid').addEventListener('click', event => {
  const button = event.target.closest('[data-calendar-date]');
  if (!button) return;
  selectedDate = button.dataset.calendarDate;
  const selected = new Date(`${selectedDate}T00:00:00`);
  calendarMonth = new Date(selected.getFullYear(), selected.getMonth(), 1);
  $('eventDate').value = selectedDate;
  renderCalendar();
  renderSelectedDateEvents();
});

loadPortal().catch(error => {
  showAuth();
  showAuthMessage(error.message, true);
});
