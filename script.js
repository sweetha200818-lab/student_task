const $ = id => document.getElementById(id);
const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const monthFormatter = new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' });
const displayDateFormatter = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
const today = new Date();
let appData = {};
let attendance = {};
let attendanceRecords = {};
let attendanceDate = toDateKey(today);
let studentNames = {};
let accountStudentNames = {};
let teachers = [];
let teacherAccounts = [];
let events = [];
let selectedDate = toDateKey(today);
let calendarMonth = new Date(today.getFullYear(), today.getMonth(), 1);
let saveQueue = Promise.resolve();
let saveMessageTimer;
let currentUser = null;
let studentAttendanceRecords = [];
let assignments = [];

function toDateKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function normalizeAttendance(value) {
  const entries = Object.entries(value);
  const hasDateBuckets = entries.some(([key, record]) =>
    /^\d{4}-\d{2}-\d{2}$/.test(key) && record && typeof record === 'object' && !Array.isArray(record));
  if (!hasDateBuckets) return entries.length ? { [toDateKey(today)]: value } : {};
  return Object.fromEntries(entries.filter(([key, record]) =>
    /^\d{4}-\d{2}-\d{2}$/.test(key) && record && typeof record === 'object' && !Array.isArray(record)));
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

function saveData(successMessage = 'Changes saved.') {
  const payload = JSON.stringify(appData);
  saveQueue = saveQueue
    .then(async () => {
      const response = await fetch('/api/data', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: payload
      });
      if (!response.ok) throw new Error('Unable to save your changes.');
      showSaveMessage(successMessage);
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
  const studentRegistering = mode === 'register';
  const teacherRegistering = mode === 'teacher-register';
  $('loginForm').hidden = studentRegistering || teacherRegistering;
  $('registerForm').hidden = !studentRegistering;
  $('teacherRegisterForm').hidden = !teacherRegistering;
  $('authRoleChoice').hidden = studentRegistering || teacherRegistering;
  $('auth-title').textContent = studentRegistering || teacherRegistering ? 'Create your account' : 'Welcome back';
  $('auth-description').textContent = studentRegistering
    ? 'Create your student account using your roll number.'
    : teacherRegistering ? 'Create a teacher account with your own username and password.' : 'Sign in to continue to your portal.';
  showAuthMessage('');
}

function configureAccountUsername(role) {
  const isStudent = role === 'student';
  const usernameLabel = $('accountNewUsername').closest('label');
  const passwordLabel = $('accountNewPassword').closest('label');
  usernameLabel.hidden = isStudent;
  passwordLabel.hidden = false;
  $('accountNewUsername').required = false;
  $('accountNewPassword').required = false;
  $('accountNewUsernameLabel').textContent = 'New username (optional)';
  $('accountNewUsername').pattern = '[A-Za-z0-9._-]{3,64}';
  $('accountNewUsername').minLength = 3;
  $('accountNewUsername').maxLength = 64;
  $('accountNewUsername').placeholder = 'Leave blank to keep current';
}

function showAuthRoleChoice() {
  $('authRoleChoice').hidden = false;
  $('loginForm').hidden = true;
  $('registerForm').hidden = true;
  $('teacherRegisterForm').hidden = true;
  $('auth-title').textContent = 'Choose login type';
  $('auth-description').textContent = 'Select your account type to continue.';
  showAuthMessage('');
}

function openRoleLogin(role) {
  $('loginRole').value = role;
  $('authRoleChoice').hidden = true;
  $('loginForm').hidden = false;
  $('registerForm').hidden = true;
  $('teacherRegisterForm').hidden = true;
  $('loginUsername').value = '';
  $('loginPassword').value = '';
  if (role === 'student') {
    $('auth-title').textContent = 'Student login';
    $('auth-description').textContent = 'Use your student username and password.';
    $('loginUsernameLabel').textContent = 'Student username (roll number)';
    $('loginUsername').placeholder = 'e.g. 100';
  } else {
    $('auth-title').textContent = 'Teacher login';
    $('auth-description').textContent = 'Use your teacher username and password.';
    $('loginUsernameLabel').textContent = 'Teacher username';
    $('loginUsername').placeholder = 'e.g. meena.k';
  }
  $('showRegister').innerHTML = role === 'teacher'
    ? 'New here? <strong>Create teacher account</strong>'
    : 'New here? <strong>Create student account</strong>';
  showAuthMessage('');
  $('loginUsername').focus();
}

function showAuth() {
  $('auth-screen').hidden = false;
  $('portal-app').hidden = true;
  showAuthRoleChoice();
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
    attendance: 'Attendance',
    teachers: 'Teachers',
    events: 'Events',
    account: 'My Account'
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
  [...Object.keys(studentNames), ...Object.keys(accountStudentNames)].forEach(key => {
    const roll = Number(key);
    if (Number.isSafeInteger(roll) && roll > 0) rolls.add(roll);
  });
  return [...rolls].sort((a, b) => a - b);
}

function getNextStudentRoll() {
  const rolls = getStudents();
  return (rolls[rolls.length - 1] || 0) + 1;
}

function renderAttendance() {
  const students = getStudents();
  const canMarkAttendance = currentUser && currentUser.role !== 'student';
  const isMarked = (record, roll) => Object.prototype.hasOwnProperty.call(record, roll);
  const present = students.filter(roll => attendance[roll] === true).length;
  const absent = students.filter(roll => isMarked(attendance, roll) && attendance[roll] !== true).length;
  const unmarked = students.length - present - absent;
  const attendancePercent = absent + present ? `${Math.round(present / students.length * 100)}%` : '—';
  const todayAttendance = attendanceRecords[toDateKey(today)] || {};
  const todayPresent = students.filter(roll => todayAttendance[roll] === true).length;
  const todayAbsent = students.filter(roll => isMarked(todayAttendance, roll) && todayAttendance[roll] !== true).length;
  const todayUnmarked = students.length - todayPresent - todayAbsent;
  const todayPercent = todayPresent + todayAbsent ? `${Math.round(todayPresent / students.length * 100)}%` : '—';
  const nextRoll = getNextStudentRoll();
  $('studentRoll').value = Number.isSafeInteger(nextRoll) ? nextRoll : '';
  const query = $('studentSearch').value.trim().toLowerCase();
  const filtered = students.filter(roll => {
    const paddedRoll = String(roll).padStart(3, '0');
    const name = accountStudentNames[roll] || studentNames[roll] || `Student ${paddedRoll}`;
    return !query || paddedRoll.includes(query) || String(roll).includes(query) || name.toLowerCase().includes(query);
  });

  $('totalStudents').textContent = students.length;
  $('presentStat').textContent = present;
  $('absentStat').textContent = absent;
  $('unmarkedStat').textContent = unmarked;
  $('percentStat').textContent = attendancePercent;
  $('attendanceDateSummary').textContent = `${formatEventDate(attendanceDate)} attendance`;
  $('attendanceReportDate').value = attendanceDate;
  $('attendanceReportTotal').textContent = students.length;
  $('attendanceReportPresent').textContent = present;
  $('attendanceReportAbsent').textContent = absent;
  $('attendanceReportUnmarked').textContent = unmarked;
  $('attendanceReportRate').textContent = attendancePercent;
  $('attendanceReportHint').textContent = `${formatEventDate(attendanceDate)} attendance`;
  $('studentRows').innerHTML = filtered.length
    ? filtered.map(roll => {
      const paddedRoll = String(roll).padStart(3, '0');
      const name = accountStudentNames[roll] || studentNames[roll] || `Student ${paddedRoll}`;
      const marked = isMarked(attendance, roll);
      const isPresent = attendance[roll] === true;
      const statusText = isPresent ? 'Present' : marked ? 'Absent' : 'Not marked';
      const statusClass = isPresent ? 'present' : marked ? 'absent' : 'unmarked';
      return `<tr>
        <td>${paddedRoll}</td>
        <td>${escapeHtml(name)}</td>
        <td><span class="status ${statusClass}">${statusText}</span></td>
        <td>${canMarkAttendance ? `<button class="toggle" type="button" data-toggle-roll="${roll}">${isPresent ? 'Mark absent' : 'Mark present'}</button>` : '—'}</td>
      </tr>`;
    }).join('')
    : '<tr><td class="no-results" colspan="4">No matching student found.</td></tr>';

  $('dashboardStudentCount').textContent = students.length.toLocaleString();
  $('dashboardAttendance').textContent = todayPercent;
  $('attendanceRingValue').textContent = todayPercent;
  $('attendancePresentCount').textContent = todayPresent;
  $('attendanceAbsentCount').textContent = todayAbsent;
  $('attendanceUnmarkedCount').textContent = todayUnmarked;
  $('attendanceTotalCount').textContent = students.length;
  $('overviewStudents').textContent = `${students.length} ${students.length === 1 ? 'student' : 'students'}`;
  const ring = document.querySelector('.attendance-ring');
  if (ring) ring.style.setProperty('--attendance', todayPresent + todayAbsent ? todayPercent : '0%');
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
  let studentActions = '';
  if (currentUser && currentUser.role === 'student') {
    if (event.status === 'completed') {
      studentActions = '<span class="status present">Successfully you completed</span>';
    } else if (event.status === 'incomplete') {
      studentActions = '<span class="status absent">Penalty will be applied</span>';
    } else {
      studentActions = `<div class="assignment-actions"><button class="primary" type="button" data-event-complete="${escapeHtml(event.id)}">Complete</button><button class="soft" type="button" data-event-incomplete="${escapeHtml(event.id)}">Incomplete</button></div>`;
    }
  }
  const recipientDetails = currentUser && currentUser.role === 'teacher' && Array.isArray(event.recipientDetails)
    ? `<ul>${event.recipientDetails.map(student =>
      `<li>Roll ${escapeHtml(student.rollNumber || '-')} — ${student.viewed ? 'Viewed' : 'Not viewed'} — ${escapeHtml(student.status || 'pending')}${student.penalty ? ` (${escapeHtml(student.penalty)})` : ''}</li>`
    ).join('')}</ul>`
    : '';
  const deleteButton = allowDelete
    ? `<button class="delete" type="button" data-delete-event="${escapeHtml(event.id)}" aria-label="Delete ${escapeHtml(event.title)}">×</button>`
    : '';
  return `<article class="event-item">
    <div class="event-date"><b>${escapeHtml(formatEventDate(event.date))}</b><span>${escapeHtml(event.time)}</span></div>
    <div class="event-details"><strong>${escapeHtml(event.title)}</strong>${audience}${description}${recipientDetails}</div>
    ${deleteButton}${studentActions}
  </article>`;
}

function renderTeachers() {
  const directoryNames = new Set(teachers.map(teacher => teacher.name.trim().toLocaleLowerCase()).filter(Boolean));
  const accountOnlyTeachers = teacherAccounts.filter(account =>
    !account.displayName || !directoryNames.has(account.displayName.trim().toLocaleLowerCase()));
  const allTeachers = teachers.length + accountOnlyTeachers.length;
  $('teacherCount').textContent = `${allTeachers} ${allTeachers === 1 ? 'teacher' : 'teachers'}`;
  $('dashboardTeacherCount').textContent = allTeachers.toLocaleString();
  $('overviewTeachers').textContent = `${allTeachers} ${allTeachers === 1 ? 'teacher' : 'teachers'}`;
  const directoryRows = teachers.map(teacher => `<tr>
      <td>${escapeHtml(teacher.name)}</td>
      <td>${escapeHtml(teacher.subject)}</td>
      <td>${escapeHtml(teacher.email || '—')}</td>
      <td><button class="delete" type="button" data-delete-teacher="${escapeHtml(teacher.id)}" aria-label="Remove ${escapeHtml(teacher.name)}">Remove</button></td>
    </tr>`);
  const accountRows = accountOnlyTeachers.map(account => `<tr>
      <td>${escapeHtml(account.displayName || 'Teacher account')}</td>
      <td>${escapeHtml(account.subject || '—')}</td>
      <td>—</td>
      <td><span class="tag">Login account</span></td>
    </tr>`);
  $('teacherRows').innerHTML = allTeachers
    ? [...directoryRows, ...accountRows].join('')
    : '<tr><td class="no-results" colspan="4">No teachers added yet.</td></tr>';
}

function renderEventList() {
  const upcoming = sortedEvents().filter(event => event.date >= toDateKey(today));
  $('eventCount').textContent = `${events.length} ${events.length === 1 ? 'event' : 'events'}`;
  $('dashboardEventCount').textContent = upcoming.length.toLocaleString();
  $('overviewEvents').textContent = `${upcoming.length} ${upcoming.length === 1 ? 'event' : 'events'}`;
  $('eventsList').innerHTML = events.length
    ? sortedEvents().map(event => eventMarkup(event, currentUser && currentUser.role === 'teacher')).join('')
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
  currentUser = session;

  const dataResponse = await fetch('/api/data');
  if (!dataResponse.ok) throw new Error('Unable to load your portal data.');
  const savedData = await dataResponse.json();
  appData = {
    ...savedData,
    bd_classes: Array.isArray(savedData.bd_classes) ? savedData.bd_classes : [],
    bd_attendance: savedData.bd_attendance && typeof savedData.bd_attendance === 'object' && !Array.isArray(savedData.bd_attendance)
      ? normalizeAttendance(savedData.bd_attendance)
      : {},
    bd_tasks: Array.isArray(savedData.bd_tasks) ? savedData.bd_tasks : [],
    bd_student_names: savedData.bd_student_names && typeof savedData.bd_student_names === 'object' ? savedData.bd_student_names : {},
    bd_teachers: Array.isArray(savedData.bd_teachers) ? savedData.bd_teachers : [],
    bd_events: Array.isArray(savedData.bd_events) ? savedData.bd_events : []
  };
  attendanceRecords = appData.bd_attendance;
  attendance = attendanceRecords[attendanceDate] || {};
  studentNames = { ...createDefaultNames(), ...appData.bd_student_names };
  teachers = appData.bd_teachers;
  events = appData.bd_events;
  $('profileName').textContent = session.username || 'BrightDesk';
  $('accountName').textContent = session.displayName || session.username || 'BrightDesk';
  $('accountRoleLabel').textContent = session.role === 'teacher' ? 'Teacher account' : 'Student account';
  $('accountCurrentUsername').value = session.username || '';
  $('accountEmailAddress').value = session.email || '';
  $('accountNewUsername').value = '';
  $('accountCurrentPassword').value = '';
  $('accountNewPassword').value = '';
  const isTeacher = session.role === 'teacher';
  $('accountRole').dispatchEvent(new Event('change'));
  configureAccountUsername(session.role);
  document.querySelectorAll('.role-teacher-only').forEach(element => {
    element.hidden = !isTeacher;
  });
  $('studentAttendanceView').hidden = isTeacher;
  $('headerDate').textContent = displayDateFormatter.format(today);
  $('auth-screen').hidden = true;
  $('portal-app').hidden = false;
  $('eventDate').value = selectedDate;
  $('attendanceDate').value = attendanceDate;
  $('attendanceReportDate').value = attendanceDate;
  renderAll();
  const accountLoads = [loadTeacherAccounts(), loadSharedEvents(), loadAssignments()];
  $('eventNotificationButton').hidden = isTeacher;
  if (!isTeacher) accountLoads.push(loadStudentAttendance(), loadEventNotifications());
  await Promise.all(accountLoads);
  if (isTeacher) await loadTeacherStudents();
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

async function loadStudentAttendance() {
  const response = await fetch('/api/attendance');
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Unable to load your attendance records.');
  studentAttendanceRecords = result;
  renderStudentAttendance();
}

async function loadAssignments() {
  const response = await fetch('/api/assignments');
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Unable to load assignments.');
  assignments = Array.isArray(result) ? result : [];
  renderAssignments();
}

function renderAssignments() {
  const isTeacher = currentUser && currentUser.role !== 'student';
  $('assignmentCount').textContent = `${assignments.length} ${assignments.length === 1 ? 'assignment' : 'assignments'}`;
  $('assignmentListTitle').textContent = isTeacher ? 'Assignments and submission status' : 'My assignments';
  $('assignmentRows').innerHTML = assignments.length
    ? assignments.map(assignment => {
      const deadline = assignment.dueDate
        ? `${formatEventDate(assignment.dueDate)}${assignment.dueTime ? ` at ${assignment.dueTime}` : ''}`
        : 'No deadline';
      if (isTeacher) {
        const recipients = (assignment.recipientDetails || []).map(student =>
          `<li>${escapeHtml(student.rollNumber ? `Roll ${student.rollNumber} - ` : '')}${escapeHtml(student.displayName)}: <b>${escapeHtml(student.status)}</b>${student.fileName ? ` — ${escapeHtml(student.fileName)}` : ''}</li>`
        ).join('');
        return `<article class="event-item"><div class="event-details"><strong>${escapeHtml(assignment.title)}</strong><small>${escapeHtml(assignment.subject || 'General')}</small><p>Deadline: ${escapeHtml(deadline)}</p><ul>${recipients || '<li>No recipients</li>'}</ul></div></article>`;
      }
      const submitted = assignment.submissionStatus === 'submitted';
      const timeout = assignment.deadlinePassed;
      const action = timeout
        ? '<span class="status absent">Submission timeout</span>'
        : `<div class="assignment-actions"><label>Upload file<input type="file" data-assignment-file="${escapeHtml(assignment.id)}"></label>${assignment.submissionFileName ? `<a href="/api/assignments/${encodeURIComponent(assignment.id)}/file" target="_blank">Download submitted file</a>` : ''}<button class="primary" type="button" data-submit-assignment="${escapeHtml(assignment.id)}">${submitted ? 'Update submission' : 'Submit'}</button><button class="soft" type="button" data-not-submit-assignment="${escapeHtml(assignment.id)}">Not submit</button></div>`;
      return `<article class="event-item"><div class="event-details"><strong>${escapeHtml(assignment.title)}</strong><small>${escapeHtml(assignment.subject || 'General')}</small><p>${escapeHtml(assignment.details || 'No instructions.')}</p><p>Deadline: ${escapeHtml(deadline)}</p><p>Status: <b>${submitted ? 'Submitted' : 'Not submitted'}</b></p></div>${action}</article>`;
    }).join('')
    : '<div class="empty">No assignments available.</div>';
}

async function loadSharedEvents() {
  const response = await fetch('/api/events');
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Unable to load school events.');
  events = Array.isArray(result) ? result : [];
  renderEventList();
  renderCalendar();
}

let eventNotifications = [];

async function loadEventNotifications() {
  if (!currentUser || currentUser.role !== 'student') return;
  const response = await fetch('/api/event-notifications');
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Unable to load event notifications.');
  eventNotifications = Array.isArray(result) ? result : [];
  const unread = eventNotifications.filter(notification => !notification.viewed).length;
  const button = $('eventNotificationButton');
  button.hidden = false;
  button.textContent = unread ? `Events: ${unread} new` : 'Events: viewed';
}

async function loadTeacherStudents() {
  const response = await fetch('/api/students');
  if (!response.ok) throw new Error('Unable to load student accounts.');
  const students = await response.json();
  accountStudentNames = {};
  students.forEach(student => {
    const roll = Number(student.rollNumber);
    if (Number.isSafeInteger(roll) && roll > 0 && student.displayName) {
      accountStudentNames[roll] = student.displayName;
    }
  });
  if ($('assignmentRecipients')) {
    $('assignmentRecipients').innerHTML = students.map(student =>
      `<option value="${escapeHtml(student.username)}">${escapeHtml(`Roll ${student.rollNumber || '-'} - ${student.displayName || student.username}`)}</option>`
    ).join('');
  }
  if ($('eventRecipients')) {
    $('eventRecipients').innerHTML = students.map(student =>
      `<option value="${escapeHtml(student.username)}">${escapeHtml(`Roll ${student.rollNumber || '-'} - ${student.displayName || student.username}`)}</option>`
    ).join('');
  }
  if (typeof renderTeacherStudentDirectory === 'function') renderTeacherStudentDirectory();
  renderAttendance();
}

async function loadTeacherAccounts() {
  const response = await fetch('/api/teachers');
  if (!response.ok) throw new Error('Unable to load teacher accounts.');
  teacherAccounts = await response.json();
  renderTeachers();
}

function renderStudentAttendance() {
  const todayKey = toDateKey(today);
  const record = studentAttendanceRecords.find(item => item.date === todayKey);
  const status = !record ? 'Not marked' : record.present ? 'Present' : 'Absent';
  $('studentAttendanceStatus').textContent = status;
  $('studentAttendanceRows').innerHTML = record
    ? `<tr>
        <td>${escapeHtml(formatEventDate(record.date))}</td>
        <td><span class="status ${record.present ? 'present' : 'absent'}">${record.present ? 'Present' : 'Absent'}</span></td>
      </tr>`
    : '<tr><td class="no-results" colspan="2">Today attendance has not been marked yet.</td></tr>';
}

async function submitAuth(endpoint, username, password) {
  showAuthMessage('');
  const body = { username, password };
  if (endpoint === '/api/login') body.role = $('loginRole').value;
  if (endpoint === '/api/register') {
    const rollNumber = $('registerRollNumber').value.trim();
    body.username = rollNumber;
    body.password = $('registerPassword').value;
    body.displayName = $('registerDisplayName').value.trim();
    body.rollNumber = rollNumber;
    body.email = $('registerEmail').value.trim();
  }
  if (endpoint === '/api/register-teacher') {
    body.role = 'teacher';
    body.displayName = $('teacherRegisterName').value.trim();
    body.username = $('teacherRegisterUsername').value.trim();
    body.email = $('teacherRegisterEmail').value.trim();
    body.subject = $('teacherRegisterSubject').value.trim();
    body.password = $('teacherRegisterPassword').value;
  }
  const form = endpoint === '/api/register'
    ? $('registerForm')
    : endpoint === '/api/register-teacher' ? $('teacherRegisterForm') : $('loginForm');
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

$('studentAccountForm').addEventListener('submit', async event => {
  event.preventDefault();
  try {
    const response = await fetch('/api/accounts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: $('accountRole').value === 'student'
          ? $('accountRollNumber').value.trim()
          : $('accountUsername').value.trim(),
        displayName: $('accountDisplayName').value.trim(),
        rollNumber: $('accountRollNumber').value.trim(),
        email: $('accountEmail').value.trim(),
        subject: $('accountSubject').value.trim(),
        password: $('accountPassword').value,
        role: $('accountRole').value
      })
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Unable to create the student account.');
    event.target.reset();
    $('accountRole').dispatchEvent(new Event('change'));
    await loadTeacherStudents();
    await loadTeacherAccounts();
    showSaveMessage(`${result.role === 'teacher' ? 'Teacher' : 'Student'} account created for ${result.username}.`);
  } catch (error) {
    showSaveMessage(error.message, true);
  }
});

$('accountRole').addEventListener('change', () => {
  const isStudent = $('accountRole').value === 'student';
  $('accountRollField').hidden = !isStudent;
  $('accountRollNumber').required = isStudent;
  $('accountSubjectField').hidden = isStudent;
  $('accountEmail').required = isStudent;
  const usernameLabel = $('accountUsername').closest('label');
  const passwordLabel = $('accountPassword').closest('label');
  usernameLabel.hidden = isStudent;
  passwordLabel.hidden = false;
  $('accountUsername').required = !isStudent;
  $('accountPassword').required = true;
  $('accountUsernameLabel').textContent = 'Teacher login username';
  $('accountUsername').type = 'text';
  $('accountUsername').pattern = '[A-Za-z0-9._-]{3,64}';
  $('accountUsername').minLength = 3;
  $('accountUsername').maxLength = 64;
  $('accountUsername').placeholder = 'e.g. meena.k';
});

$('accountUpdateForm').addEventListener('submit', async event => {
  event.preventDefault();
  try {
    const response = await fetch('/api/account', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: $('accountNewUsername').value.trim(),
        password: $('accountNewPassword').value,
        email: $('accountEmailAddress').value.trim(),
        currentPassword: $('accountCurrentPassword').value
      })
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Unable to update your login details.');
    currentUser.username = result.username;
    currentUser.email = result.email;
    $('profileName').textContent = result.username;
    $('accountCurrentUsername').value = result.username;
    $('accountNewUsername').value = '';
    $('accountCurrentPassword').value = '';
    $('accountNewPassword').value = '';
    showSaveMessage('Login details updated and saved securely.');
  } catch (error) {
    showSaveMessage(error.message, true);
  }
});

$('showRegister').addEventListener('click', () => {
  showAuthMode($('loginRole').value === 'teacher' ? 'teacher-register' : 'register');
});
$('showLogin').addEventListener('click', () => showAuthRoleChoice());
$('chooseStudentLogin').addEventListener('click', () => openRoleLogin('student'));
$('chooseTeacherLogin').addEventListener('click', () => openRoleLogin('teacher'));
$('teacherRegisterBack').addEventListener('click', () => openRoleLogin('teacher'));
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
    await submitAuth('/api/register', $('registerRollNumber').value.trim(), $('registerRollNumber').value.trim());
  } catch (error) {
    showAuthMessage(error.message, true);
  }
});
$('teacherRegisterForm').addEventListener('submit', async event => {
  event.preventDefault();
  try {
    await submitAuth(
      '/api/register-teacher',
      $('teacherRegisterUsername').value.trim(),
      $('teacherRegisterPassword').value
    );
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
$('attendanceDate').addEventListener('change', () => {
  const value = $('attendanceDate').value;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return;
  attendanceDate = value;
  attendance = attendanceRecords[attendanceDate] || {};
  renderDashboard();
});
$('attendanceReportDate').addEventListener('change', () => {
  const value = $('attendanceReportDate').value;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return;
  attendanceDate = value;
  attendance = attendanceRecords[attendanceDate] || {};
  $('attendanceDate').value = value;
  renderDashboard();
});
$('studentRows').addEventListener('click', event => {
  const button = event.target.closest('[data-toggle-roll]');
  if (!button) return;
  const roll = button.dataset.toggleRoll;
  attendance[roll] = !attendance[roll];
  attendanceRecords[attendanceDate] = attendance;
  appData.bd_attendance = attendanceRecords;
  saveData(`Attendance for ${formatEventDate(attendanceDate)} saved.`);
  renderDashboard();
});
$('totalStudentsCard').addEventListener('click', () => {
  $('studentRegister').scrollIntoView({ behavior: 'smooth', block: 'start' });
});
$('studentForm').addEventListener('submit', event => {
  event.preventDefault();
  const roll = Number($('studentRoll').value);
  const name = $('studentName').value.trim();
  if (!Number.isSafeInteger(roll) || roll < 1 || !name) return;
  if (studentNames[roll] || accountStudentNames[roll]) {
    showSaveMessage('A student already exists with this roll number.', true);
    return;
  }
  studentNames[roll] = name;
  appData.bd_student_names = studentNames;
  event.target.reset();
  renderDashboard();
  saveData(`Student added. Total students: ${getStudents().length}.`);
});
$('allPresent').addEventListener('click', () => {
  getStudents().forEach(roll => { attendance[roll] = true; });
  attendanceRecords[attendanceDate] = attendance;
  appData.bd_attendance = attendanceRecords;
  saveData(`All students marked present for ${formatEventDate(attendanceDate)}.`);
  renderDashboard();
});
$('resetAttendance').addEventListener('click', () => {
  if (!confirm(`Reset attendance for ${formatEventDate(attendanceDate)}?`)) return;
  attendance = {};
  attendanceRecords[attendanceDate] = attendance;
  appData.bd_attendance = attendanceRecords;
  saveData(`Attendance reset for ${formatEventDate(attendanceDate)}.`);
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

$('eventForm').addEventListener('submit', async event => {
  event.preventDefault();
  const body = {
    title: $('eventTitle').value.trim(),
    date: $('eventDate').value,
    time: $('eventTime').value,
    audience: $('eventAudience').value.trim(),
    description: $('eventDescription').value.trim(),
    recipients: [...$('eventRecipients').selectedOptions].map(option => option.value)
  };
  if (!body.title || !body.date || !body.time || body.recipients.length === 0) {
    showSaveMessage('Enter event details and select at least one student.', true);
    return;
  }
  try {
    const response = await fetch('/api/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Unable to add event.');
    selectedDate = body.date;
    calendarMonth = new Date(`${body.date}T00:00:00`);
    event.target.reset();
    $('eventDate').value = selectedDate;
    await loadSharedEvents();
  } catch (error) {
    showSaveMessage(error.message, true);
  }
});
$('eventsList').addEventListener('click', async event => {
  const button = event.target.closest('[data-delete-event]');
  const completeButton = event.target.closest('[data-event-complete]');
  const incompleteButton = event.target.closest('[data-event-incomplete]');
  if (completeButton || incompleteButton) {
    const target = completeButton || incompleteButton;
    const status = completeButton ? 'completed' : 'incomplete';
    try {
      const response = await fetch(`/api/events/${encodeURIComponent(target.dataset.eventComplete || target.dataset.eventIncomplete)}/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status })
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Unable to update event status.');
      showSaveMessage(result.message);
      await loadSharedEvents();
    } catch (error) {
      showSaveMessage(error.message, true);
    }
    return;
  }
  if (!button) return;
  try {
    const response = await fetch('/api/events', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: button.dataset.deleteEvent })
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Unable to delete event.');
    await loadSharedEvents();
  } catch (error) {
    showSaveMessage(error.message, true);
  }
});

$('assignmentForm').addEventListener('submit', async event => {
  event.preventDefault();
  const recipients = [...$('assignmentRecipients').selectedOptions].map(option => option.value);
  const body = {
    title: $('assignmentTitle').value.trim(),
    subject: $('assignmentSubject').value.trim(),
    details: $('assignmentDetails').value.trim(),
    dueDate: $('assignmentDueDate').value,
    dueTime: $('assignmentDueTime').value,
    recipients
  };
  if (!body.title || recipients.length === 0) {
    showSaveMessage('Enter an assignment title and select at least one student.', true);
    return;
  }
  try {
    const response = await fetch('/api/assignments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Unable to create assignment.');
    event.target.reset();
    showSaveMessage(result.emailSent ? 'Assignment assigned and emailed.' : 'Assignment saved.');
    await loadAssignments();
  } catch (error) {
    showSaveMessage(error.message, true);
  }
});

$('assignmentRows').addEventListener('click', async event => {
  const button = event.target.closest('[data-submit-assignment]');
  const notSubmitButton = event.target.closest('[data-not-submit-assignment]');
  if (!button && !notSubmitButton) return;
  const assignmentId = button ? button.dataset.submitAssignment : notSubmitButton.dataset.notSubmitAssignment;
  if (notSubmitButton) {
    try {
      const response = await fetch(`/api/assignments/${encodeURIComponent(assignmentId)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'pending' })
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Unable to update assignment.');
      showSaveMessage('Assignment marked not submitted.');
      await loadAssignments();
    } catch (error) {
      showSaveMessage(error.message, true);
    }
    return;
  }
  try {
    const fileInput = document.querySelector(`[data-assignment-file="${CSS.escape(assignmentId)}"]`);
    const file = fileInput && fileInput.files[0];
    if (!file) throw new Error('Please upload a file before submitting.');
    if (file.size > 5 * 1024 * 1024) throw new Error('The assignment file must be 5 MB or smaller.');
    const fileData = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error('Could not read the selected file.'));
      reader.readAsDataURL(file);
    });
    const response = await fetch(`/api/assignments/${encodeURIComponent(assignmentId)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        status: 'submitted',
        fileName: file.name,
        fileType: file.type,
        fileData
      })
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Unable to submit assignment.');
    showSaveMessage('Assignment marked submitted.');
    await loadAssignments();
  } catch (error) {
    showSaveMessage(error.message, true);
  }
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

 $('eventNotificationButton').addEventListener('click', async () => {
  showPage('events');
  await loadSharedEvents();
  await loadEventNotifications();
});

loadPortal().catch(error => {
  showAuth();
  showAuthMessage(error.message, true);
});
