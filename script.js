const page = document.body.dataset.page || 'home';
const pageSize = 6;
const presetTags = ['新增内容', '实用辅助', '模组类库', '体验优化', '游戏调整', '视效调整', '音效调整', '地图生成', '翻译'];

let sceneState = null;
let animationStarted = false;

const state = {
  user: null,
  stats: {},
  uploads: [],
  activeTag: '全部',
  currentPage: 1,
  selectedTags: [],
  pointer: null,
  lastPointer: null,
  githubToken: sessionStorage.getItem('moling_github_token') || ''
};

const githubConfig = {
  owner: 'bilimoing',
  repo: 'OnlineWeb',
  branch: 'main'
};

async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options
  });
  if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || `HTTP ${response.status}`);
  return response.json();
}

async function bootstrap() {
  await Promise.all([loadMe(), loadServerData()]);
  refreshAuth();
  bindEvents();
  drawWorld();
  renderPage();
  setupReveal();
  setTimeout(() => document.querySelector('#page-loader')?.classList.add('done'), 700);
}

async function loadMe() {
  try {
    state.user = (await api('/api/me')).user;
  } catch {
    state.user = null;
  }
}

async function loadServerData() {
  try {
    const data = await api('/api/data');
    state.stats = data.stats || {};
    state.uploads = Array.isArray(data.uploads) ? data.uploads : [];
  } catch {
    try {
      const [uploads, stats] = await Promise.all([
        fetch('data/uploads.json').then((res) => res.ok ? res.json() : []),
        fetch('data/stats.json').then((res) => res.ok ? res.json() : {})
      ]);
      state.uploads = Array.isArray(uploads) ? uploads : [];
      state.stats = stats || {};
    } catch {
      state.uploads = [];
      state.stats = {};
    }
  }
}

async function loginWithToken(form) {
  const data = Object.fromEntries(new FormData(form));
  try {
    await api('/api/auth/login', { method: 'POST', body: JSON.stringify(data) });
  } catch (error) {
    if (!/HTTP 404|HTTP 405/i.test(error.message)) throw error;
  }
  if (String(data.password || '') !== '123456') throw new Error('管理员密码错误');
  if (!String(data.token || '').trim()) throw new Error('请输入 GitHub Token');
  state.githubToken = String(data.token).trim();
  sessionStorage.setItem('moling_github_token', state.githubToken);
  await verifyGithubToken();
  const fallbackUser = { login: 'admin' };
  await loadMe();
  state.user = state.user || fallbackUser;
  refreshAuth();
  renderPage();
  const hint = document.querySelector('#login-hint');
  if (hint) hint.textContent = '登录成功，已开放上传同步。';
}

async function logout() {
  sessionStorage.removeItem('moling_github_token');
  await fetch('/api/auth/logout', { credentials: 'include' }).catch(() => null);
  location.reload();
}

function refreshAuth() {
  document.querySelectorAll('#login-button, .top-login').forEach((button) => {
    button.textContent = state.user ? '已登录 / 退出' : '登录';
    button.onclick = state.user ? (event) => { event.preventDefault(); logout(); } : (event) => {
      if (button.tagName === 'A') return;
      event.preventDefault();
      location.href = 'admin.html';
    };
  });
}

function uploadedItems(type) {
  return state.uploads
    .filter((item) => item.type === type)
    .map((item) => ({
      id: item.id,
      type: item.type,
      category: item.category || (item.type === 'mod' ? '泰拉瑞亚' : '工具'),
      name: item.name,
      version: item.version || '1.0.0',
      date: item.time || new Date().toISOString(),
      icon: item.icon || 'assets/web-icon.png',
      file: item.file || '#',
      source: item.source || '',
      checksum: item.checksum || '未填写',
      desc: item.desc || '暂无描述',
      tags: Array.isArray(item.tags) ? item.tags : [],
      screenshots: Array.isArray(item.screenshots) ? item.screenshots : [],
      changelog: Array.isArray(item.changelog) && item.changelog.length ? item.changelog : ['暂无更新日志'],
      versions: [item.version || '1.0.0']
    }));
}

function getDownloads(id) {
  return state.stats[id] || 0;
}

function allTags(items) {
  return ['全部', ...new Set(presetTags.concat(items.flatMap((item) => item.tags || [])))];
}

function filteredItems(items) {
  const keyword = (document.querySelector('#search-input')?.value || '').trim().toLowerCase();
  const sort = document.querySelector('#sort-select')?.value || 'new';
  return items.filter((item) => {
    const tags = item.tags || [];
    const text = `${item.name} ${item.desc} ${tags.join(' ')}`.toLowerCase();
    return (page !== 'mods' || state.activeTag === '全部' || tags.includes(state.activeTag)) && (!keyword || text.includes(keyword));
  }).sort((a, b) => sort === 'downloads' ? getDownloads(b.id) - getDownloads(a.id) : sort === 'name' ? a.name.localeCompare(b.name, 'zh-CN') : new Date(b.date) - new Date(a.date));
}

function renderFilters(items) {
  const tagFilter = document.querySelector('#tag-filter');
  if (!tagFilter || page !== 'mods') return;
  tagFilter.innerHTML = `<div class="filter-row"><strong>标签</strong>${allTags(items).map((tag) => `<button class="tag-button ${tag === state.activeTag ? 'active' : ''}" data-tag="${tag}" type="button">${tag}</button>`).join('')}</div>`;
}

function renderPagination(total) {
  const pagination = document.querySelector('#pagination');
  if (!pagination) return;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  state.currentPage = Math.min(state.currentPage, pageCount);
  pagination.innerHTML = Array.from({ length: pageCount }, (_, index) => `<button class="page-button ${state.currentPage === index + 1 ? 'active' : ''}" data-page-number="${index + 1}" type="button">${index + 1}</button>`).join('');
}

function cardTemplate(item) {
  const disabled = item.file === '#';
  const tags = page === 'mods' ? `<div class="tag-list">${(item.tags || []).map((tag) => `<span>${tag}</span>`).join('')}</div>` : '';
  const type = page === 'mods' ? `${item.category} · v${item.version}` : `自制工具 · v${item.version}`;
  return `<article class="pixel-card interactive-card" data-reveal>
    <img class="item-icon" src="${item.icon}" alt="${item.name} 图标" />
    <span class="item-type">${type}</span>
    <h2>${item.name}</h2>
    <p>${item.desc}</p>
    ${tags}
    <div class="meta-list"><span>下载 ${getDownloads(item.id)}</span><span>校验 ${item.checksum}</span></div>
    <div class="card-actions"><a class="pixel-button primary ${disabled ? 'disabled' : ''}" href="${item.file}" ${disabled ? '' : 'download'} data-download="${item.id}">下载</a><button class="pixel-button" type="button" data-detail="${item.id}">详情</button></div>
  </article>`;
}

function renderList(items, selector) {
  renderFilters(items);
  const target = document.querySelector(selector);
  if (!target) return;
  const filtered = filteredItems(items);
  const start = (state.currentPage - 1) * pageSize;
  const emptyText = page === 'mods' ? '暂无 Mod，请到后台上传后显示。' : '暂无工具，请到后台上传后显示。';
  target.innerHTML = filtered.slice(start, start + pageSize).map(cardTemplate).join('') || `<div class="empty panel">${emptyText}</div>`;
  renderPagination(filtered.length);
  setupReveal();
}

function openDetail(id) {
  const item = uploadedItems('mod').concat(uploadedItems('tool')).find((entry) => entry.id === id);
  const dialog = document.querySelector('#detail-dialog');
  if (!item || !dialog) return;
  const media = item.screenshots?.length ? item.screenshots.map((src) => `<img src="${src}" alt="${item.name} 截图" data-lightbox="${src}" />`).join('') : '<p>暂无截图。</p>';
  const sourceButton = state.user && item.source ? `<a class="pixel-button" href="${item.source}" download>下载源码</a>` : '';
  const tags = page === 'mods' ? `<div class="tag-list">${(item.tags || []).map((tag) => `<span>${tag}</span>`).join('')}</div>` : '';
  dialog.innerHTML = `<div class="dialog-panel"><div class="dialog-head"><div><span class="pixel-label">DETAIL</span><h2>${item.name}</h2></div><button class="pixel-button" type="button" data-close>关闭</button></div><p>${item.desc}</p>${tags}<div class="dialog-grid"><section><h3>更新日志</h3><ul>${item.changelog.map((log) => `<li>${log}</li>`).join('')}</ul></section><section><h3>版本历史</h3><ul>${item.versions.map((version) => `<li>v${version}</li>`).join('')}</ul></section></div><div class="dialog-grid"><section><h3>文件校验</h3><p>${item.checksum}</p></section><section><h3>下载统计</h3><p>${getDownloads(id)} 次</p></section></div><section><h3>预览图片</h3><div class="screenshot-grid">${media}</div></section><div class="card-actions"><a class="pixel-button primary ${item.file === '#' ? 'disabled' : ''}" href="${item.file}" ${item.file === '#' ? '' : 'download'} data-download="${item.id}">下载文件</a>${sourceButton}</div></div>`;
  dialog.showModal();
}

function openLightbox(src) {
  const box = document.createElement('div');
  box.className = 'lightbox';
  box.innerHTML = `<button class="pixel-button" type="button">关闭</button><img src="${src}" alt="预览图片" />`;
  box.onclick = () => box.remove();
  document.body.appendChild(box);
}

async function trackDownload(id) {
  await api('/api/download', { method: 'POST', body: JSON.stringify({ id }) }).catch(() => null);
  await loadServerData();
  renderPage();
}

function renderAdmin() {
  const total = Object.values(state.stats).reduce((sum, count) => sum + count, 0);
  const loggedIn = Boolean(state.user);
  document.querySelector('#auth-state').textContent = loggedIn ? '已登录' : '未登录';
  document.querySelector('#auth-desc').textContent = loggedIn ? 'Token 已保存到服务端会话，可上传并同步到 GitHub。' : '请输入管理员密码与 GitHub Token 后登录。';
  document.querySelector('#download-total').textContent = String(total);
  document.querySelector('#sync-total').textContent = String(state.uploads.length);
  document.querySelector('#sync-list').innerHTML = state.uploads.map((item) => `<article><strong>${item.type === 'mod' ? 'Mod' : '工具'}：${item.name}</strong><span>${new Date(item.time).toLocaleString('zh-CN')} · @${item.uploader}</span><p>v${item.version}</p><small>${item.checksum || '无校验'}</small></article>`).join('') || '<p>暂无上传记录。</p>';
  document.querySelector('.login-panel')?.classList.toggle('is-hidden', loggedIn);
  document.querySelector('#upload-panel')?.classList.toggle('is-hidden', !loggedIn);
  const hint = document.querySelector('#login-hint');
  if (hint) hint.textContent = loggedIn ? '已登录，可以上传并同步到 GitHub 仓库。' : '默认管理员密码为 123456，输入 GitHub Token 后登录。';
  syncUploadTabs();
  renderPresetTags();
}

function bindEvents() {
  document.addEventListener('click', async (event) => {
    burst(event.clientX, event.clientY);
    const detail = event.target.closest('[data-detail]');
    if (detail) openDetail(detail.dataset.detail);
    const close = event.target.closest('[data-close]');
    if (close) close.closest('dialog')?.close();
    const download = event.target.closest('[data-download]');
    if (download && !download.classList.contains('disabled')) trackDownload(download.dataset.download);
    const lightbox = event.target.closest('[data-lightbox]');
    if (lightbox) openLightbox(lightbox.dataset.lightbox);
    const tag = event.target.closest('[data-tag]');
    if (tag) { state.activeTag = tag.dataset.tag; state.currentPage = 1; renderPage(); }
    const preset = event.target.closest('[data-preset-tag]');
    if (preset) toggleSelectedTag(preset.dataset.presetTag);
    const pageButton = event.target.closest('[data-page-number]');
    if (pageButton) { state.currentPage = Number(pageButton.dataset.pageNumber); renderPage(); }
    if (event.target.closest('#add-tag-btn')) addManualTag();
  });
  document.addEventListener('submit', async (event) => {
    const loginForm = event.target.closest('#login-form');
    if (loginForm) { event.preventDefault(); await loginWithToken(loginForm); }
    const uploadForm = event.target.closest('#upload-form');
    if (uploadForm) { event.preventDefault(); await submitUpload(uploadForm); }
  });
  document.querySelector('#search-input')?.addEventListener('input', () => { state.currentPage = 1; renderPage(); });
  document.querySelector('#sort-select')?.addEventListener('change', () => { state.currentPage = 1; renderPage(); });

  const uploadForm = document.querySelector('#upload-form');
  if (uploadForm) {
    const syncPaths = () => syncUploadPaths(uploadForm);
    uploadForm.querySelector('[name="iconFile"]')?.addEventListener('change', syncPaths);
    uploadForm.querySelector('[name="mainFile"]')?.addEventListener('change', syncPaths);
    uploadForm.querySelector('[name="sourceFile"]')?.addEventListener('change', syncPaths);
  }
}

async function githubRequest(path, options = {}) {
  if (!state.githubToken) throw new Error('请先登录并输入 GitHub Token');
  const url = `https://api.github.com/repos/${githubConfig.owner}/${githubConfig.repo}/contents/${encodeURIComponent(path).replace(/%2F/g, '/')}?ref=${githubConfig.branch}`;
  const response = await fetch(url, {
    ...options,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${state.githubToken}`,
      ...(options.headers || {})
    }
  });
  if (!response.ok) throw new Error(`GitHub ${response.status}`);
  return response.json();
}

async function verifyGithubToken() {
  await githubRequest('data/uploads.json').catch((error) => {
    if (error.message === 'GitHub 404') return null;
    throw error;
  });
}

async function putGithubFile(path, content, message, alreadyBase64 = false) {
  let sha;
  try {
    sha = (await githubRequest(path)).sha;
  } catch (error) {
    if (error.message !== 'GitHub 404') throw error;
  }
  const url = `https://api.github.com/repos/${githubConfig.owner}/${githubConfig.repo}/contents/${encodeURIComponent(path).replace(/%2F/g, '/')}`;
  const response = await fetch(url, {
    method: 'PUT',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${state.githubToken}`
    },
    body: JSON.stringify({
      message,
      branch: githubConfig.branch,
      content: alreadyBase64 ? content : btoa(unescape(encodeURIComponent(content))),
      sha
    })
  });
  if (!response.ok) throw new Error(`GitHub PUT ${response.status}`);
  return response.json();
}

async function uploadDirectToGithub(data) {
  const files = Array.isArray(data.files) ? data.files : [];
  const uploadedFiles = [];
  for (const file of files) {
    if (!file.name || !file.content) continue;
    const prefix = data.type === 'mod' ? 'mods' : 'tools';
    const safeName = file.name.replace(/[\\/:*?"<>|]/g, '_');
    const filePath = `${prefix}/${safeName}`;
    await putGithubFile(filePath, file.content, `upload ${data.type}: ${safeName}`, true);
    uploadedFiles.push(filePath);
  }
  let uploads = [];
  try {
    const oldData = await githubRequest('data/uploads.json');
    uploads = JSON.parse(decodeURIComponent(escape(atob(oldData.content.replace(/\s/g, '')))));
    if (!Array.isArray(uploads)) uploads = [];
  } catch (error) {
    if (error.message !== 'GitHub 404') throw error;
  }
  const record = {
    ...data,
    files: undefined,
    uploadedFiles,
    uploader: 'admin',
    time: new Date().toISOString(),
    id: `${data.type}-${Date.now()}`
  };
  uploads.push(record);
  await putGithubFile('data/uploads.json', JSON.stringify(uploads, null, 2), `upload: ${record.name}`);
  state.uploads = uploads;
  return record;
}

async function uploadWithFallback(data) {
  try {
    await api('/api/admin/upload', { method: 'POST', body: JSON.stringify(data) });
  } catch (error) {
    if (!/HTTP 404|HTTP 405/i.test(error.message)) throw error;
    await uploadDirectToGithub(data);
  }
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function collectUploadFiles(form) {
  const files = [];
  for (const field of ['iconFile', 'mainFile', 'sourceFile']) {
    const file = form.elements[field]?.files?.[0];
    if (file) files.push({ role: field, name: file.name, type: file.type, content: await fileToBase64(file) });
  }
  for (const file of Array.from(form.elements.screenshotFiles?.files || [])) {
    files.push({ role: 'screenshot', name: file.name, type: file.type, content: await fileToBase64(file) });
  }
  return files;
}

async function submitUpload(form) {
  if (!state.user) {
    const hint = document.querySelector('#login-hint');
    if (hint) hint.textContent = '请先登录后再上传。';
    return alert('请先登录后台');
  }
  const formData = new FormData(form);
  const raw = Object.fromEntries(formData);
  delete raw.iconFile;
  delete raw.mainFile;
  delete raw.sourceFile;
  delete raw.screenshotFiles;
  const files = await collectUploadFiles(form);
  const iconUpload = files.find((file) => file.role === 'iconFile');
  const mainUpload = files.find((file) => file.role === 'mainFile');
  const sourceUpload = files.find((file) => file.role === 'sourceFile');
  const screenshotUploads = files.filter((file) => file.role === 'screenshot');
  const prefix = raw.type === 'mod' ? 'mods' : 'tools';
  const data = {
    ...raw,
    tags: raw.type === 'mod' ? state.selectedTags : [],
    icon: iconUpload ? `${prefix}/${iconUpload.name}` : raw.icon,
    file: mainUpload ? `${prefix}/${mainUpload.name}` : raw.file,
    source: raw.type === 'mod' && sourceUpload ? `${prefix}/${sourceUpload.name}` : raw.source,
    screenshots: raw.type === 'mod' ? screenshotUploads.map((file) => `${prefix}/${file.name}`) : [],
    changelog: String(raw.changelog || '').split('\n').map((item) => item.trim()).filter(Boolean),
    files
  };
  await uploadWithFallback(data);
  form.reset();
  state.selectedTags = [];
  form.querySelector('[name="type"]').value = 'mod';
  form.querySelector('[name="category"]').value = '泰拉瑞亚';
  await loadServerData();
  renderAdmin();
  alert('已上传并同步到 GitHub 仓库');
}

function syncUploadTabs() {
  const typeInput = document.querySelector('#upload-form [name="type"]');
  const tabs = document.querySelectorAll('[data-upload-type]');
  const uploadForm = document.querySelector('#upload-form');
  if (!typeInput || !tabs.length || !uploadForm) return;
  const locked = !state.user;
  uploadForm.querySelectorAll('input, textarea, button, select').forEach((field) => {
    if (field.id === 'add-tag-btn' || field.closest('#preset-tags') || field.closest('#selected-tags')) return;
    if (field.tagName === 'BUTTON' && field.dataset.uploadType) return;
    field.disabled = locked;
  });
  tabs.forEach((tab) => {
    tab.classList.toggle('active', tab.dataset.uploadType === typeInput.value);
    tab.disabled = locked;
    tab.onclick = () => {
      if (locked) return;
      typeInput.value = tab.dataset.uploadType;
      const category = document.querySelector('#upload-form [name="category"]');
      if (category) category.value = tab.dataset.uploadType === 'mod' ? '泰拉瑞亚' : '工具';
      document.querySelectorAll('.mod-only').forEach((element) => element.classList.toggle('is-hidden', tab.dataset.uploadType !== 'mod'));
      tabs.forEach((item) => item.classList.toggle('active', item === tab));
      syncUploadPaths(uploadForm);
    };
  });
}

function renderPresetTags() {
  const presetBox = document.querySelector('#preset-tags');
  const selectedBox = document.querySelector('#selected-tags');
  if (!presetBox || !selectedBox) return;
  presetBox.innerHTML = presetTags.map((tag) => `<button class="tag-button ${state.selectedTags.includes(tag) ? 'active' : ''}" type="button" data-preset-tag="${tag}">${tag}</button>`).join('');
  selectedBox.innerHTML = state.selectedTags.map((tag) => `<span>${tag}<button type="button" data-preset-tag="${tag}">×</button></span>`).join('') || '<small>未选择标签</small>';
}

function toggleSelectedTag(tag) {
  state.selectedTags = state.selectedTags.includes(tag) ? state.selectedTags.filter((item) => item !== tag) : state.selectedTags.concat(tag);
  renderPresetTags();
}

function addManualTag() {
  const input = document.querySelector('#manual-tag');
  const tag = input?.value.trim();
  if (!tag) return;
  if (!state.selectedTags.includes(tag)) state.selectedTags.push(tag);
  input.value = '';
  renderPresetTags();
}

function syncUploadPaths(form) {
  if (!form) return;
  const prefix = form.querySelector('[name="type"]')?.value === 'tool' ? 'tools' : 'mods';
  const iconFile = form.querySelector('[name="iconFile"]')?.files?.[0];
  const mainFile = form.querySelector('[name="mainFile"]')?.files?.[0];
  const sourceFile = form.querySelector('[name="sourceFile"]')?.files?.[0];
  const iconInput = form.querySelector('[name="icon"]');
  const fileInput = form.querySelector('[name="file"]');
  const sourceInput = form.querySelector('[name="source"]');
  if (iconFile && iconInput) iconInput.value = `${prefix}/${iconFile.name}`;
  if (mainFile && fileInput) fileInput.value = `${prefix}/${mainFile.name}`;
  if (sourceFile && sourceInput) sourceInput.value = `${prefix}/${sourceFile.name}`;
}

function drawWorld() {
  if (animationStarted) return;
  animationStarted = true;
  const canvas = document.querySelector('#world-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  sceneState = createScene();

  function resize() {
    const ratio = Math.min(devicePixelRatio || 1, 2);
    canvas.width = Math.floor(innerWidth * ratio);
    canvas.height = Math.floor(innerHeight * ratio);
    canvas.style.width = `${innerWidth}px`;
    canvas.style.height = `${innerHeight}px`;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    sceneState.resize(innerWidth, innerHeight);
  }

  window.addEventListener('resize', resize);
  window.addEventListener('pointermove', (event) => {
    const point = { x: event.clientX, y: event.clientY };
    state.lastPointer = state.pointer;
    state.pointer = point;
    sceneState.pushWind(point.x, point.y, state.lastPointer);
    sceneState.spawnTrail(point.x, point.y);
  }, { passive: true });
  resize();

  function frame(now) {
    ctx.clearRect(0, 0, innerWidth, innerHeight);
    sceneState.tick(now, ctx);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

function burst(x, y) {
  if ((!x && !y) || !sceneState) return;
  sceneState.spawnBurst(x, y);
}

function createScene() {
  let width = innerWidth;
  let height = innerHeight;
  let seed = Math.floor(Math.random() * 1e9);
  const stars = [];
  const auroras = [];
  const clouds = [];
  const weather = [];
  const trails = [];
  const winds = [];
  const meteors = [];

  function rand() {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  }

  function resize(newWidth, newHeight) {
    width = newWidth;
    height = newHeight;
    stars.length = 0;
    auroras.length = 0;
    clouds.length = 0;
    weather.length = 0;
    const density = Math.max(80, Math.floor(width * height / 9000));
    for (let index = 0; index < density; index += 1) {
      stars.push({ x: rand() * width, y: rand() * height * 0.72, r: rand() * 1.6 + 0.35, twinkle: rand() * Math.PI * 2 });
    }
    for (let index = 0; index < 8; index += 1) {
      auroras.push({
        y: height * (0.12 + rand() * 0.32),
        amp: 34 + rand() * 78,
        width: width * (0.65 + rand() * 0.75),
        phase: rand() * Math.PI * 2,
        speed: 0.00035 + rand() * 0.00055,
        hue: rand() > 0.45 ? 162 : 194
      });
    }
    for (let index = 0; index < 7; index += 1) {
      clouds.push({ x: rand() * width, y: 50 + rand() * height * 0.28, scale: 0.7 + rand() * 1.5, speed: 0.006 + rand() * 0.016 });
    }
    for (let index = 0; index < 120; index += 1) {
      weather.push({ x: rand() * width, y: rand() * height, speed: 0.35 + rand() * 1.2, drift: (rand() - 0.5) * 0.6, size: 1 + rand() * 2.6 });
    }
  }

  function pushWind(x, y, lastPoint) {
    const strength = lastPoint ? Math.min(70, Math.hypot(x - lastPoint.x, y - lastPoint.y)) : 22;
    winds.push({ x, y, strength, life: 1 });
    if (winds.length > 16) winds.shift();
  }

  function spawnTrail(x, y) {
    trails.push({ x, y, life: 1, size: 2 + Math.random() * 6, hue: 170 + Math.random() * 80 });
    if (trails.length > 36) trails.shift();
  }

  function spawnBurst(x, y) {
    for (let index = 0; index < 22; index += 1) {
      const angle = Math.random() * Math.PI * 2;
      trails.push({ x, y, vx: Math.cos(angle) * (1 + Math.random() * 3), vy: Math.sin(angle) * (1 + Math.random() * 3), life: 1, size: 2 + Math.random() * 5, hue: 45 + Math.random() * 165 });
    }
  }

  function drawSky(ctx) {
    const gradient = ctx.createLinearGradient(0, 0, 0, height);
    gradient.addColorStop(0, '#06111b');
    gradient.addColorStop(0.6, '#091422');
    gradient.addColorStop(1, '#05080d');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, width, height);
  }

  function drawAurora(ctx, now) {
    ctx.save();
    ctx.globalCompositeOperation = 'screen';
    auroras.forEach((band, bandIndex) => {
      for (let layer = 0; layer < 7; layer += 1) {
        ctx.beginPath();
        const offset = layer * 11;
        for (let x = -80; x <= width + 80; x += 18) {
          const wave = Math.sin(x * 0.006 + now * band.speed + band.phase) * band.amp + Math.sin(x * 0.018 + band.phase) * 16;
          const y = band.y + wave + offset;
          if (x === -80) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        const gradient = ctx.createLinearGradient(0, band.y - band.amp, 0, band.y + band.amp + 90);
        const alpha = Math.max(0.02, 0.15 - layer * 0.015 - bandIndex * 0.008);
        gradient.addColorStop(0, `hsla(${band.hue}, 100%, 68%, 0)`);
        gradient.addColorStop(0.45, `hsla(${band.hue}, 100%, 65%, ${alpha})`);
        gradient.addColorStop(1, `hsla(${band.hue + 42}, 100%, 70%, 0)`);
        ctx.strokeStyle = gradient;
        ctx.lineWidth = 18 + layer * 10;
        ctx.shadowBlur = 24;
        ctx.shadowColor = `hsl(${band.hue}, 100%, 70%)`;
        ctx.stroke();
      }
    });
    ctx.restore();
  }

  function drawStars(ctx, now) {
    stars.forEach((star) => {
      const alpha = 0.35 + Math.sin(now * 0.002 + star.twinkle) * 0.3;
      ctx.globalAlpha = Math.max(0.08, alpha);
      ctx.fillStyle = '#fff8d8';
      ctx.beginPath();
      ctx.arc(star.x, star.y, star.r, 0, Math.PI * 2);
      ctx.fill();
    });
    ctx.globalAlpha = 1;
  }

  function drawClouds(ctx, now, golden) {
    ctx.save();
    ctx.globalAlpha = golden ? 0.34 : 0.42;
    ctx.fillStyle = golden ? 'rgba(255, 220, 170, 0.72)' : 'rgba(255, 255, 255, 0.74)';
    clouds.forEach((cloud) => {
      const x = (cloud.x + now * cloud.speed) % (width + 260) - 130;
      const y = cloud.y;
      const s = cloud.scale;
      ctx.beginPath();
      ctx.ellipse(x, y, 72 * s, 18 * s, 0, 0, Math.PI * 2);
      ctx.ellipse(x + 45 * s, y - 12 * s, 48 * s, 24 * s, 0, 0, Math.PI * 2);
      ctx.ellipse(x + 92 * s, y + 4 * s, 64 * s, 20 * s, 0, 0, Math.PI * 2);
      ctx.fill();
    });
    ctx.restore();
  }

  function drawWeather(ctx, night) {
    ctx.save();
    weather.forEach((particle) => {
      const pointer = state.pointer || { x: -9999, y: -9999 };
      const distance = Math.hypot(particle.x - pointer.x, particle.y - pointer.y);
      if (distance < 130) {
        particle.x += (particle.x - pointer.x) * 0.006;
        particle.y += (particle.y - pointer.y) * 0.004;
      }
      particle.x += particle.drift + (night ? 0.05 : -0.3);
      particle.y += particle.speed;
      if (particle.y > height + 20) { particle.y = -20; particle.x = rand() * width; }
      if (particle.x < -30) particle.x = width + 30;
      if (particle.x > width + 30) particle.x = -30;
      if (night) {
        ctx.globalAlpha = 0.45;
        ctx.fillStyle = '#f5fbff';
        ctx.beginPath();
        ctx.arc(particle.x, particle.y, particle.size * 0.7, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.globalAlpha = 0.38;
        ctx.strokeStyle = '#c6f0ff';
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.moveTo(particle.x, particle.y);
        ctx.lineTo(particle.x - 8, particle.y + 18);
        ctx.stroke();
      }
    });
    ctx.restore();
  }

  function drawMountains(ctx, night) {
    const base = height * 0.74;
    const mountainGradient = ctx.createLinearGradient(0, base - 130, 0, height);
    mountainGradient.addColorStop(0, night ? 'rgba(13, 29, 47, 0.92)' : 'rgba(51, 71, 91, 0.82)');
    mountainGradient.addColorStop(1, night ? 'rgba(7, 16, 29, 0.72)' : 'rgba(32, 51, 67, 0.62)');
    ctx.fillStyle = mountainGradient;
    ctx.beginPath();
    ctx.moveTo(0, height);
    for (let x = 0; x <= width; x += 80) ctx.lineTo(x, base - Math.sin(x * 0.01) * 40 - (x % 160 === 0 ? 80 : 20));
    ctx.lineTo(width, height);
    ctx.closePath();
    ctx.fill();
  }

  function tick(now, ctx) {
    drawSky(ctx);
    drawAurora(ctx, now);
    ctx.globalAlpha = 1;
  }

  resize(width, height);
  return { resize, pushWind, spawnTrail, spawnBurst, tick };
}

function setupReveal() {
  const observer = new IntersectionObserver((entries) => entries.forEach((entry) => {
    if (entry.isIntersecting) {
      entry.target.classList.add('visible');
      observer.unobserve(entry.target);
    }
  }), { threshold: 0.1 });
  document.querySelectorAll('[data-reveal]:not(.visible)').forEach((element) => observer.observe(element));
}

function renderPage() {
  if (page === 'mods') renderList(uploadedItems('mod'), '#mod-grid');
  if (page === 'tools') renderList(uploadedItems('tool'), '#tool-grid');
  if (page === 'admin') renderAdmin();
}

const year = document.querySelector('#year');
if (year) year.textContent = new Date().getFullYear();
bootstrap();
