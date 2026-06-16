const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

const root = __dirname;
const dataDir = path.join(root, 'data');
const publicFiles = new Set(['.html', '.css', '.js', '.json', '.png', '.jpg', '.jpeg', '.gif', '.mp3', '.tmod', '.zip', '.svg', '.ico', '.ttf', '.woff', '.woff2']);
const sessions = new Map();

const config = {
  port: Number(process.env.PORT || 3000),
  baseUrl: process.env.BASE_URL || 'http://localhost:3000',
  githubOwner: process.env.GITHUB_OWNER || '',
  githubRepo: process.env.GITHUB_REPO || '',
  githubBranch: process.env.GITHUB_BRANCH || 'main',
  adminPassword: process.env.ADMIN_PASSWORD || 'admin123'
};

const mime = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.mp3': 'audio/mpeg',
  '.tmod': 'application/octet-stream',
  '.zip': 'application/zip',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.ttf': 'font/ttf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2'
};

function ensureData() {
  fs.mkdirSync(dataDir, { recursive: true });
  const defaults = {
    'stats.json': {},
    'uploads.json': []
  };
  for (const [name, value] of Object.entries(defaults)) {
    const file = path.join(dataDir, name);
    if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify(value, null, 2));
  }
}

function readJson(name, fallback = {}) {
  ensureData();
  try {
    return JSON.parse(fs.readFileSync(path.join(dataDir, name), 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(name, data) {
  ensureData();
  fs.writeFileSync(path.join(dataDir, name), JSON.stringify(data, null, 2));
}

function send(res, status, data, headers = {}) {
  const body = typeof data === 'string' ? data : JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': typeof data === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    ...headers
  });
  res.end(body);
}

function parseCookies(req) {
  return Object.fromEntries((req.headers.cookie || '').split(';').filter(Boolean).map((item) => {
    const [key, ...value] = item.trim().split('=');
    return [key, decodeURIComponent(value.join('='))];
  }));
}

function currentUser(req) {
  const sid = parseCookies(req).moling_sid;
  return sid ? sessions.get(sid) : null;
}

function requireAdmin(req, res) {
  const user = currentUser(req);
  if (!user) {
    send(res, 401, { error: '请先输入管理员密码并保存 GitHub Token' });
    return null;
  }
  return user;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 40 * 1024 * 1024) reject(new Error('请求体过大'));
    });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (error) {
        reject(error);
      }
    });
  });
}

async function githubFetch(url, token, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'moling-pixel-site',
      Authorization: `Bearer ${token}`,
      ...(options.headers || {})
    }
  });
  if (!res.ok) throw new Error(`GitHub API ${res.status}`);
  return res.json();
}

async function putGithubFile(filePath, content, message, token, alreadyBase64 = false) {
  if (!config.githubOwner || !config.githubRepo) {
    throw new Error('缺少 GITHUB_OWNER / GITHUB_REPO');
  }
  if (!token) throw new Error('缺少 GitHub Personal Token');
  const api = `https://api.github.com/repos/${config.githubOwner}/${config.githubRepo}/contents/${encodeURIComponent(filePath).replace(/%2F/g, '/')}`;
  let sha;
  try {
    const oldFile = await githubFetch(`${api}?ref=${config.githubBranch}`, token);
    sha = oldFile.sha;
  } catch {}
  return githubFetch(api, token, {
    method: 'PUT',
    body: JSON.stringify({
      message,
      branch: config.githubBranch,
      content: alreadyBase64 ? content : Buffer.from(content).toString('base64'),
      sha
    })
  });
}

async function uploadGithubFiles(files, prefix, message, token) {
  const uploaded = [];
  for (const file of files || []) {
    if (!file.name || !file.content) continue;
    const safeName = file.name.replace(/[\\/:*?"<>|]/g, '_');
    const filePath = `${prefix}/${safeName}`;
    await putGithubFile(filePath, file.content, `${message}: ${safeName}`, token, true);
    uploaded.push(filePath);
  }
  return uploaded;
}

async function handleApi(req, res, url) {
  if (url.pathname === '/api/auth/login' && req.method === 'POST') {
    const body = await readBody(req);
    if (body.password !== config.adminPassword) return send(res, 403, { error: '管理员密码错误' });
    if (!String(body.token || '').startsWith('github_') && !String(body.token || '').startsWith('ghp_')) {
      return send(res, 400, { error: 'GitHub Token 格式不正确' });
    }
    const sid = crypto.randomBytes(24).toString('hex');
    sessions.set(sid, { login: 'admin', token: body.token, time: Date.now() });
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Set-Cookie': `moling_sid=${encodeURIComponent(sid)}; HttpOnly; Path=/; SameSite=Lax`
    });
    res.end(JSON.stringify({ ok: true, user: { login: 'admin' } }));
    return;
  }

  if (url.pathname === '/api/auth/logout') {
    const sid = parseCookies(req).moling_sid;
    if (sid) sessions.delete(sid);
    res.writeHead(200, { 'Set-Cookie': 'moling_sid=; Max-Age=0; Path=/' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (url.pathname === '/api/me') {
    const user = currentUser(req);
    return send(res, 200, { user: user ? { login: user.login } : null });
  }

  if (url.pathname === '/api/data') {
    return send(res, 200, { stats: readJson('stats.json'), uploads: readJson('uploads.json', []) });
  }

  if (url.pathname === '/api/download' && req.method === 'POST') {
    const body = await readBody(req);
    const stats = readJson('stats.json');
    stats[body.id] = (stats[body.id] || 0) + 1;
    writeJson('stats.json', stats);
    const user = currentUser(req);
    if (user?.token) await putGithubFile('data/stats.json', JSON.stringify(stats, null, 2), `stats: ${body.id}`, user.token).catch(() => null);
    return send(res, 200, { ok: true, stats });
  }

  if (url.pathname === '/api/admin/upload' && req.method === 'POST') {
    const user = requireAdmin(req, res);
    if (!user) return;
    const body = await readBody(req);
    const uploads = readJson('uploads.json', []);
    const basePrefix = body.type === 'mod' ? 'mods' : 'tools';
    const uploadedFiles = await uploadGithubFiles(body.files, basePrefix, `upload ${body.type}`, user.token);
    const record = { ...body, files: undefined, uploadedFiles, uploader: user.login, time: new Date().toISOString(), id: `${body.type}-${Date.now()}` };
    uploads.push(record);
    writeJson('uploads.json', uploads);
    await putGithubFile('data/uploads.json', JSON.stringify(uploads, null, 2), `upload: ${record.name}`, user.token);
    return send(res, 200, { ok: true, record });
  }

  send(res, 404, { error: 'API 不存在' });
}

function serveStatic(req, res, url) {
  const filePath = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname);
  const normalized = path.normalize(filePath).replace(/^([/\\])+/, '');
  const fullPath = path.join(root, normalized);
  if (!fullPath.startsWith(root)) return send(res, 403, 'Forbidden');
  const ext = path.extname(fullPath).toLowerCase();
  if (!publicFiles.has(ext) || !fs.existsSync(fullPath)) return send(res, 404, 'Not Found');
  res.writeHead(200, { 'Content-Type': mime[ext] || 'application/octet-stream' });
  fs.createReadStream(fullPath).pipe(res);
}

ensureData();
http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, config.baseUrl);
    if (url.pathname.startsWith('/api/')) await handleApi(req, res, url);
    else serveStatic(req, res, url);
  } catch (error) {
    send(res, 500, { error: error.message });
  }
}).listen(config.port, () => {
  console.log(`Moling site running at ${config.baseUrl}`);
});
