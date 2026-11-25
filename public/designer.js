import { buildSlide, presentationType } from './presentation-view.js';

const byId = id => document.getElementById(id);
const dates = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'medium' });
const emptySlide = () => ({ headline: '', message: '', assetId: '', theme: 'midnight', seconds: 7 });

export function createDesigner({ request, makeButton, say, schedule }) {
  let fleet;
  let deck;
  let index = 0;
  let listKey;
  let dirty = false;
  let lastRows = [];
  let reading = false;
  let setupBusy = false;
  const form = byId('designer-form');
  const fields = {
    headline: byId('slide-headline'), message: byId('slide-message'), assetId: byId('slide-asset'),
    theme: byId('slide-theme'), seconds: byId('slide-seconds'),
  };
  const writable = () => ['admin', 'publisher'].includes(fleet?.role);
  const assets = () => fleet.media.filter(item => /^(image|video)\//.test(item.type));

  function refreshPreview() {
    const slide = deck.slides[index];
    const asset = assets().find(item => item.id === slide.assetId);
    const { panel, visual } = buildSlide({ ...slide, asset }, { preview: true });
    if (visual) visual.src = '/api/media/' + asset.id;
    if (!visual && !slide.headline && !slide.message) {
      const placeholder = document.createElement('p');
      placeholder.textContent = 'Add a headline, message, or media.';
      panel.append(placeholder);
    }
    byId('design-preview').replaceChildren(panel);
  }

  function showSlide() {
    const slide = deck.slides[index];
    byId('slide-list').replaceChildren(...deck.slides.map((entry, position) => {
      const button = makeButton(`Slide ${position + 1}`, () => { index = position; showSlide(); });
      button.setAttribute('aria-pressed', String(position === index));
      if (entry.headline) button.title = entry.headline;
      return button;
    }));
    fields.assetId.replaceChildren(new Option('No media', ''), ...assets().map(item => new Option(item.name, item.id)));
    for (const [name, input] of Object.entries(fields)) {
      input.value = slide[name];
      input.disabled = !writable();
    }
    byId('presentation-name').disabled = !writable();
    byId('slide-up').disabled = !writable() || index === 0;
    byId('slide-down').disabled = !writable() || index === deck.slides.length - 1;
    byId('remove-slide').disabled = !writable() || deck.slides.length === 1;
    byId('add-slide').disabled = !writable() || deck.slides.length >= 8;
    byId('save-presentation').disabled = !writable();
    byId('schedule-presentation').disabled = !writable() || !deck.id || dirty;
    refreshPreview();
  }

  function open(item) {
    if (!fleet) return;
    deck = item ? structuredClone(item) : { name: '', slides: [emptySlide()] };
    index = 0;
    dirty = false;
    byId('presentation-name').value = deck.name;
    form.hidden = false;
    say('designer-message', '');
    showSlide();
  }

  function markDirty() {
    dirty = true;
    byId('schedule-presentation').disabled = true;
  }

  byId('presentation-name').oninput = markDirty;
  for (const [name, input] of Object.entries(fields)) {
    input.oninput = () => {
      deck.slides[index][name] = name === 'seconds' ? Number(input.value) : input.value;
      markDirty();
      if (name !== 'seconds') refreshPreview();
    };
  }
  byId('new-presentation').onclick = () => open();
  byId('use-template').onclick = () => open({
    name: 'Visitor welcome',
    slides: [
      { ...emptySlide(), headline: 'Welcome', message: 'Step closer to start your check-in.', theme: 'green', seconds: 6 },
      { ...emptySlide(), headline: 'Here to help', message: 'Our team is available at reception.', theme: 'midnight', seconds: 6 },
    ],
  });
  byId('add-slide').onclick = () => {
    if (deck.slides.length >= 8) return;
    deck.slides.push(emptySlide());
    index = deck.slides.length - 1;
    markDirty();
    showSlide();
  };
  function move(offset) {
    const destination = index + offset;
    [deck.slides[index], deck.slides[destination]] = [deck.slides[destination], deck.slides[index]];
    index = destination;
    markDirty();
    showSlide();
  }
  byId('slide-up').onclick = () => move(-1);
  byId('slide-down').onclick = () => move(1);
  byId('remove-slide').onclick = () => {
    deck.slides.splice(index, 1);
    index = Math.min(index, deck.slides.length - 1);
    markDirty();
    showSlide();
  };
  byId('schedule-presentation').onclick = () => schedule(deck);
  form.onsubmit = async event => {
    event.preventDefault();
    const button = byId('save-presentation');
    button.disabled = true;
    try {
      const result = await request(deck.id ? '/api/presentations/' + deck.id : '/api/presentations', {
        method: deck.id ? 'PUT' : 'POST',
        body: { name: byId('presentation-name').value, slides: deck.slides },
      });
      open(result);
      say('designer-message', 'Presentation saved. Schedule it or add it to a destination playlist.');
    } catch (error) {
      say('designer-message', error.message, true);
    } finally {
      button.disabled = !writable();
    }
  };

  function show(item) {
    location.hash = 'designer';
    open(item);
  }

  function render(data) {
    fleet = data;
    byId('new-presentation').disabled = byId('use-template').disabled = !writable();
    const presentations = data.media.filter(item => item.type === presentationType);
    const key = JSON.stringify([data.role, presentations]);
    if (listKey !== key) {
      listKey = key;
      const list = byId('presentation-list');
      list.replaceChildren(...presentations.map(item => {
        const row = document.createElement('div');
        row.className = 'design-row';
        const title = document.createElement('strong');
        title.textContent = item.name;
        const count = document.createElement('span');
        count.textContent = `${item.slides.length} ${item.slides.length === 1 ? 'slide' : 'slides'}`;
        const controls = document.createElement('div');
        controls.className = 'actions';
        controls.append(makeButton(writable() ? 'Edit' : 'Preview', () => open(item)));
        if (writable()) controls.append(makeButton('Schedule', () => schedule(item)));
        row.append(title, count, controls);
        return row;
      }));
      if (!presentations.length) list.textContent = 'Create a presentation or start with the demo template.';
    }
    const select = byId('proof-kiosk');
    const selected = select.value;
    const options = JSON.stringify(data.kiosks.map(({ id, label }) => [id, label]));
    if (select.dataset.devices !== options) {
      select.dataset.devices = options;
      select.replaceChildren(new Option('All kiosks', ''), ...data.kiosks.map(item => new Option(item.label, item.id)));
      if ([...select.options].some(option => option.value === selected)) select.value = selected;
    }
  }

  async function refreshProof() {
    if (reading || byId('playback').hidden) return;
    reading = true;
    try {
      const id = byId('proof-kiosk').value;
      const { entries } = await request('/api/playback' + (id ? '?kiosk=' + encodeURIComponent(id) : ''));
      if (id !== byId('proof-kiosk').value) return;
      lastRows = entries.map(row => [
        dates.format(row.time),
        fleet?.kiosks.find(device => device.id === row.kiosk)?.label ?? row.kiosk,
        row.name,
        { played: 'Played', error: 'Playback error', 'check-in': 'Check-in triggered' }[row.state],
        row.schedule ?? 'Default playlist',
      ]);
      byId('proof-rows').replaceChildren(...lastRows.map(cells => {
        const tr = document.createElement('tr');
        for (const cell of cells) tr.insertCell().textContent = cell;
        return tr;
      }));
      byId('proof-empty').hidden = !!lastRows.length;
      byId('proof-empty').textContent = 'No playback records for this selection yet.';
      byId('export-playback').disabled = !lastRows.length;
    } catch (error) {
      byId('proof-empty').hidden = false;
      byId('proof-empty').textContent = error.message;
    } finally {
      reading = false;
    }
  }

  function csvCell(value) {
    const raw = String(value);
    const safe = /^[\s]*[=@+\-]/.test(raw) ? "'" + raw : raw;
    return '"' + safe.replaceAll('"', '""') + '"';
  }
  byId('export-playback').onclick = () => {
    const records = [['Time', 'Kiosk', 'Content or event', 'Result', 'Schedule'], ...lastRows];
    const file = new Blob([records.map(row => row.map(csvCell).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(file);
    const download = document.createElement('a');
    download.href = url;
    download.download = 'signage-playback.csv';
    download.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  byId('proof-kiosk').onchange = refreshProof;

  async function checkSetup() {
    if (setupBusy) return;
    setupBusy = true;
    byId('check-deployment').disabled = true;
    try {
      const [info, health] = await Promise.all([request('/api/deployment'), request('/readyz')]);
      const gib = bytes => Number.isFinite(bytes) ? (bytes / 1024 ** 3).toFixed(1) + ' GB' : 'Unavailable';
      const rows = [
        ['Kiosk server URL', info.kioskUrl ?? location.origin],
        ['Server profile', info.mode === 'production' ? 'Production HTTPS' : 'Demo'],
        ['Runtime', `Node ${info.node} · ${info.platform}/${info.architecture}`],
        ['Resources', `${info.cores} CPU threads · ${gib(info.memory)} RAM`],
        ['Storage', `${info.storage} · ${gib(info.diskFree)} free`],
        ['Application listener', `TCP ${info.port}`],
      ];
      byId('deployment-checks').replaceChildren(...rows.flatMap(([label, value]) => {
        const term = document.createElement('dt');
        const result = document.createElement('dd');
        term.textContent = label;
        result.textContent = value;
        return [term, result];
      }));
      say('deployment-status', health.status === 'ready' ? 'Server and database are ready.' : 'Server is not ready.');
    } catch (error) {
      say('deployment-status', error.message, true);
    } finally {
      setupBusy = false;
      byId('check-deployment').disabled = false;
    }
  }
  byId('check-deployment').onclick = checkSetup;

  return { render, show, refreshProof, checkSetup };
}
