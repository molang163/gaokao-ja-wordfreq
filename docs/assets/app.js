const state = {
  words: [],
  tree: [],
  meta: {},
  stats: {},
  activeFilter: { scope: 'solving', group: 'content' },
  activeLabel: '阅读/解题高频实词',
  activeCategoryId: '',
  query: '',
  sort: 'current',
  page: 1,
  pageSize: 80,
};

const el = (id) => document.getElementById(id);
const fmt = (n) => Number(n || 0).toLocaleString('zh-CN');
const INDEX_COUNT_KEYS = ['all', 'solving', 'listening_prompt', 'listening_transcript', 'listening_asr', 'listening_heard', 'listening_total'];
const INDEX_PAPER_COUNT_KEYS = ['all', 'solving', 'listening_prompt', 'listening_heard', 'listening_total'];
const scopeCount = (word, scope) => Number((word.counts || {})[scope || 'all'] || 0);
const paperCount = (word, scope) => Number((word.paper_counts || {})[scope || 'all'] || word.paper_counts?.all || 0);

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[char]));
}

function objectFromKeys(keys, values) {
  const out = {};
  keys.forEach((key, index) => { out[key] = Number(values?.[index] || 0); });
  return out;
}

function unpackIndexWords(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || !Array.isArray(payload.words)) return [];
  return payload.words.map(row => ({
    word_id: row[0],
    display_form: row[1],
    lemma_form: row[2],
    reading: row[3],
    pos_major: row[4],
    pos_label: row[5],
    pos_bucket: row[6],
    group: row[7],
    counts: objectFromKeys(payload.count_keys || INDEX_COUNT_KEYS, row[8]),
    paper_counts: objectFromKeys(payload.paper_count_keys || INDEX_PAPER_COUNT_KEYS, row[9]),
    source_flags: row[10] || [],
    quality_flags: row[11] || [],
    dict_query: row[12],
    dict_query_alt: row[13] || [],
    surface_variant_count: Number(row[14] || 0),
    reading_variant_count: Number(row[15] || 0),
    sense_ambiguous: Boolean(row[16]),
  }));
}

function mojiUrl(word) {
  const base = state.meta.moji_search_base || 'https://www.mojidict.com/searchText/';
  return `${base}${word.dict_query || word.display_form || ''}`;
}

function mojiAttrs(word) {
  const query = word.dict_query || word.display_form || '';
  return `href="${escapeHtml(mojiUrl(word))}" target="_blank" rel="noopener" data-stop-row="true" data-moji-query="${escapeHtml(query)}"`;
}

function isMobileMojiFallback() {
  return window.innerWidth <= 760 || window.matchMedia?.('(pointer: coarse)')?.matches;
}

function fallbackCopy(text) {
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.left = '-9999px';
  textarea.style.top = '0';
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  let copied = false;
  try {
    copied = document.execCommand('copy');
  } catch (error) {
    copied = false;
  }
  textarea.remove();
  return copied;
}

async function copyText(text) {
  if (navigator.clipboard?.writeText && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (error) {
      return fallbackCopy(text);
    }
  }
  return fallbackCopy(text);
}

function showToast(message) {
  let toast = el('toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'toast';
    toast.className = 'toast';
    toast.setAttribute('role', 'status');
    document.body.appendChild(toast);
  }
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove('show'), 3600);
}

function handleMojiLinkClick(event, link) {
  if (!isMobileMojiFallback()) return;
  const query = link.dataset.mojiQuery || '';
  if (!query) return;
  event.preventDefault();
  event.stopPropagation();
  copyText(query).then(copied => {
    showToast(copied
      ? `已复制「${query}」，可在 MOJi App 或其他词典里粘贴查询。`
      : `请复制这个词形查询：${query}`);
  });
}

function scopeHasAsr(scope) {
  return ['all', 'listening_heard', 'listening_total'].includes(scope || 'all');
}

function sourceBadges(word, scope) {
  const labels = {
    solving: '解题',
    listening_prompt: '题面',
    listening_transcript: '听力文字稿',
    listening_asr: 'ASR',
  };
  const currentLabels = {
    all: '总览',
    solving: '当前: 解题',
    listening_prompt: '当前: 题面',
    listening_heard: '当前: 听力听到',
    listening_total: '当前: 听力综合',
  };
  const badges = [`<span class="badge source">${currentLabels[scope || 'all'] || '当前'}</span>`];
  for (const flag of (word.source_flags || [])) {
    if (scope === 'solving' && flag === 'solving') continue;
    if (scope === 'listening_prompt' && flag === 'listening_prompt') continue;
    if (scope === 'listening_heard' && ['listening_transcript', 'listening_asr'].includes(flag)) continue;
    const cls = flag === 'listening_asr' ? 'badge asr' : 'badge';
    badges.push(`<span class="${cls}">也见 ${labels[flag] || flag}</span>`);
  }
  if (scopeHasAsr(scope) && (word.quality_flags || []).length) badges.push('<span class="badge warn">低覆盖源</span>');
  return `<span class="badge-list">${badges.join('')}</span>`;
}

function noteFor(word) {
  const notes = [];
  if (word.dict_query && word.dict_query !== word.display_form) notes.push(`查原形：${escapeHtml(word.dict_query)}`);
  if (word.sense_ambiguous) notes.push('可能多义');
  return notes.join(' / ') || '<span class="muted">-</span>';
}

function flattenTree(tree) {
  const out = [];
  for (const group of tree) {
    for (const child of group.children || []) out.push({ group: group.label, ...child });
  }
  return out;
}

function renderTree() {
  const tree = el('tree');
  const select = el('category-select');
  tree.innerHTML = '';
  select.innerHTML = '';
  for (const group of state.tree) {
    const wrap = document.createElement('div');
    wrap.className = 'tree-group';
    wrap.innerHTML = `<p class="tree-title">${escapeHtml(group.label)}</p>`;
    for (const child of group.children || []) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'tree-button';
      button.dataset.id = child.id;
      button.textContent = child.label;
      button.addEventListener('click', () => setCategory(child));
      wrap.appendChild(button);

      const option = document.createElement('option');
      option.value = child.id;
      option.textContent = `${group.label} / ${child.label}`;
      select.appendChild(option);
    }
    tree.appendChild(wrap);
  }
  renderQuickEntries();
  select.addEventListener('change', () => {
    const item = flattenTree(state.tree).find(node => node.id === select.value);
    if (item) setCategory(item);
  });
  const defaultItem = flattenTree(state.tree).find(item => item.id === state.meta.default_category) || flattenTree(state.tree)[0];
  setCategory(defaultItem, false);
}

function renderQuickEntries() {
  const wrap = el('quick-entries');
  if (!wrap) return;
  const group = state.tree.find(item => item.id === 'home');
  const entries = (group?.children || []).slice(0, 4);
  wrap.innerHTML = '';
  for (const child of entries) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'quick-button';
    button.dataset.id = child.id;
    button.textContent = child.label;
    button.addEventListener('click', () => setCategory(child));
    wrap.appendChild(button);
  }
}

function setCategory(item, shouldRender = true) {
  state.activeFilter = item.filter || { scope: 'all' };
  state.activeLabel = item.label;
  state.activeCategoryId = item.id;
  if (state.activeFilter.sort) {
    state.sort = state.activeFilter.sort;
    if (el('sort-select')) el('sort-select').value = state.sort;
  }
  state.page = 1;
  document.querySelectorAll('.tree-button, .quick-button').forEach(button => {
    button.classList.toggle('active', button.dataset.id === item.id);
  });
  el('category-select').value = item.id;
  if (shouldRender) render();
}

function matchesFilter(word) {
  const filter = state.activeFilter || {};
  const scope = filter.scope || 'all';
  if (scopeCount(word, scope) <= 0) return false;
  if (filter.group && word.group !== filter.group) return false;
  if (filter.pos && word.pos_major !== filter.pos) return false;
  return true;
}

function matchesQuery(word) {
  const q = state.query.trim().toLowerCase();
  if (!q) return true;
  const haystack = [
    word.display_form, word.lemma_form, word.reading, word.dict_query,
    ...(word.dict_query_alt || [])
  ].join(' ').toLowerCase();
  return haystack.includes(q);
}

function rankComparator(scope) {
  return (a, b) =>
    scopeCount(b, scope) - scopeCount(a, scope) ||
    paperCount(b, scope) - paperCount(a, scope) ||
    b.counts.all - a.counts.all ||
    String(a.word_id).localeCompare(String(b.word_id));
}

function sortComparator(scope) {
  return (a, b) => {
    if (state.sort === 'total') return b.counts.all - a.counts.all || rankComparator(scope)(a, b);
    if (state.sort === 'paper') return paperCount(b, scope) - paperCount(a, scope) || scopeCount(b, scope) - scopeCount(a, scope);
    if (state.sort === 'reading') return String(a.reading || a.display_form).localeCompare(String(b.reading || b.display_form), 'ja');
    return rankComparator(scope)(a, b);
  };
}

function filteredWords() {
  const filter = state.activeFilter || {};
  const scope = filter.scope || 'all';
  let rows = state.words.filter(matchesFilter);
  if (Number(filter.limit || 0) > 0) {
    rows.sort(rankComparator(scope));
    rows = rows.slice(0, Number(filter.limit));
  }
  rows = rows.filter(matchesQuery);
  rows.sort(sortComparator(scope));
  return rows;
}

function renderStats(rows) {
  const scope = state.activeFilter.scope || 'all';
  const total = rows.reduce((sum, word) => sum + scopeCount(word, scope), 0);
  const asr = scopeHasAsr(scope) ? rows.reduce((sum, word) => sum + Number(word.counts.listening_asr || 0), 0) : 0;
  el('stats-strip').innerHTML = `
    <div class="stat"><span>词条</span><strong>${fmt(rows.length)}</strong></div>
    <div class="stat"><span>当前次数</span><strong>${fmt(total)}</strong></div>
    <div class="stat"><span>当前 ASR</span><strong>${fmt(asr)}</strong></div>
  `;
}

function renderTable(rows) {
  const scope = state.activeFilter.scope || 'all';
  const totalPages = Math.max(1, Math.ceil(rows.length / state.pageSize));
  state.page = Math.min(state.page, totalPages);
  const start = (state.page - 1) * state.pageSize;
  const pageRows = rows.slice(start, start + state.pageSize);
  el('word-tbody').innerHTML = pageRows.map(word => `
    <tr data-word-id="${escapeHtml(word.word_id)}">
      <td><span class="word-main">${escapeHtml(word.display_form)}</span></td>
      <td>${escapeHtml(word.reading || '')}</td>
      <td>${escapeHtml(word.pos_label || word.pos_major || '')}</td>
      <td class="data-col">${escapeHtml(word.lemma_form || '')}</td>
      <td>${noteFor(word)}</td>
      <td class="count">${fmt(scopeCount(word, scope))}</td>
      <td class="count">${fmt(word.counts.all)}</td>
      <td class="data-col">${fmt(paperCount(word, scope))}</td>
      <td>${sourceBadges(word, scope)}</td>
      <td><a ${mojiAttrs(word)}>Moji</a></td>
    </tr>
  `).join('');
  renderWordCards(pageRows, scope);
  const pageStart = rows.length ? start + 1 : 0;
  el('page-status').textContent = `${fmt(pageStart)}-${fmt(Math.min(start + pageRows.length, rows.length))} / ${fmt(rows.length)}`;
  el('prev-page').disabled = state.page <= 1;
  el('next-page').disabled = state.page >= totalPages;
  bindWordItems();
}

function renderWordCards(pageRows, scope) {
  const wrap = el('word-card-list');
  if (!wrap) return;
  wrap.innerHTML = pageRows.map(word => `
    <article class="word-card" data-word-id="${escapeHtml(word.word_id)}" tabindex="0" role="button" aria-label="查看 ${escapeHtml(word.display_form)} 详情">
      <div class="word-card-main">
        <div>
          <div class="word-card-word">${escapeHtml(word.display_form)}</div>
          <div class="word-card-reading">${escapeHtml(word.reading || '')}${word.pos_label ? ` · ${escapeHtml(word.pos_label)}` : ''}</div>
        </div>
        <strong class="word-card-current"><span>当前</span>${fmt(scopeCount(word, scope))}</strong>
      </div>
      <div class="word-card-note">
        原形：${escapeHtml(word.lemma_form || '-')}
        ${noteFor(word) !== '<span class="muted">-</span>' ? ` / ${noteFor(word)}` : ''}
      </div>
      <div class="word-card-metrics">
        <div><span>当前次数</span><strong>${fmt(scopeCount(word, scope))}</strong></div>
        <div><span>总次数</span><strong>${fmt(word.counts.all)}</strong></div>
        <div><span>试卷数</span><strong>${fmt(paperCount(word, scope))}</strong></div>
      </div>
      <div class="word-card-tags">${sourceBadges(word, scope)}</div>
      <div class="word-card-actions">
        <button type="button" data-open-detail="${escapeHtml(word.word_id)}">详情</button>
        <a ${mojiAttrs(word)}><span class="desktop-label">Moji</span><span class="mobile-label">复制查词</span></a>
      </div>
    </article>
  `).join('');
}

function render() {
  el('category-title').textContent = state.activeLabel;
  const filter = state.activeFilter || {};
  const scope = filter.scope || 'all';
  const scopeLabels = {
    all: '全部统计范围',
    solving: '阅读和解题文本',
    listening_prompt: '试卷上印出的听力题面',
    listening_heard: '听力音频/听到内容，含机器 ASR',
    listening_total: '听力题面 + 听力音频/听到内容',
  };
  let description = scopeLabels[scope] || '当前分类';
  if (filter.limit) {
    description = `按总览出现次数取前 ${filter.limit} 个实词；总览包含阅读/解题、听力题面和听力听到内容。`;
  } else if (scope === 'solving' && filter.group === 'content') {
    description = '按阅读、语法题、题干和选项等解题文本中的出现次数排序，默认只展示实词。';
  } else if (scope === 'listening_total' && filter.group === 'content') {
    description = '按听力题面 + 听力听到内容排序；听力听到内容含机器 ASR，可能有识别误差。';
  }
  el('category-description').textContent = description;
  const rows = filteredWords();
  renderStats(rows);
  renderTable(rows);
}

function dictionaryHtml(dictionary, compact = false) {
  if (!dictionary || !((dictionary.glosses_zh || []).length || (dictionary.glosses || []).length)) {
    return '<p class="muted">暂无 JMdict 释义，建议打开 Moji 查询。</p>';
  }
  const head = [dictionary.headword, dictionary.reading].filter(Boolean).map(escapeHtml).join(' / ');
  const zhGlosses = (dictionary.glosses_zh || []).slice(0, compact ? 3 : 4).map(escapeHtml).join('；');
  if (zhGlosses) {
    return `<p><strong>${head || 'JMdict'}</strong><br><span class="muted">释义：${zhGlosses}</span></p>`;
  }
  const glosses = (dictionary.glosses || []).slice(0, compact ? 3 : 4).map(escapeHtml).join('; ');
  return `<p><strong>${head || 'JMdict'}</strong><br><span class="muted">暂无中文释义；英文义项：${glosses}</span></p>`;
}

function examplesHtml(examples, compact = false) {
  const rows = (examples || []).slice(0, compact ? 2 : 5);
  if (!rows.length) return '<p class="muted">暂无可展示例句。</p>';
  return `<ul class="example-list">${rows.map(item => `
    <li>
      <span class="example-text">${escapeHtml(item.text)}</span>
      <span class="example-source">${escapeHtml(item.paper_label)} / ${escapeHtml(item.source)}${item.has_asr ? ' / ASR' : ''}</span>
    </li>
  `).join('')}</ul>`;
}

function tooltipHtml(word, detail = null) {
  const topSources = (detail?.top_sources || word.top_sources || []);
  const top = topSources.map(src => `<li>${escapeHtml(src.paper_label)}：${escapeHtml(src.source_breakdown || '')}</li>`).join('');
  const warning = (word.quality_flags || []).length
    ? '<p><span class="badge warn">含低覆盖 ASR 来源</span></p>' : '';
  const lookup = word.dict_query && word.dict_query !== word.display_form
    ? `<p class="muted">这个词以变形形式出现，查词时建议查原形：${escapeHtml(word.dict_query)}</p>` : '';
  const dictionary = detail ? dictionaryHtml(detail.dictionary, true) : '<p class="muted">词典和例句加载中…</p>';
  const examples = detail ? examplesHtml(detail.examples, true) : '';
  return `
    <div class="tooltip-title">${escapeHtml(word.display_form)} / ${escapeHtml(word.lemma_form)} / ${escapeHtml(word.pos_label)}</div>
    <div class="tooltip-block">
      <strong>词典解释</strong>
      ${dictionary}
    </div>
    <div class="tooltip-block">
      <strong>高考例句</strong>
      ${examples}
    </div>
    <div class="tooltip-grid">
      <span>总次数</span><strong>${fmt(word.counts.all)}</strong>
      <span>解题</span><strong>${fmt(word.counts.solving)}</strong>
      <span>听力题面</span><strong>${fmt(word.counts.listening_prompt)}</strong>
      <span>听力 ASR</span><strong>${fmt(word.counts.listening_asr)}</strong>
    </div>
    ${lookup}
    ${warning}
    <strong>高频来源</strong>
    ${top ? `<ul>${top}</ul>` : '<p class="muted">来源加载中…</p>'}
  `;
}

let activeTooltipWordId = null;

function bindWordItems() {
  const tooltip = el('tooltip');
  document.querySelectorAll('tbody tr[data-word-id]').forEach(row => {
    const word = state.words.find(item => item.word_id === row.dataset.wordId);
    if (!word) return;
    row.addEventListener('mouseenter', (event) => {
      if (!window.matchMedia('(hover: hover) and (pointer: fine)').matches) return;
      activeTooltipWordId = word.word_id;
      tooltip.innerHTML = tooltipHtml(word);
      tooltip.hidden = false;
      moveTooltip(event);
      loadWordDetail(word.word_id).then(detail => {
        if (activeTooltipWordId === word.word_id && !tooltip.hidden) {
          tooltip.innerHTML = tooltipHtml(word, detail);
          moveTooltip(event);
        }
      }).catch(() => {});
    });
    row.addEventListener('mousemove', moveTooltip);
    row.addEventListener('mouseleave', () => { activeTooltipWordId = null; tooltip.hidden = true; });
    row.addEventListener('click', (event) => {
      if (event.target.closest('[data-stop-row]')) return;
      openDrawer(word.word_id, row);
    });
  });

  document.querySelectorAll('.word-card[data-word-id]').forEach(card => {
    const wordId = card.dataset.wordId;
    card.addEventListener('click', (event) => {
      if (event.target.closest('[data-stop-row]')) return;
      openDrawer(wordId, card);
    });
    card.addEventListener('keydown', (event) => {
      if (!['Enter', ' '].includes(event.key)) return;
      if (event.target.closest('a, button, input, select, textarea')) return;
      if (event.target.closest('[data-stop-row]')) return;
      event.preventDefault();
      openDrawer(wordId, card);
    });
  });

  document.querySelectorAll('[data-open-detail]').forEach(button => {
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      openDrawer(button.dataset.openDetail, button);
    });
  });
}

function moveTooltip(event) {
  const tooltip = el('tooltip');
  const x = Math.min(window.innerWidth - tooltip.offsetWidth - 12, event.clientX + 18);
  const y = Math.min(window.innerHeight - tooltip.offsetHeight - 12, event.clientY + 18);
  tooltip.style.left = `${Math.max(12, x)}px`;
  tooltip.style.top = `${Math.max(12, y)}px`;
}

function bar(label, value, max) {
  const pct = max ? Math.max(2, Math.round((value / max) * 100)) : 0;
  return `<div class="bar-row"><span>${escapeHtml(label)}</span><div class="bar-track"><div class="bar-fill" style="width:${pct}%"></div></div><strong>${fmt(value)}</strong></div>`;
}

const detailShardCache = new Map();
let lastFocusedElement = null;

async function loadWordDetail(wordId) {
  const shard = wordId.slice(0, 2);
  if (!detailShardCache.has(shard)) {
    detailShardCache.set(shard, fetch(`data/word-shards/${shard}.json`).then(r => r.json()));
  }
  const details = await detailShardCache.get(shard);
  if (!details[wordId]) throw new Error(`missing detail for ${wordId}`);
  return details[wordId];
}

async function openDrawer(wordId, returnFocusTarget = null) {
  lastFocusedElement = returnFocusTarget || document.activeElement;
  activeTooltipWordId = null;
  el('tooltip').hidden = true;
  const word = await loadWordDetail(wordId);
  const counts = word.counts || {};
  const maxCount = Math.max(counts.solving || 0, counts.listening_prompt || 0, counts.listening_asr || 0, counts.listening_transcript || 0, 1);
  const variants = (word.variant_counts || []).slice(0, 12).map(([form, count]) => bar(form, count, word.counts.all)).join('');
  const years = Object.entries(word.year_distribution || {}).map(([year, count]) => [year, Number(count || 0)]);
  const maxYear = Math.max(1, ...years.map(([, count]) => count));
  const yearBars = years.map(([year, count]) => bar(year, count, maxYear)).join('');
  const papers = (word.paper_distribution || []).slice(0, 16).map(item => `
    <tr>
      <td>${escapeHtml(item.paper_label)}</td>
      <td>${fmt(item.solving || 0)}</td>
      <td>${fmt(item.listening_prompt || 0)}</td>
      <td>${fmt(item.listening_transcript || 0)}</td>
      <td>${fmt(item.listening_asr || 0)}</td>
      <td class="count">${fmt(item.total)}</td>
      <td>${item.has_asr ? '<span class="badge asr">ASR</span>' : ''}${(item.quality_flags || []).length ? '<span class="badge warn">低覆盖</span>' : ''}</td>
    </tr>
  `).join('');
  const warnings = (word.warnings || []).map(w => ({
    contains_asr: '包含 ASR 数据，可能存在识别误差。',
    contains_low_coverage_asr_2004: '包含 2004 低覆盖听力 ASR 来源，相关次数可能被低估。',
    lookup_by_dictionary_form_recommended: `建议用词典形查询：${escapeHtml(word.dict_query)}。`,
  }[w] || w)).map(text => `<p><span class="badge warn">${text}</span></p>`).join('');
  el('drawer-body').innerHTML = `
    <h2 class="detail-title">${escapeHtml(word.display_form)}</h2>
    <p class="detail-meta">原形：${escapeHtml(word.lemma_form)} / 读音：${escapeHtml(word.reading)} / 词性：${escapeHtml(word.pos_label)}</p>
    <p><a ${mojiAttrs(word)}>打开 Moji：${escapeHtml(word.dict_query)}</a></p>

    <section class="detail-section">
      <h3>词典解释</h3>
      ${dictionaryHtml(word.dictionary)}
      <p class="muted">中文释义由 qwen-turbo 基于 JMdict/JMdict-simplified 义项生成；疑难词建议继续用 Moji 核对。</p>
    </section>

    <section class="detail-section">
      <h3>高考例句</h3>
      ${examplesHtml(word.examples)}
    </section>

    <section class="detail-section">
      <h3>出现概览</h3>
      ${bar('解题', counts.solving || 0, maxCount)}
      ${bar('听力题面', counts.listening_prompt || 0, maxCount)}
      ${bar('听力文字稿', counts.listening_transcript || 0, maxCount)}
      ${bar('听力 ASR', counts.listening_asr || 0, maxCount)}
    </section>

    <section class="detail-section">
      <h3>词形变体</h3>
      ${variants || '<p class="muted">暂无变体数据</p>'}
    </section>

    <section class="detail-section">
      <h3>年份分布</h3>
      ${yearBars || '<p class="muted">暂无年份数据</p>'}
    </section>

    <section class="detail-section">
      <h3>高频试卷</h3>
      <div class="table-shell">
        <table class="detail-table">
          <thead><tr><th>试卷</th><th>解题</th><th>题面</th><th>文字稿</th><th>ASR</th><th>合计</th><th>标记</th></tr></thead>
          <tbody>${papers}</tbody>
        </table>
      </div>
    </section>

    <section class="detail-section">
      <h3>数据提示</h3>
      ${warnings || '<p class="muted">无特殊提示</p>'}
    </section>
  `;
  el('drawer').hidden = false;
  el('drawer-backdrop').hidden = false;
  el('drawer').classList.add('open');
  el('drawer').setAttribute('aria-hidden', 'false');
  document.body.classList.add('drawer-open');
  requestAnimationFrame(() => el('drawer-close').focus());
}

function closeDrawer() {
  el('drawer-backdrop').hidden = true;
  el('drawer').classList.remove('open');
  el('drawer').setAttribute('aria-hidden', 'true');
  el('drawer').hidden = true;
  document.body.classList.remove('drawer-open');
  if (lastFocusedElement && document.contains(lastFocusedElement)) {
    lastFocusedElement.focus();
  }
  lastFocusedElement = null;
}

async function init() {
  const [meta, stats, tree, words] = await Promise.all([
    fetch('data/meta.json').then(r => r.json()),
    fetch('data/stats.json').then(r => r.json()),
    fetch('data/tree.json').then(r => r.json()),
    fetch('data/words.index.json').then(r => r.json()),
  ]);
  state.meta = meta;
  state.stats = stats;
  state.tree = tree;
  state.words = unpackIndexWords(words);
  el('site-subtitle').textContent = `${meta.subtitle} / ${fmt(meta.word_count)} 个词条`;
  el('asr-note').textContent = meta.asr_note;
  renderTree();
  el('search-input').addEventListener('input', event => { state.query = event.target.value; state.page = 1; render(); });
  el('sort-select').addEventListener('change', event => { state.sort = event.target.value; state.page = 1; render(); });
  el('data-toggle').addEventListener('change', event => document.body.classList.toggle('show-data', event.target.checked));
  el('prev-page').addEventListener('click', () => { state.page -= 1; render(); });
  el('next-page').addEventListener('click', () => { state.page += 1; render(); });
  el('drawer-close').addEventListener('click', closeDrawer);
  el('drawer-backdrop').addEventListener('click', closeDrawer);
  document.addEventListener('click', event => {
    const link = event.target.closest('[data-moji-query]');
    if (link) handleMojiLinkClick(event, link);
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !el('drawer').hidden) closeDrawer();
  });
  render();
}

init().catch(error => {
  document.body.innerHTML = `<main class="content"><h1>加载失败</h1><pre>${escapeHtml(error.stack || error.message || error)}</pre></main>`;
});
