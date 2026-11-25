const byId = id => document.getElementById(id);
const dateLabel = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const monthLabel = new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' });
const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const weekdays = byId('schedule-weekdays');
for (const [index, day] of days.entries()) {
  const label = document.createElement('label');
  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.value = index;
  label.append(checkbox, day);
  weekdays.append(label);
}

const calendar = byId('calendar-days');
const targetFilter = byId('calendar-target');
const scheduleDialog = byId('schedule-dialog');
const accessDialog = byId('access-dialog');

function calendarDate(date) {
  return date.toISOString().slice(0, 10);
}

function dayInZone(zone) {
  const fields = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts().filter(part => part.type !== 'literal');
  const date = Object.fromEntries(fields.map(part => [part.type, part.value]));
  return new Date(Date.UTC(Number(date.year), Number(date.month) - 1, Number(date.day)));
}

function scheduleDay(schedule, day) {
  const date = calendarDate(day);
  return (!schedule.from || date >= schedule.from) && (!schedule.to || date <= schedule.to) &&
    schedule.days.includes(day.getUTCDay());
}

function timeLabel({ start, end }) {
  return start === end ? 'All day' : `${start}–${end}`;
}

function calendarTimes(schedule, date) {
  const times = [];
  const overnight = schedule.start > schedule.end;
  if (overnight && schedule.end !== '00:00' && scheduleDay(schedule, new Date(+date - 86400000))) {
    times.push('Until ' + schedule.end);
  }
  if (scheduleDay(schedule, date)) times.push(overnight ? `From ${schedule.start}` : timeLabel(schedule));
  return times;
}

export function renderPlaylist(items, media, list, add, makeButton, emptyMessage, rerender) {
  list.replaceChildren(...items.map((id, index) => {
    const item = document.createElement('li');
    const name = document.createElement('span');
    name.textContent = media.find(entry => entry.id === id)?.name || 'Unavailable media';
    const move = delta => {
      const destination = index + delta;
      [items[index], items[destination]] = [items[destination], items[index]];
      rerender();
    };
    const up = makeButton('Up', () => move(-1));
    const down = makeButton('Down', () => move(1));
    up.disabled = index === 0;
    down.disabled = index === items.length - 1;
    item.append(name, up, down, makeButton('Remove', () => {
      items.splice(index, 1);
      rerender();
    }));
    return item;
  }));
  if (!items.length) {
    const empty = document.createElement('li');
    empty.textContent = emptyMessage;
    list.append(empty);
  }
  add.disabled = !media.length || items.length >= 40;
}

export function createOperations({ request, makeButton, say }) {
  let fleet;
  let month;
  let calendarKey;
  let historyKey;
  let systemKey;
  let scheduleId;
  let playlist = [];
  let accessId;

  const canSchedule = () => ['admin', 'publisher'].includes(fleet?.role);

  function options() {
    const sites = [...new Set(fleet.kiosks.map(device => device.site).filter(Boolean))].sort();
    return [new Option('Entire fleet', 'fleet:'),
      ...sites.map(site => new Option('Site · ' + site, 'site:' + site)),
      ...fleet.kiosks.map(device => new Option('Kiosk · ' + device.label, 'device:' + device.id))];
  }

  function matchesFilter(schedule, selected) {
    if (selected === 'all') return true;
    if (schedule.target === 'fleet') return true;
    if (selected === schedule.target + ':' + schedule.targetValue) return true;
    if (selected.startsWith('device:') && schedule.target === 'site') {
      return fleet.kiosks.find(device => device.id === selected.slice(7))?.site === schedule.targetValue;
    }
    return false;
  }

  function targetLabel(schedule) {
    if (schedule.target === 'fleet') return 'Entire fleet';
    if (schedule.target === 'site') return schedule.targetValue;
    return fleet.kiosks.find(device => device.id === schedule.targetValue)?.label ?? schedule.targetValue;
  }

  function renderCalendar() {
    if (!fleet?.server) return;
    const today = dayInZone(fleet.server.zone);
    month ??= new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
    const key = JSON.stringify([+month, calendarDate(today), targetFilter.value, fleet.role, fleet.schedules,
      fleet.kiosks.map(({ id, label, site }) => [id, label, site])]);
    if (key === calendarKey) return;
    calendarKey = key;
    const selected = targetFilter.value;
    targetFilter.replaceChildren(new Option('All schedules', 'all'), ...options());
    targetFilter.value = [...targetFilter.options].some(option => option.value === selected) ? selected : 'all';
    byId('calendar-month').textContent = monthLabel.format(month);
    const visible = fleet.schedules.filter(schedule => matchesFilter(schedule, targetFilter.value));
    const first = +month - month.getUTCDay() * 86400000;
    const count = Math.ceil((month.getUTCDay() + new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + 1, 0)).getUTCDate()) / 7) * 7;
    const cells = Array.from({ length: count }, (_, day) => {
      const date = new Date(first + day * 86400000);
      const cell = document.createElement('div');
      cell.className = 'calendar-cell';
      cell.classList.toggle('outside', date.getUTCMonth() !== month.getUTCMonth());
      cell.classList.toggle('today', +date === +today);
      const create = makeButton(String(date.getUTCDate()), () => openSchedule(null, date));
      create.className = 'day-number';
      create.disabled = !canSchedule();
      create.setAttribute('aria-label', 'Schedule content on ' + calendarDate(date));
      cell.append(create);
      for (const schedule of visible.filter(item => item.enabled)) {
        for (const time of calendarTimes(schedule, date)) {
          const event = makeButton(`${time} · ${schedule.name}`, () => openSchedule(schedule));
          event.className = 'calendar-event';
          event.dataset.target = schedule.target;
          event.title = `${schedule.name} · ${schedule.zone} · ${targetLabel(schedule)}`;
          cell.append(event);
        }
      }
      return cell;
    });
    calendar.replaceChildren(...cells);
    byId('saved-schedules').replaceChildren(...visible.map(schedule => {
      const item = document.createElement('li');
      const text = document.createElement('span');
      text.textContent = `${schedule.name} · ${targetLabel(schedule)} · ${timeLabel(schedule)} · ${schedule.enabled ? 'Enabled' : 'Paused'}`;
      item.append(text, makeButton('Edit', () => openSchedule(schedule)));
      return item;
    }));
    if (!visible.length) {
      const empty = document.createElement('li');
      empty.textContent = 'No schedules for this selection.';
      byId('saved-schedules').append(empty);
    }
  }

  function openSchedule(schedule, date, assetId) {
    if (!fleet?.server || (!schedule && !canSchedule())) return;
    const suggested = targetFilter.value === 'all' ? 'fleet:' : targetFilter.value;
    const fields = {
      name: '', target: suggested, from: date ? calendarDate(date) : '', to: date ? calendarDate(date) : '',
      zone: fleet.server.zone, start: '00:00', end: '00:00', priority: 0, ...schedule,
    };
    if (schedule) fields.target = schedule.target + ':' + schedule.targetValue;
    const target = byId('schedule-target');
    target.replaceChildren(...options());
    if (![...target.options].some(option => option.value === fields.target)) {
      target.append(new Option('Unassigned site · ' + schedule.targetValue, fields.target));
    }
    for (const name of ['name', 'target', 'from', 'to', 'zone', 'start', 'end', 'priority']) byId('schedule-' + name).value = fields[name];
    for (const checkbox of weekdays.querySelectorAll('input')) {
      checkbox.checked = schedule ? schedule.days.includes(Number(checkbox.value)) : true;
    }
    scheduleId = schedule?.id;
    playlist = [...(schedule?.playlist ?? (assetId ? [assetId] : []))];
    byId('schedule-enabled').checked = schedule?.enabled ?? true;
    byId('schedule-title').textContent = schedule ? 'Edit schedule' : 'New schedule';
    byId('delete-schedule').hidden = !schedule;
    byId('delete-schedule').disabled = byId('save-schedule').disabled = !canSchedule();
    byId('schedule-media').replaceChildren(...fleet.media.map(item => new Option(item.name, item.id)));
    showPlaylist();
    say('schedule-error', '');
    scheduleDialog.showModal();
  }

  function showPlaylist() {
    renderPlaylist(playlist, fleet.media, byId('schedule-playlist'), byId('schedule-add'), makeButton, 'Add media from the library.', showPlaylist);
  }

  byId('new-schedule').onclick = () => openSchedule(null);
  targetFilter.onchange = renderCalendar;
  function stepMonth(delta) {
    if (!month) return;
    month = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + delta, 1));
    renderCalendar();
  }
  byId('month-prev').onclick = () => stepMonth(-1);
  byId('month-next').onclick = () => stepMonth(1);
  byId('month-today').onclick = () => { month = undefined; renderCalendar(); };
  byId('close-schedule').onclick = () => scheduleDialog.close();
  byId('schedule-add').onclick = () => {
    playlist.push(byId('schedule-media').value);
    showPlaylist();
  };
  byId('schedule-form').onsubmit = async event => {
    event.preventDefault();
    const button = byId('save-schedule');
    button.disabled = true;
    const field = name => byId('schedule-' + name).value;
    const selected = field('target');
    const separator = selected.indexOf(':');
    try {
      await request(scheduleId ? '/api/schedules/' + scheduleId : '/api/schedules', {
        method: scheduleId ? 'PUT' : 'POST',
        body: {
          name: field('name'), target: selected.slice(0, separator), targetValue: selected.slice(separator + 1),
          from: field('from'), to: field('to'), zone: field('zone'), start: field('start'), end: field('end'),
          priority: Number(field('priority')), enabled: byId('schedule-enabled').checked, playlist,
          days: [...weekdays.querySelectorAll('input:checked')].map(checkbox => Number(checkbox.value)),
        },
      });
      scheduleDialog.close();
      say('schedule-message', 'Schedule published. Assigned kiosks will sync the playlist.');
    } catch (error) {
      say('schedule-error', error.message, true);
    } finally {
      button.disabled = false;
    }
  };
  byId('delete-schedule').onclick = async () => {
    if (!confirm('Delete this schedule?')) return;
    try {
      await request('/api/schedules/' + scheduleId, { method: 'DELETE' });
      scheduleDialog.close();
      say('schedule-message', 'Schedule deleted.');
    } catch (error) {
      say('schedule-error', error.message, true);
    }
  };

  function openAccess(device) {
    accessId = device?.id;
    byId('access-title').textContent = device ? `Access for ${device.label}` : 'Enroll kiosk';
    byId('enroll-fields').hidden = !!device;
    for (const field of byId('enroll-fields').querySelectorAll('input')) {
      field.disabled = !!device;
      field.value = '';
    }
    byId('access-info').textContent = device ? `Credential status: ${device.enrollment}.` : '';
    byId('revoke-access').hidden = !device || device.enrollment === 'revoked';
    byId('issue-access').hidden = false;
    byId('issue-access').textContent = device ? 'Issue new credential' : 'Enroll and issue credential';
    byId('credential-field').hidden = true;
    say('access-message', '');
    accessDialog.showModal();
  }
  byId('enroll').onclick = () => openAccess();
  byId('close-access').onclick = () => accessDialog.close();
  accessDialog.onclose = () => { byId('credential-config').value = ''; };
  byId('access-form').onsubmit = async event => {
    event.preventDefault();
    if (accessId && !confirm('Issue a replacement credential? The previous credential will stop working.')) return;
    const button = byId('issue-access');
    button.disabled = true;
    try {
      const result = await request(accessId ? `/api/kiosk/${encodeURIComponent(accessId)}/credential` : '/api/enroll', {
        method: 'POST',
        body: accessId ? undefined : { id: byId('enroll-id').value.trim(), name: byId('enroll-name').value, site: byId('enroll-site').value },
      });
      byId('credential-config').value = `SERVER_URL=${result.serverUrl || location.origin}\nKIOSK_ID=${result.id}\nKIOSK_TOKEN=${result.token}\nKIOSK_MODE=${fleet.server.mode}\n`;
      byId('credential-field').hidden = false;
      byId('enroll-fields').hidden = true;
      button.hidden = true;
      byId('revoke-access').hidden = true;
      byId('credential-config').select();
      say('access-message', '');
    } catch (error) {
      say('access-message', error.message, true);
    } finally {
      button.disabled = false;
    }
  };
  byId('revoke-access').onclick = async () => {
    if (!confirm('Revoke this kiosk’s access to the server?')) return;
    try {
      await request(`/api/kiosk/${encodeURIComponent(accessId)}/revoke`, { method: 'POST' });
      accessDialog.close();
      say('message', 'Kiosk credential revoked.');
    } catch (error) {
      say('access-message', error.message, true);
    }
  };

  function renderSystem(data) {
    const admin = data.role === 'admin';
    if (!admin) return;
    const { limit, used } = data.license;
    byId('license-summary').textContent = limit === null ? `${used} seats assigned · Unlimited capacity` :
      `${used} of ${limit} seats assigned`;
    const key = JSON.stringify(data.accounts.map(account => [account, account.inviteUntil > Date.now()]));
    if (key === systemKey) return;
    systemKey = key;
    byId('account-list').replaceChildren(...data.accounts.map(account => {
      const item = document.createElement('li');
      const name = document.createElement('span');
      const registration = account.active ? 'Active' : account.inviteUntil > Date.now() ? 'Invited' : 'Invitation expired';
      name.textContent = `${account.id} · ${registration}`;
      const select = document.createElement('select');
      select.setAttribute('aria-label', 'Role for ' + account.id);
      select.append(...[['Viewer', 'viewer'], ['Publisher', 'publisher'], ['Operator', 'operator'], ['Superuser', 'admin']].map(([label, role]) => new Option(label, role)));
      select.value = account.role;
      select.onchange = async () => {
        try {
          await request('/api/accounts/' + encodeURIComponent(account.id), { method: 'PUT', body: { role: select.value } });
          say('account-message', 'Role updated.');
        } catch (error) {
          select.value = account.role;
          say('account-message', error.message, true);
        }
      };
      const remove = makeButton('Remove', async () => {
        if (!confirm('Remove access for ' + account.id + '?')) return;
        try {
          await request('/api/accounts/' + encodeURIComponent(account.id), { method: 'DELETE' });
          say('account-message', 'Account removed.');
        } catch (error) {
          say('account-message', error.message, true);
        }
      });
      const reset = makeButton(account.active ? 'Reset invitation' : 'Reissue invitation', async () => {
        try {
          showInvite(await request('/api/accounts/' + encodeURIComponent(account.id) + '/invite', { method: 'POST' }));
        } catch (error) {
          say('account-message', error.message, true);
        }
      });
      item.append(name, select, reset, remove);
      return item;
    }));
  }

  function showInvite(result) {
    byId('account-password').value = result.token;
    byId('account-secret').hidden = false;
    byId('account-password').select();
    say('account-message', `Share this code with ${result.id}. It can be used once and expires in 24 hours.`);
  }

  byId('account-form').onsubmit = async event => {
    event.preventDefault();
    const button = event.currentTarget.querySelector('button');
    button.disabled = true;
    byId('account-secret').hidden = true;
    byId('account-password').value = '';
    try {
      const result = await request('/api/accounts/invite', {
        method: 'POST', body: { id: byId('account-id').value.trim(), role: byId('account-role').value },
      });
      showInvite(result);
      byId('account-id').value = '';
    } catch (error) {
      say('account-message', error.message, true);
    } finally {
      button.disabled = false;
    }
  };

  function render(data) {
    if (!data.server) return;
    fleet = data;
    const { server } = data;
    byId('server-identity').textContent = `${server.name} · ${server.url || location.origin} · ${server.mode}`;
    byId('server-health').textContent = 'Online';
    byId('server-version').textContent = server.version;
    byId('server-uptime').textContent = dateLabel.format(server.startedAt);
    byId('server-kiosks').textContent = `${data.kiosks.filter(device => device.online).length} of ${data.kiosks.length} online`;
    byId('enroll').disabled = data.role !== 'admin';
    byId('new-schedule').disabled = !canSchedule();
    const peerList = byId('peer-servers');
    peerList.hidden = !data.peers?.length;
    const peerKey = JSON.stringify(data.peers?.map(({ name, status, url }) => [name, status, url]));
    if (peerList.dataset.key !== peerKey) {
      peerList.dataset.key = peerKey;
      peerList.replaceChildren(...(data.peers ?? []).map(peer => {
        const item = document.createElement('li');
        const link = document.createElement('a');
        link.href = peer.url;
        link.textContent = peer.name;
        link.target = '_blank';
        link.rel = 'noopener';
        item.append(link, ` · ${peer.status}`);
        return item;
      }));
    }
    renderSystem(data);
    renderCalendar();
    const key = JSON.stringify(data.events);
    if (historyKey !== key) {
      historyKey = key;
      byId('event-log').hidden = !data.events?.length;
      byId('operations-history').replaceChildren(...(data.events ?? []).map(event => {
        const item = document.createElement('li');
        item.textContent = `${dateLabel.format(event.at)} · ${event.action}${event.kioskId ? ' · ' + event.kioskId : ''}${event.actor ? ' · ' + event.actor : ''}`;
        return item;
      }));
    }
  }
  function disconnected() {
    byId('server-health').textContent = 'Connection lost';
    byId('enroll').disabled = byId('new-schedule').disabled = true;
  }
  function schedulePresentation(id) {
    if (!fleet?.server) return;
    location.hash = 'scheduler';
    openSchedule(null, dayInZone(fleet.server.zone), id);
  }

  return { render, disconnected, openAccess, schedulePresentation };
}
