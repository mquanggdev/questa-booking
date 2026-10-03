// Shared helpers for every phase demo page.

const logList = () => document.querySelector('#log-list');

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

export function pretty(value) {
  return escapeHtml(JSON.stringify(value, null, 2));
}

/** Appends one request to the "Nhật ký request" panel. */
function logRequest({ method, path, status, ms, body, response }) {
  const list = logList();
  if (!list) return;
  const li = document.createElement('li');
  li.innerHTML = `<span class="s${String(status)[0]}">${status}</span> ${method} ${escapeHtml(path)} <span style="color:#8a93a6">${ms} ms</span>
    <pre>${body ? `// request\n${pretty(body)}\n\n` : ''}// response\n${pretty(response)}</pre>`;
  li.addEventListener('click', () => li.classList.toggle('open'));
  list.prepend(li);
}

let accessToken = null;
export const session = {
  get token() { return accessToken; },
  set token(value) { accessToken = value; document.dispatchEvent(new CustomEvent('session')); },
};

/** Calls the API through the showcase proxy and logs it. Never throws on HTTP errors. */
export async function api(method, path, { body, auth = true, headers = {} } = {}) {
  const started = performance.now();
  const res = await fetch(`/api/v1${path}`, {
    method,
    credentials: 'same-origin',
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(auth && accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  const ms = Math.round(performance.now() - started);
  const shown = typeof data === 'object' && data && JSON.stringify(data).length > 4000
    ? { note: `(phản hồi ${JSON.stringify(data).length.toLocaleString('vi-VN')} ký tự, đã rút gọn)` }
    : data;
  logRequest({ method, path: `/api/v1${path}`, status: res.status, ms, body, response: shown });
  return { status: res.status, ok: res.ok, data, ms };
}

export function decodeJwt(token) {
  const [, payload] = token.split('.');
  return JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')));
}

export function statusPill(status) {
  const cls = status < 300 ? 'ok' : status < 500 ? 'err' : 'warn';
  return `<span class="pill ${cls}">${status}</span>`;
}

/** Renders a server-side scenario (list of steps) as a timeline. */
export function renderTimeline(el, steps) {
  el.innerHTML = `<ol class="timeline">${steps
    .map((s) => `<li class="${s.ok ? 'ok' : 'err'}">
      <div class="t">${escapeHtml(s.title)} ${s.status ? statusPill(s.status) : ''}</div>
      <div class="m">${escapeHtml(s.note ?? '')}</div>
      ${s.response ? `<pre>${pretty(s.response)}</pre>` : ''}
    </li>`)
    .join('')}</ol>`;
}

/**
 * Diagrams have one source of truth: the phase README.md. Every "### title"
 * followed by a ```mermaid block becomes a rendered diagram here.
 */
export async function renderDiagramsFromReadme(container, readmeUrl = './README.md') {
  const { default: mermaid } = await import('https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs');
  mermaid.initialize({ startOnLoad: false, theme: 'neutral', securityLevel: 'strict' });
  const markdown = await (await fetch(readmeUrl)).text();
  const pattern = /###\s+(.+)\n+((?:(?!```)[^\n]*\n)*?)```mermaid\n([\s\S]*?)```/g;
  let index = 0;
  for (const [, title, desc, code] of markdown.matchAll(pattern)) {
    const box = document.createElement('div');
    box.className = 'diagram';
    box.innerHTML = `<h3>${escapeHtml(title.trim())}</h3>${desc.trim() ? `<p class="desc">${escapeHtml(desc.trim())}</p>` : ''}`;
    const { svg } = await mermaid.render(`diagram-${index++}`, code);
    box.insertAdjacentHTML('beforeend', svg);
    container.append(box);
  }
}

export async function checkHealth(el) {
  try {
    const res = await fetch('/api/v1/health/ready');
    const data = await res.json();
    el.innerHTML = res.ok
      ? '<span class="pill ok">API đang chạy: database và Redis đều up</span>'
      : `<span class="pill err">API chưa sẵn sàng: ${escapeHtml(JSON.stringify(data.details ?? data))}</span>`;
  } catch {
    el.innerHTML = '<span class="pill err">Không gọi được API. Hãy chạy: docker compose up -d</span>';
  }
}

export async function showcaseConfig() {
  return (await fetch('/showcase-config.json')).json();
}
