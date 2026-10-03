import {
  api,
  checkHealth,
  decodeJwt,
  pretty,
  renderDiagramsFromReadme,
  renderTimeline,
  session,
  showcaseConfig,
  statusPill,
} from '/assets/showcase.js';

const $ = (sel) => document.querySelector(sel);
const config = await showcaseConfig();
checkHealth($('#health'));
renderDiagramsFromReadme($('#diagrams'))
  .then(() => $('#diagrams > .pill')?.remove())
  .catch((e) => { $('#diagrams').innerHTML = `<span class="pill err">Không vẽ được sơ đồ: ${e.message}</span>`; });

function show(el, result, note = '') {
  el.innerHTML = `<p>${statusPill(result.status)} ${note}</p><pre>${pretty(result.data)}</pre>`;
}

// ---------- 1. Login ----------
let currentUser = null;
let expiryTimer;
function renderSession(el, data) {
  const payload = decodeJwt(data.accessToken);
  clearInterval(expiryTimer);
  const tick = () => {
    const left = Math.max(0, payload.exp - Math.floor(Date.now() / 1000));
    const ttl = $('#ttl');
    if (ttl) ttl.textContent = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
  };
  el.innerHTML = `
    <p>${statusPill(200)} Đăng nhập: <b>${data.user.fullName}</b> <span class="pill">${data.user.role}</span>
       — access token hết hạn sau <b id="ttl"></b></p>
    <table>
      <tr><th>Access token (rút gọn)</th><td><code>${data.accessToken.slice(0, 48)}…</code></td></tr>
      <tr><th>Nội dung JWT (payload)</th><td><code>${JSON.stringify(payload)}</code></td></tr>
      <tr><th>Refresh token</th><td>Trong cookie <code>httpOnly</code>; <code>document.cookie</code> = <code>${JSON.stringify(document.cookie)}</code> (trống, đúng như mong muốn)</td></tr>
    </table>`;
  tick();
  expiryTimer = setInterval(tick, 1000);
}

async function login(email, password = config.seedPassword) {
  const r = await api('POST', '/auth/login', { body: { email, password }, auth: false });
  if (r.ok) {
    session.token = r.data.accessToken;
    currentUser = r.data.user;
    renderSession($('#login-out'), r.data);
  } else {
    show($('#login-out'), r, 'Hai trường hợp sai trả về <b>giống hệt nhau</b>, nên kẻ tấn công không biết email nào có tồn tại.');
  }
  updateOrganizerButtons();
}
document.querySelectorAll('[data-login]').forEach((b) =>
  b.addEventListener('click', () => login(b.dataset.login)));
$('#login-wrong').addEventListener('click', () => login('customer0001@questa.test', 'wrong-password'));
$('#login-unknown').addEventListener('click', () => login('nobody@questa.test', 'wrong-password'));

// ---------- 2. Refresh ----------
$('#refresh').addEventListener('click', async () => {
  const before = session.token;
  const r = await api('POST', '/auth/refresh', { auth: false });
  if (r.ok) {
    session.token = r.data.accessToken;
    $('#refresh-out').innerHTML = `<p>${statusPill(200)} Có access token mới, và cookie refresh cũng đã được thay bằng cookie mới.</p>
      <table><tr><th>Token trước</th><td><code>${before ? `${before.slice(-24)}` : '(chưa có)'}</code></td></tr>
      <tr><th>Token sau</th><td><code>${r.data.accessToken.slice(-24)}</code></td></tr></table>`;
  } else {
    show($('#refresh-out'), r, 'Chưa đăng nhập, hoặc refresh token đã bị thu hồi.');
  }
});
document.querySelectorAll('[data-scenario]').forEach((b) =>
  b.addEventListener('click', async () => {
    $('#refresh-out').innerHTML = '<span class="pill">Đang chạy kịch bản…</span>';
    const steps = await (await fetch(`/scenarios/phase-01/${b.dataset.scenario}`)).json();
    renderTimeline($('#refresh-out'), steps);
  }));
$('#logout').addEventListener('click', async () => {
  const r = await api('POST', '/auth/logout', { auth: false });
  session.token = null;
  currentUser = null;
  $('#login-out').innerHTML = '';
  $('#refresh-out').innerHTML = `<p>${statusPill(r.status)} Đã thu hồi refresh token và xóa cookie. Bấm "Refresh" bây giờ sẽ nhận 401.</p>`;
  updateOrganizerButtons();
});

// ---------- 3. Catalog and seat map ----------
const ZONE_COLORS = ['#7c3aed', '#2563eb', '#0891b2', '#16a34a', '#d97706', '#db2777'];
$('#load-concerts').addEventListener('click', async () => {
  const r = await api('GET', '/concerts?pageSize=50', { auth: false });
  const select = $('#performance-select');
  select.innerHTML = r.data.items
    .flatMap((c) => c.performances.map((p) =>
      `<option value="${p.id}">${c.name} — ${new Date(p.startsAt).toLocaleDateString('vi-VN')} — ${p.venue}</option>`))
    .join('');
  select.disabled = false;
  $('#load-seats').disabled = false;
});
$('#load-seats').addEventListener('click', () => drawSeatMap($('#performance-select').value));

async function drawSeatMap(id) {
  const r = await api('GET', `/performances/${id}/seats`, { auth: false });
  if (!r.ok) return show($('#seat-summary'), r);
  const { zones, seats } = r.data;
  const size = JSON.stringify(r.data).length;
  $('#seat-summary').innerHTML = `<p>${statusPill(200)} ${seats.length.toLocaleString('vi-VN')} ghế, phản hồi
    ${(size / 1024 / 1024).toFixed(2)} MB trong ${r.ms} ms.</p>
    <table><tr><th>Khu</th><th>Loại</th><th>Giá</th><th>Sức chứa</th><th>Còn trống</th></tr>
    ${zones.map((z) => `<tr><td>${z.name}</td><td>${z.type}</td><td>${z.price.toLocaleString('vi-VN')} đ</td><td>${z.capacity.toLocaleString('vi-VN')}</td><td>${z.available.toLocaleString('vi-VN')}</td></tr>`).join('')}</table>`;
  $('#seat-legend').innerHTML = zones
    .map((z, i) => `<span style="--c:${ZONE_COLORS[i % ZONE_COLORS.length]}">${z.name}</span>`)
    .join('') + '<span style="--c:#f59e0b">Đang giữ (HELD)</span><span style="--c:#9ca3af">Đã bán (SOLD)</span>';

  const canvas = $('#seat-canvas');
  const ctx = canvas.getContext('2d');
  const width = canvas.width;
  const blocks = zones.map((zone, i) => {
    const own = seats.filter((s) => s.zoneId === zone.id);
    const rows = [...new Set(own.map((s) => s.row))];
    const cols = Math.max(0, ...own.map((s) => s.number));
    return { zone, color: ZONE_COLORS[i % ZONE_COLORS.length], own, rows, cols };
  });
  const maxCols = Math.max(1, ...blocks.map((b) => b.cols));
  const cell = Math.max(3, Math.min(14, Math.floor((width - 40) / maxCols)));
  let height = 10;
  for (const b of blocks) height += 24 + (b.zone.type === 'SEATED' ? b.rows.length * cell : 60) + 12;
  canvas.height = height;
  ctx.clearRect(0, 0, width, height);
  ctx.font = '13px Segoe UI, sans-serif';
  let y = 10;
  for (const b of blocks) {
    ctx.fillStyle = '#1c2333';
    ctx.fillText(`${b.zone.name} (${b.zone.type === 'SEATED' ? `${b.rows.length} hàng × ${b.cols} ghế` : 'khu đứng'})`, 20, y + 14);
    y += 24;
    if (b.zone.type === 'SEATED') {
      const rowIndex = new Map(b.rows.map((r, i) => [r, i]));
      const x0 = (width - b.cols * cell) / 2;
      for (const s of b.own) {
        ctx.fillStyle = s.status === 'AVAILABLE' ? b.color : s.status === 'HELD' ? '#f59e0b' : '#9ca3af';
        ctx.fillRect(x0 + (s.number - 1) * cell, y + rowIndex.get(s.row) * cell, cell - 1, cell - 1);
      }
      y += b.rows.length * cell + 12;
    } else {
      ctx.fillStyle = b.color;
      ctx.globalAlpha = 0.18;
      ctx.fillRect(40, y, width - 80, 60);
      ctx.globalAlpha = 1;
      ctx.fillStyle = '#1c2333';
      ctx.fillText(`Còn ${b.zone.available.toLocaleString('vi-VN')} / ${b.zone.capacity.toLocaleString('vi-VN')} vé đứng`, width / 2 - 80, y + 35);
      y += 72;
    }
  }
}

// ---------- 4. Organizer flow ----------
const DAY = 86_400_000;
const startsAt = new Date(Date.now() + 45 * DAY);
$('#performance-body').value = JSON.stringify({
  venue: 'Nhà hát Demo',
  startsAt: startsAt.toISOString(),
  maxTicketsPerUser: 4,
  zones: [
    { name: 'VIP', type: 'SEATED', price: 2500000, rows: 4, seatsPerRow: 12 },
    { name: 'Thường', type: 'SEATED', price: 900000, rows: 30, seatsPerRow: 20 },
    { name: 'Khu đứng', type: 'STANDING', price: 500000, capacity: 300 },
  ],
  salePhases: [
    { type: 'PRESALE', startsAt: new Date(Date.now() + DAY).toISOString(), endsAt: new Date(Date.now() + 3 * DAY).toISOString() },
    { type: 'GENERAL', startsAt: new Date(Date.now() + 3 * DAY).toISOString(), endsAt: new Date(startsAt.getTime() - DAY).toISOString() },
  ],
}, null, 2);

let concertId = null;
let performanceId = null;
function updateOrganizerButtons() {
  const isOrganizer = currentUser?.role === 'ORGANIZER';
  $('#create-concert').disabled = !isOrganizer;
  $('#create-performance').disabled = !isOrganizer || !concertId;
  $('#publish').disabled = !isOrganizer || !performanceId;
  $('#publish-again').disabled = !isOrganizer || !performanceId;
  $('#anon-view').disabled = !performanceId;
  $('#anon-view-2').disabled = !performanceId;
}
updateOrganizerButtons();

$('#create-concert').addEventListener('click', async () => {
  const r = await api('POST', '/concerts', { body: { name: `Concert demo ${new Date().toLocaleTimeString('vi-VN')}`, artist: 'Nghệ sĩ Demo' } });
  if (r.ok) concertId = r.data.id;
  show($('#organizer-out'), r, r.ok ? 'Đã tạo concert. Concert chưa có đêm diễn nào được công bố, nên chưa hiện trong danh mục công khai.' : '');
  updateOrganizerButtons();
});
$('#create-performance').addEventListener('click', async () => {
  let body;
  try { body = JSON.parse($('#performance-body').value); } catch { return alert('JSON không hợp lệ'); }
  const r = await api('POST', `/concerts/${concertId}/performances`, { body });
  if (r.ok) performanceId = r.data.id;
  show($('#organizer-out'), r, r.ok
    ? `Đã tạo đêm diễn ở trạng thái <b>${r.data.status}</b>: ${r.data.zones.length} khu, đợt mở bán và toàn bộ ghế được ghi trong <b>một transaction</b>.`
    : 'Sửa body rồi thử lại. Mọi lỗi được trả về cùng lúc.');
  updateOrganizerButtons();
});
$('#anon-view').addEventListener('click', async () => {
  const r = await api('GET', `/performances/${performanceId}`, { auth: false });
  show($('#organizer-out'), r, r.status === 404 ? 'Khách nhận <b>404</b>: với người ngoài, một bản nháp coi như không tồn tại.' : '');
});
$('#publish').addEventListener('click', async () => {
  const r = await api('POST', `/performances/${performanceId}/publish`);
  show($('#organizer-out'), r, r.ok ? 'DRAFT chuyển sang <b>PUBLISHED</b> bằng một câu <code>UPDATE ... WHERE status = \'DRAFT\'</code>.' : '');
});
$('#anon-view-2').addEventListener('click', async () => {
  const r = await api('GET', `/performances/${performanceId}`, { auth: false });
  show($('#organizer-out'), r, r.ok ? 'Bây giờ ai cũng thấy. Bấm "Tải danh sách concert" ở bước 3 để vẽ sơ đồ ghế của nó.' : '');
});
$('#publish-again').addEventListener('click', async () => {
  const r = await api('POST', `/performances/${performanceId}/publish`);
  show($('#organizer-out'), r, 'Câu UPDATE không khớp dòng nào vì trạng thái không còn là DRAFT, nên API trả <b>409 INVALID_STATE</b>.');
});

// ---------- 5. Error format ----------
const errorCases = {
  validation: () => api('POST', '/auth/register', { body: { email: 'khong-phai-email', password: '123', fullName: '' }, auth: false }),
  'extra-field': () => api('POST', '/auth/register', { body: { email: 'hacker@test.vn', password: 'long-enough-pw', fullName: 'H', role: 'ORGANIZER' }, auth: false }),
  'no-token': () => api('GET', '/users/me', { auth: false }),
  forbidden: async () => {
    const r = await api('POST', '/auth/login', { body: { email: 'customer0002@questa.test', password: config.seedPassword }, auth: false });
    return api('POST', '/concerts', { body: { name: 'X', artist: 'Y' }, auth: false, headers: { authorization: `Bearer ${r.data.accessToken}` } });
  },
  'not-found': () => api('GET', '/performances/00000000-0000-7000-8000-000000000000', { auth: false }),
  'bad-uuid': () => api('GET', '/performances/abc/seats', { auth: false }),
};
document.querySelectorAll('[data-error]').forEach((b) =>
  b.addEventListener('click', async () => show($('#error-out'), await errorCases[b.dataset.error]())));
