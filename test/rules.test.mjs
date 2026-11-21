import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createSource } from '../sources/source.mjs';
import {
  parseCaseText,
  parseDirectoryRows,
  parseReceiptText,
  parseRemainingText,
  parseReviewText,
} from '../app/portal.mjs';
import { buildPlan, confirmReview, directoryFingerprint, effectiveOn, receiptOutstanding, resolveNewSite } from '../app/rules.mjs';
import { compare, liveSnapshot } from '../app/ledger.mjs';
import { normalizeAmendment } from '../app/amendment.mjs';

const amendment = JSON.parse(readFileSync(new URL('../fixtures/amendment.json', import.meta.url)));
const source = JSON.parse(readFileSync(new URL('../fixtures/source.json', import.meta.url)));

const normalized = normalizeAmendment(amendment);

const directory = (catalog) => ({
  ...catalog,
  fingerprint: directoryFingerprint(catalog),
});

const catalogAtDraft = () => directory({
  entries: [
    { name: '青港分部', site: 'B-7', market: 'R1', operations: ['切割', '过秤'], from: '2026-01-01', to: '2027-01-01' },
    { name: '青港分部', site: 'B-8', market: 'R1', operations: ['切割'], from: '2026-12-10', to: '2027-01-01' },
    { name: '远海仓', site: 'D-5', market: 'R1', operations: ['切割'], from: '2026-11-01', to: '2027-01-01' },
  ],
});

const catalogAtUpdate = () => directory({
  entries: [
    { name: '青港分部', site: 'B-7', market: 'R1', operations: ['过秤'], from: '2026-01-01', to: '2027-01-01' },
    { name: '青港分部', site: 'B-8', market: 'R1', operations: ['切割'], from: '2026-12-10', to: '2027-01-01' },
    { name: '远海仓', site: 'D-5', market: 'R1', operations: ['切割'], from: '2026-11-01', to: '2027-01-01' },
  ],
});

function caseFrom(step) {
  const html = source.routes[step]['GET /cases/A92'].body;
  const text = html.replace(/<[^>]+>/g, '\n').replace(/\n+/g, '\n').trim();
  return parseCaseText(text);
}

test('地址目录的结束日不包含在生效范围里', () => {
  const entry = { from: '2026-12-10', to: '2027-01-01' };
  assert.equal(effectiveOn(entry, '2026-12-09'), false);
  assert.equal(effectiveOn(entry, '2026-12-10'), true);
  assert.equal(effectiveOn(entry, '2026-12-31'), true);
  assert.equal(effectiveOn(entry, '2027-01-01'), false);
});

test('同一显示名对应多个证书实体时先按显示名，改版后回落到地址编号', () => {
  const draft = resolveNewSite(catalogAtDraft(), normalized);
  assert.equal(draft.entry.site, 'B-7');
  assert.equal(draft.basis, 'label');
  // 草稿目录里 B-7 与 D-5 都覆盖审核日的切割，两个候选都要保留给复核页确认。
  assert.deepEqual(draft.accepted.map((entry) => entry.site).sort(), ['B-7', 'D-5']);
  assert.equal(draft.divergence.numberSite, 'D-5');

  // 改版后 B-7 只剩过秤，B-8 的切割从 12-10 才生效，审核日只有 D-5 符合。
  const updated = resolveNewSite(catalogAtUpdate(), normalized);
  assert.equal(updated.entry.site, 'D-5');
  assert.equal(updated.basis, 'site-number');
  assert.deepEqual(updated.accepted.map((entry) => entry.site), ['D-5']);
});

test('显示名歧义且编号不能消歧时停下并要求企业指认', () => {
  const catalog = directory({
    entries: [
      { name: '青港分部', site: 'B-7', market: 'R1', operations: ['切割'], from: '2026-01-01', to: '2027-01-01' },
      { name: '青港分部', site: 'B-8', market: 'R1', operations: ['切割'], from: '2026-01-01', to: '2027-01-01' },
    ],
  });
  const resolution = resolveNewSite(catalog, normalized);
  assert.equal(resolution.entry, null);
  assert.match(resolution.reason, /青港分部（B-7）[^、]*、青港分部（B-8）/);
});

test('旧址受理上下文决定终止一边；申请页未列出时留给复核页确认', () => {
  const context = caseFrom('draft');
  const plan = buildPlan(normalized, context, catalogAtDraft());
  assert.deepEqual(plan.endings, [{ site: 'G-4', operation: '切割', evidence: 'case' }]);
  assert.deepEqual(plan.retained, [{ site: 'G-4', operation: '过秤', evidence: 'case' }]);
  assert.deepEqual(plan.missing, []);
  assert.deepEqual(plan.unconfirmed, []);

  const silent = buildPlan(normalized, { ...context, acceptedOperations: [] }, catalogAtDraft());
  assert.equal(silent.additions.length, 1);
  assert.equal(silent.endings.length, 0);
  assert.equal(silent.unconfirmed.some((item) => item.side === 'end'), true);

  // 目录里没有有效新场址时，才真正只能停下。
  const noAdd = buildPlan(normalized, context, directory({ entries: [] }));
  assert.equal(noAdd.missing.some((item) => item.side === 'add'), true);
});

test('目录改版后重新核定会换掉新场址，旧批准必须失效', () => {
  const context = caseFrom('update');
  const reviewText = source.routes.update['POST /cases/A92/review'].body
    .replace(/\{\{(\w+)\}\}/g, (_, name) => ({ change: 'C-112', site: 'D-5', action: 'both' })[name]);
  const review = parseReviewText(reviewText.replace(/<[^>]+>/g, '\n').replace(/\n+/g, '\n'));
  const live = liveSnapshot(context, catalogAtUpdate(), review);
  assert.deepEqual(live.scope.additions, ['D-5/切割']);
  assert.deepEqual(live.scope.endings, ['G-4/切割']);
  assert.deepEqual(live.scope.retained, ['G-4/过秤']);

  const approvedFromDraft = liveSnapshot(caseFrom('draft'), catalogAtDraft(), {
    ...review,
    version: 'V1',
  });
  const differences = compare(approvedFromDraft, live);
  assert.equal(differences.some((item) => item.includes('场址资格目录已改版')), true);
  assert.equal(differences.some((item) => item.includes('受理版本')), true);
  assert.equal(differences.some((item) => item.includes('拆分范围')), false);

  // 拆分范围本身变化也要单独触发失效，而不是只看版本号。
  const narrowed = { ...live, scope: { ...live.scope, endings: [] } };
  assert.equal(compare(approvedFromDraft, narrowed).some((item) => item.includes('拆分范围')), true);
});

test('复核页若要求终止未迁移工序，必须拦下', () => {
  const context = caseFrom('update');
  const plan = buildPlan(normalized, context, catalogAtUpdate());
  const review = {
    caseNumber: 'A92',
    change: 'C-112',
    version: 'V2',
    proposedSite: 'B-8',
    additions: [{ site: 'B-8', operation: '切割' }],
    endings: [
      { site: 'G-4', operation: '切割' },
      { site: 'G-4', operation: '过秤' },
    ],
    retained: [{ site: 'G-4', operation: '过秤' }],
  };
  const confirmation = confirmReview(plan, review, normalized);
  assert.equal(confirmation.ok, false);
  assert.equal(confirmation.problems.some((item) => item.includes('注销其他工序')), true);
  assert.equal(confirmation.problems.some((item) => item.includes('多个场址')), true);
});

test('复核页补上申请页没显示的旧址受理范围时，采用复核页的上下文', () => {
  const context = caseFrom('update');
  const plan = buildPlan(normalized, context, catalogAtUpdate());
  assert.equal(plan.endings.length, 0);
  const review = {
    caseNumber: 'A92',
    change: 'C-112',
    version: 'V2',
    proposedSite: 'D-5',
    additions: [{ site: 'D-5', operation: '切割' }],
    endings: [{ site: 'G-4', operation: '切割' }],
    retained: [{ operation: '过秤', site: 'G-4' }],
  };
  const confirmation = confirmReview(plan, review, normalized);
  assert.equal(confirmation.ok, true);
  assert.deepEqual(confirmation.endings, [{ site: 'G-4', operation: '切割', evidence: 'review' }]);
  assert.deepEqual(confirmation.retained, [{ site: 'G-4', operation: '过秤', evidence: 'review' }]);
  assert.equal(confirmation.adopted.some((item) => item.side === 'end'), true);
});

test('复核页没有旧址终止时停下，只补加半边不作为成对受理提交', () => {
  const context = caseFrom('update');
  const plan = buildPlan(normalized, context, catalogAtUpdate());
  const review = {
    caseNumber: 'A92',
    change: 'C-112',
    version: 'V2',
    proposedSite: 'B-8',
    additions: [{ site: 'B-8', operation: '切割' }],
    endings: [],
    retained: [{ operation: '过秤', site: 'G-4' }],
  };
  const confirmation = confirmReview(plan, review, normalized);
  assert.equal(confirmation.ok, false);
  assert.equal(confirmation.problems.some((item) => item.includes('缺少旧场址凭据')), true);
});

test('回执按变更编号区分已接收与未接收，并算出仍在外的部分', () => {
  const receiptHtml = source.routes.partial['GET /receipts/A92'].body;
  const receipt = parseReceiptText(receiptHtml.replace(/<[^>]+>/g, '\n').replace(/\n+/g, '\n'), 'C-112');
  assert.deepEqual(receipt.accepted.map((item) => `${item.site}/${item.operation}`), ['D-5/切割']);
  assert.deepEqual(receipt.outstanding.map((item) => `${item.site}/${item.operation}`), ['G-4/切割']);
  assert.equal(receipt.complete, false);

  const stillOpen = receiptOutstanding(receipt, [
    { site: 'D-5', operation: '切割', kind: 'add' },
    { site: 'G-4', operation: '切割', kind: 'end' },
    { site: 'B-8', operation: '切割', kind: 'add' },
  ]);
  assert.equal(stillOpen.some((item) => item.site === 'B-8'), true);

  const settled = parseReceiptText(
    source.routes.settled['GET /receipts/A92'].body.replace(/<[^>]+>/g, '\n').replace(/\n+/g, '\n'),
    'C-112',
  );
  assert.equal(settled.complete, true);
  assert.deepEqual(settled.retained, [{ site: 'G-4', operation: '过秤' }]);
});

test('待确认为回执不等于整单失败，剩余办理页只提供终止一边', () => {
  const pending = parseReceiptText(
    source.routes.common['GET /receipts/A92'].body.replace(/<[^>]+>/g, '\n').replace(/\n+/g, '\n'),
    'C-112',
  );
  assert.equal(pending.pending, true);
  assert.equal(pending.found, false);
  assert.equal(pending.complete, false);

  const remaining = parseRemainingText(
    source.routes.partial['GET /receipts/A92/remaining'].body.replace(/<[^>]+>/g, '\n').replace(/\n+/g, '\n'),
  );
  assert.deepEqual(remaining.endings, [{ site: 'G-4', operation: '切割' }]);
  assert.deepEqual(remaining.additions, []);
});

test('目录页表格解析保留名称与地址编号的不同实体', () => {
  const rows = [
    ['青港分部', 'B-7', 'R1', '切割、过秤', '2026-01-01 至 2027-01-01'],
    ['青港分部', 'B-8', 'R1', '切割', '2026-12-10 至 2027-01-01'],
  ];
  const entries = parseDirectoryRows(rows);
  assert.deepEqual(entries.map((entry) => entry.site), ['B-7', 'B-8']);
  assert.deepEqual(entries[0].operations, ['切割', '过秤']);
  assert.equal(entries[1].toExclusive, true);
});

test('变更资料缺字段或出现未知字段时拒绝建立会话', () => {
  assert.throws(() => normalizeAmendment({ ...amendment, change: undefined }), /缺少字段 changeNumber/);
  assert.throws(() => normalizeAmendment({ ...amendment, market: 17 }), /market 必须是字符串/);
  assert.throws(() => normalizeAmendment({ ...amendment, auditDay: '2026/12/08' }), /auditDay 必须是/);
  assert.throws(() => normalizeAmendment({ ...amendment, extra: 'x' }), /无法识别的字段 extra/);
  const aliased = normalizeAmendment(amendment);
  assert.equal(aliased.caseNumber, 'A92');
  assert.equal(aliased.changeNumber, 'C-112');
  assert.equal(aliased.casePath, '/cases/A92');
  assert.equal(aliased.receiptPath, '/receipts/A92');
});

test('来源服务的就绪探测仍可用', async (context) => {
  const server = createSource();
  context.after(() => server.close());
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const health = await fetch(`${base}/health`);
  assert.deepEqual(await health.json(), { status: 'ok' });
});
