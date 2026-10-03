// Server-side scenarios for the phase 1 demo. A browser cannot replay an
// httpOnly cookie, so these flows run in the showcase server and return a
// timeline the page renders step by step.

function cookieFrom(res) {
  const raw = res.headers.getSetCookie().find((c) => c.startsWith('refresh_token='));
  return raw ? raw.split(';')[0] : null;
}

function short(cookie) {
  return cookie ? `${cookie.slice(0, 26)}…` : '(không có)';
}

async function call(apiUrl, path, { method = 'POST', body, cookie } = {}) {
  const res = await fetch(`${apiUrl}/api/v1${path}`, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(cookie ? { cookie } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { res, status: res.status, data, cookie: cookieFrom(res) };
}

async function login(apiUrl, env) {
  return call(apiUrl, '/auth/login', {
    body: { email: 'customer0042@questa.test', password: env.SEED_PASSWORD ?? 'Questa@2026' },
  });
}

export const scenarios = {
  // Stolen refresh token: the thief replays an already rotated token.
  'refresh-reuse': async ({ apiUrl, env }) => {
    const steps = [];
    const l = await login(apiUrl, env);
    steps.push({
      title: '1. Người dùng đăng nhập',
      status: l.status,
      ok: l.status === 200,
      note: `Nhận refresh token R1 trong cookie: ${short(l.cookie)}. Giả sử kẻ trộm đã sao chép được R1.`,
    });
    if (l.status !== 200) return steps;

    const r1 = await call(apiUrl, '/auth/refresh', { cookie: l.cookie });
    steps.push({
      title: '2. Người dùng refresh bằng R1',
      status: r1.status,
      ok: r1.status === 200,
      note: `Thành công. R1 bị thu hồi, người dùng nhận R2: ${short(r1.cookie)}`,
    });

    const thief = await call(apiUrl, '/auth/refresh', { cookie: l.cookie });
    steps.push({
      title: '3. Kẻ trộm thử refresh bằng R1 (đã bị thu hồi)',
      status: thief.status,
      ok: false,
      note: 'API thấy một token đã thu hồi lại được dùng, nên thu hồi cả family (R1, R2 và các token sau).',
      response: thief.data,
    });

    const victim = await call(apiUrl, '/auth/refresh', { cookie: r1.cookie });
    steps.push({
      title: '4. Người dùng thật refresh bằng R2',
      status: victim.status,
      ok: false,
      note: 'R2 cũng đã bị thu hồi. Người dùng phải đăng nhập lại, còn kẻ trộm thì mất quyền truy cập hoàn toàn.',
      response: victim.data,
    });
    return steps;
  },

  // Two refreshes with the same token at the same instant: exactly one wins.
  'concurrent-refresh': async ({ apiUrl, env }) => {
    const l = await login(apiUrl, env);
    if (l.status !== 200) {
      return [{ title: 'Đăng nhập thất bại', status: l.status, ok: false, response: l.data }];
    }
    const [a, b] = await Promise.all([
      call(apiUrl, '/auth/refresh', { cookie: l.cookie }),
      call(apiUrl, '/auth/refresh', { cookie: l.cookie }),
    ]);
    const winners = [a, b].filter((r) => r.status === 200).length;
    return [
      { title: '1. Đăng nhập, nhận R1', status: l.status, ok: true, note: short(l.cookie) },
      { title: '2. Request A: refresh bằng R1 (gửi cùng lúc với B)', status: a.status, ok: a.status === 200, response: a.status === 200 ? { result: 'được cấp token mới' } : a.data },
      { title: '3. Request B: refresh bằng R1 (gửi cùng lúc với A)', status: b.status, ok: b.status === 200, response: b.status === 200 ? { result: 'được cấp token mới' } : b.data },
      {
        title: `Kết quả: ${winners} request thành công`,
        ok: winners === 1,
        note:
          'Câu UPDATE ... WHERE revoked_at IS NULL khóa dòng. Request đến sau thấy token đã bị thu hồi nên không khớp, và vì token bị dùng hai lần, cả family bị thu hồi (đánh đổi đã ghi trong ADR-0004). Đây chính là kỹ thuật sẽ dùng để chống bán trùng ghế ở giai đoạn 3.',
      },
    ];
  },
};
