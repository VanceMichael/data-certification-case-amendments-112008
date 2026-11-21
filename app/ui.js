const FIELDS = [
  ['caseNumber', '申请号'],
  ['changeNumber', '变更编号'],
  ['market', '目标市场'],
  ['auditDay', '计划审核日'],
  ['operation', '迁移工序'],
  ['retireSite', '旧场址'],
  ['alternativeSite', '新场址编号'],
  ['preferredLabel', '目录显示名（可选）'],
  ['unaffectedOperation', '保留的未迁移工序'],
  ['directoryPath', '地址目录路径'],
];

const DEFAULTS = {
  caseNumber: 'A92',
  changeNumber: 'C-112',
  market: 'R1',
  auditDay: '2026-12-08',
  operation: '切割',
  retireSite: 'G-4',
  alternativeSite: 'D-5',
  preferredLabel: '青港分部',
  unaffectedOperation: '过秤',
  directoryPath: '/directory',
};

const $ = (id) => document.getElementById(id);
let state = null;
let notice = '';

function field(label, id, value, attrs = '') {
  return `<label><span>${label}</span><input id="${id}" value="${escapeHtml(value ?? '')}" ${attrs}></label>`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

function renderForm() {
  const amendment = state?.amendment ?? DEFAULTS;
  $('amendment-form').innerHTML = FIELDS
    .map(([key, label], index) => field(label, `field-${key}`, amendment[key],
      index === 3 ? 'type="date"' : ''))
    .join('');
}

function amendmentFromForm() {
  return Object.fromEntries(FIELDS.map(([key]) => [key, $(`field-${key}`).value.trim()]));
}

async function api(path, body) {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  const payload = await response.json();
  if (payload.state) state = payload.state;
  if (!response.ok) {
    notice = payload.error?.message ?? '操作失败';
    render();
    return null;
  }
  notice = '';
  render();
  return payload;
}

function chipClass(status) {
  if (/全部受理/.test(status)) return 'good';
  if (/半边|失效|不符|异常|半边/.test(status)) return 'warn';
  if (/部分/.test(status)) return 'warn';
  return '';
}

function statusText() {
  if (!state) return '未开始';
  return state.status ?? '未开始';
}

function renderActions() {
  const actions = [];
  if (!state) {
    actions.push('<p class="muted">先载入变更资料。</p>');
  } else {
    const stage = state.stage;
    if (['new', 'inspected'].includes(stage)) {
      actions.push('<button data-act="inspect">核对目录与申请</button>');
    }
    if (['inspected', 'reviewed', 'stale'].includes(stage) && state.caseContext) {
      actions.push(`<button data-act="review" ${stage === 'inspected' ? 'class="secondary"' : ''}>查看复核页</button>`);
    }
    if (stage === 'reviewed') {
      actions.push(`
        <div class="row" style="margin-top:10px">
          ${field('经办人', 'approver', '')}
          <button data-act="approve">按当前屏幕内容批准</button>
        </div>`);
    }
    if (stage === 'approved') {
      actions.push('<button data-act="submit">提交本次补报</button>');
    }
    if (['submitted', 'pending', 'partial'].includes(stage)) {
      actions.push('<button data-act="receipt" class="secondary">按申请号查回执</button>');
    }
    if (stage === 'partial') {
      actions.push('<button data-act="continuation">读取剩余办理</button>');
    }
    if (stage === 'continuation-ready') {
      actions.push(`
        <div class="row" style="margin-top:10px">
          ${field('确认经办人', 'continuation-approver', '')}
          <button data-act="continuation-approve">确认剩余事项</button>
        </div>`);
    }
    if (stage === 'continuation-approved') {
      actions.push('<button data-act="continuation-submit">提交剩余终止</button>');
    }
    if (stage === 'settled') {
      actions.push('<p class="muted">全部受理完成，无需继续操作。</p>');
    }
  }
  $('actions').innerHTML = actions.join('');
  for (const button of $('actions').querySelectorAll('button')) {
    button.addEventListener('click', () => act(button.dataset.act));
  }
}

function siteList(items) {
  if (!items?.length) return '<span class="muted">无</span>';
  return `<ul style="margin:4px 0 0 16px;padding:0">${items.map((item) =>
    `<li>${escapeHtml(item.site)}${item.name ? `（${escapeHtml(item.name)}）` : ''} · ${escapeHtml(item.operation ?? '')}${item.accepted ? ' · 已受理' : ''}</li>`).join('')}</ul>`;
}

function renderEvidence() {
  const target = $('evidence');
  if (!state?.caseContext && !state?.directory) {
    target.className = 'muted';
    target.textContent = '尚未读取门户。';
    return;
  }
  target.className = '';
  const blocks = [];
  if (state.directory) {
    blocks.push(`
      <div class="card">
        <strong>地址目录页</strong>
        <div class="source">${escapeHtml(state.directory.url)} · 核于 ${escapeHtml(state.directory.capturedAt)} · 摘要 <code>${escapeHtml(state.directory.digest)}</code></div>
        <h3>核定的新场址</h3>${siteList(state.directory.matched)}
      </div>`);
  }
  if (state.caseContext) {
    blocks.push(`
      <div class="card">
        <strong>申请详情页</strong>
        <div class="source">${escapeHtml(state.caseContext.url)} · 受理版本 ${escapeHtml(state.caseContext.version)} · 摘要 <code>${escapeHtml(state.caseContext.digest ?? '—')}</code></div>
        <h3>已受理的旧址范围</h3>${siteList(state.caseContext.accepted)}
        <h3>拟终止</h3>${siteList(state.caseContext.matched)}
        <h3>保留不动的工序</h3>${siteList(state.caseContext.retained)}
        <div class="muted" style="margin-top:6px">门户已显示的进度：${state.caseContext.progress.settled ? '补加与终止均已受理' : state.caseContext.progress.addAccepted ? '补加已收' : '尚未补加'}${state.caseContext.progress.endPending ? '，终止仍待处理' : ''}</div>
      </div>`);
  }
  if (state.review) {
    blocks.push(`
      <div class="card">
        <strong>门户复核页</strong>
        <div class="source">${escapeHtml(state.review.url)} · 受理版本 ${escapeHtml(state.review.version ?? '—')} · 摘要 <code>${escapeHtml(state.review.digest)}</code></div>
        <h3>补加</h3>${siteList(state.review.additions)}
        <h3>终止</h3>${siteList(state.review.endings)}
        <h3>门户声明保留</h3>${siteList(state.review.retained)}
      </div>`);
  }
  if (state.missing?.length) {
    blocks.push(`
      <div class="card deny">
        <strong>停在可继续办理的状态</strong>
        <ul style="margin:6px 0 0 16px;padding:0">${state.missing.map((item) =>
          `<li>缺少 ${item.side === 'add' ? '新场址补加' : item.side === 'end' ? '旧场址终止' : '保留工序'} 凭据：${escapeHtml(item.message)}</li>`).join('')}</ul>
      </div>`);
  }
  target.innerHTML = blocks.join('');
}

function renderApproval() {
  const target = $('approval');
  const approval = state?.approval;
  if (!approval) {
    target.className = 'muted';
    target.textContent = '尚无经办人批准。';
    return;
  }
  target.className = '';
  const card = approval.invalidated ? 'card diff' : 'card';
  target.innerHTML = `
    <div class="${card}">
      <strong>${escapeHtml(approval.approver)}</strong> 于 ${escapeHtml(approval.at)} 批准摘要 <code>${escapeHtml(approval.digest)}</code>
      <h3>补加</h3>${siteList((approval.scope.additions ?? []).map((key) => ({ site: key.split('/')[0], operation: key.split('/')[1] })))}
      <h3>终止</h3>${siteList((approval.scope.endings ?? []).map((key) => ({ site: key.split('/')[0], operation: key.split('/')[1] })))}
      <h3>保留</h3>${siteList((approval.scope.retained ?? []).map((key) => ({ site: key.split('/')[0], operation: key.split('/')[1] })))}
      ${approval.invalidated ? `<p class="muted">该批准已失效：${escapeHtml(approval.differences.join('；'))}。需重新查看复核页并再次批准。</p>` : ''}
    </div>`;
}

function renderReceipt() {
  const target = $('receipt');
  const receipt = state?.receipt;
  if (!receipt) {
    target.className = 'muted';
    target.textContent = state?.submission ? '已提交，尚未取得回执。' : '尚无回执。';
    return;
  }
  target.className = '';
  target.innerHTML = `
    <div class="card${receipt.pending ? ' diff' : ''}">
      <div class="source">受理记录 ${escapeHtml(receipt.url)} · 查于 ${escapeHtml(receipt.lookedUpAt)} · 变更编号 ${escapeHtml(receipt.displayedChange ?? '未显示')}</div>
      <h3>已接收</h3>${siteList(receipt.accepted)}
      <h3>未接收</h3>${siteList(receipt.outstanding)}
      <h3>回执列明旧申请仍有效</h3>${siteList(receipt.retained)}
      <p class="muted">${receipt.complete ? '本次变更已全部受理。' : receipt.pending ? '受理中心尚未反馈，可按申请号与变更编号再次查询。' : '门户只接收了一部分，须从原申请继续未完成部分，不能整单重提。'}</p>
    </div>`;
}

function renderRemaining() {
  const target = $('remaining');
  const remaining = state?.remaining;
  if (!remaining) {
    target.className = 'muted';
    target.textContent = '尚无剩余事项。';
    return;
  }
  target.className = '';
  target.innerHTML = `
    <div class="card${remaining.missing?.length ? ' deny' : ''}">
      <div class="source">${escapeHtml(remaining.url)} · 摘要 <code>${escapeHtml(remaining.digest)}</code></div>
      <h3>该页只办理</h3>${siteList((remaining.offered ?? []).map((key) => ({ site: key.split('/')[0], operation: key.split('/')[1] })))}
      <h3>仍需完成</h3>${siteList((remaining.expected ?? []).map((key) => ({ site: key.split('/')[0], operation: key.split('/')[1] })))}
      <h3>确认人</h3>
      <p>${remaining.approvedBy ? `${escapeHtml(remaining.approvedBy)} 于 ${escapeHtml(remaining.approvalAt)} 确认` : '尚未确认'}</p>
      ${remaining.missing?.length ? `<p class="muted">继续页未覆盖：${escapeHtml(remaining.missing.join('、'))}</p>` : ''}
      ${remaining.approvedBy ? '<p class="muted">已受理范围与人工取消的意思随原申请保留，仅补未完成的一边。</p>' : ''}
    </div>`;
}

function renderAudit() {
  const list = $('audit');
  if (!state?.audit?.length) {
    list.innerHTML = '<li class="muted">尚无记录。</li>';
    return;
  }
  const LABELS = {
    inspect: '核对目录与申请',
    review: '打开复核页',
    approve: '经办人批准',
    stale: '复核失效',
    submit: '提交本次补报',
    receipt: '查回执',
    'receipt-error': '回执读取失败',
    'receipt-mismatch': '回执编号不一致',
    continuation: '读取剩余办理',
    'continuation-approve': '确认剩余事项',
    'continuation-submit': '提交剩余终止',
    'continuation-note': '继续办理提示',
  };
  list.innerHTML = state.audit.map((entry) => `
    <li><strong>${escapeHtml(LABELS[entry.kind] ?? entry.kind)}</strong>
      <span class="muted">${escapeHtml(entry.at)}</span>
      <pre>${escapeHtml(JSON.stringify(entry.detail, null, 2))}</pre>
    </li>`).join('');
}

function render() {
  $('notice').textContent = notice;
  const chip = $('status-chip');
  chip.textContent = statusText();
  chip.className = `status ${chipClass(statusText())}`;
  $('status-message').textContent = state?.message ?? (state ? '' : '');
  $('source-line').textContent = state ? '' : '默认来源 http://127.0.0.1:4173';
  renderActions();
  renderEvidence();
  renderApproval();
  renderReceipt();
  renderRemaining();
  renderAudit();
}

async function act(action) {
  if (action === 'inspect') return api('/api/inspect');
  if (action === 'review') return api('/api/review');
  if (action === 'approve') return api('/api/approve', { approver: $('approver')?.value ?? '' });
  if (action === 'submit') return api('/api/submit');
  if (action === 'receipt') return api('/api/receipt');
  if (action === 'continuation') return api('/api/continuation');
  if (action === 'continuation-approve') {
    return api('/api/continuation/approve', { approver: $('continuation-approver')?.value ?? '' });
  }
  if (action === 'continuation-submit') return api('/api/continuation/submit');
  return null;
}

$('start').addEventListener('click', () => api('/api/session', { amendment: amendmentFromForm() }));
$('reset').addEventListener('click', async () => {
  state = null;
  await api('/api/reset');
  renderForm();
});

renderForm();
const initial = await (await fetch('/api/state')).json();
if (initial.state) state = initial.state;
if (initial.amendment) {
  state = { ...initial.state, amendment: initial.amendment };
}
render();
