import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createSource } from '../sources/source.mjs';
import { createApp } from '../app/server.mjs';

const amendment = JSON.parse(readFileSync(new URL('../fixtures/amendment.json', import.meta.url)));

async function boot(context) {
  const source = createSource();
  context.after(() => source.close());
  source.listen(0, '127.0.0.1');
  await once(source, 'listening');
  const sourceUrl = `http://127.0.0.1:${source.address().port}`;

  const app = createApp({ sourceUrl });
  context.after(() => app.close());
  app.listen(0, '127.0.0.1');
  await once(app, 'listening');
  const base = `http://127.0.0.1:${app.address().port}`;

  const call = async (path, body) => {
    const response = await fetch(base + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    });
    return { status: response.status, payload: await response.json() };
  };
  const clock = async (step) => {
    const response = await fetch(`${sourceUrl}/_source_clock?step=${step}`, { method: 'PUT' });
    assert.equal(response.status, 200);
    return response.json();
  };
  const calls = async () => (await fetch(`${sourceUrl}/_source_calls`)).json();
  return { sourceUrl, base, call, clock, calls };
}

test('代办在草稿阶段成对复核后提交，待回执时按申请号查进度', async (context) => {
  const { call, clock, calls } = await boot(context);
  assert.equal((await call('/api/session', { amendment })).status, 200);

  const inspected = await call('/api/inspect');
  assert.equal(inspected.payload.result.ok, true);
  assert.equal(inspected.payload.state.caseContext.version, 'V1');

  const reviewed = await call('/api/review');
  assert.equal(reviewed.payload.result.ok, true);
  assert.deepEqual(reviewed.payload.state.review.additions, [{ site: 'B-7', operation: '切割' }]);
  assert.deepEqual(reviewed.payload.state.review.endings, [{ site: 'G-4', operation: '切割' }]);
  assert.equal(reviewed.payload.state.stage, 'reviewed');

  const approved = await call('/api/approve', { approver: '李经办' });
  assert.equal(approved.payload.state.stage, 'approved');
  assert.equal(approved.payload.state.approval.approver, '李经办');

  const submitted = await call('/api/submit');
  assert.equal(submitted.payload.result.outcome, 'pending');
  assert.equal(submitted.payload.state.stage, 'pending');
  assert.match(submitted.payload.state.status, /等待/);

  const posted = (await calls()).filter((entry) => entry.path === '/cases/A92/apply');
  assert.equal(posted.length, 1);
  assert.match(posted[0].body, /change=C-112/);
  assert.match(posted[0].body, /version=V1/);

  const receipt = await call('/api/receipt');
  assert.equal(receipt.payload.result.outcome, 'pending');
  assert.equal(receipt.payload.state.receipt.pending, true);

  await clock('update');
  const second = await call('/api/submit');
  assert.equal(second.status, 400);
  assert.match(second.payload.error.message, /不能整单再提交/);
  assert.equal((await calls()).filter((entry) => entry.path === '/cases/A92/apply').length, 1);
});

test('目录或申请版本在批准后变化时退回复核，不沿用原批准', async (context) => {
  const { call, clock, calls } = await boot(context);
  await call('/api/session', { amendment });
  await call('/api/inspect');
  await call('/api/review');
  await call('/api/approve', { approver: '王经办' });

  await clock('update');
  const submitted = await call('/api/submit');
  assert.equal(submitted.status, 409);
  assert.match(submitted.payload.error.message, /复核已失效/);
  assert.equal(submitted.payload.state.stage, 'stale');
  assert.equal(submitted.payload.state.approval.invalidated, true);
  assert.equal((await calls()).filter((entry) => entry.path === '/cases/A92/apply').length, 0);

  const reReviewed = await call('/api/review');
  assert.equal(reReviewed.payload.result.ok, true);
  assert.equal(reReviewed.payload.state.review.caseVersion, 'V2');
  assert.deepEqual(reReviewed.payload.state.review.additions, [{ site: 'D-5', operation: '切割' }]);

  await call('/api/approve', { approver: '王经办' });
  const resubmitted = await call('/api/submit');
  assert.equal(resubmitted.payload.result.outcome, 'pending');
  assert.equal((await calls()).filter((entry) => entry.path === '/cases/A92/apply').length, 1);
});

test('门户已受理补加时不再整单提交，从原申请继续剩余终止', async (context) => {
  const { call, clock, calls } = await boot(context);
  await clock('partial');
  await call('/api/session', { amendment });
  await call('/api/inspect');
  const reviewed = await call('/api/review');
  assert.equal(reviewed.payload.result.reused, true);
  assert.equal(reviewed.payload.state.stage, 'partial');
  assert.deepEqual(reviewed.payload.state.receipt.accepted.map((item) => `${item.site}/${item.operation}`), ['D-5/切割']);
  assert.deepEqual(reviewed.payload.state.receipt.outstanding.map((item) => `${item.site}/${item.operation}`), ['G-4/切割']);
  assert.equal((await calls()).filter((entry) => entry.path === '/cases/A92/apply').length, 0);

  const repeated = await call('/api/submit');
  assert.equal(repeated.status, 400);
  assert.match(repeated.payload.error.message, /不能整单再提交/);

  const continuation = await call('/api/continuation');
  assert.equal(continuation.payload.result.ok, true);
  assert.deepEqual(continuation.payload.state.remaining.offered, ['G-4/切割']);
  assert.deepEqual(continuation.payload.state.remaining.missing, []);

  const unconfirmed = await call('/api/continuation/submit');
  assert.equal(unconfirmed.status, 400);
  assert.match(unconfirmed.payload.error.message, /还没有经办人确认/);

  await call('/api/continuation/approve', { approver: '赵经办' });
  const submittedRemaining = await call('/api/continuation/submit');
  assert.equal(submittedRemaining.payload.result.outcome, 'pending');
  assert.equal(submittedRemaining.payload.state.stage, 'continuation-pending');

  await clock('settled');
  const finished = await call('/api/receipt');
  assert.equal(finished.payload.result.outcome, 'settled');
  assert.equal(finished.payload.state.stage, 'settled');
  assert.deepEqual(finished.payload.state.receipt.retained, [{ site: 'G-4', operation: '过秤' }]);

  // 整单从未重新提交过；只提交过一次剩余终止。
  const applyPosts = (await calls()).filter((entry) => entry.path === '/cases/A92/apply');
  assert.equal(applyPosts.length, 1);
  assert.match(applyPosts[0].body, /scope=end/);
  assert.doesNotMatch(applyPosts[0].body, /action=both/);
  assert.doesNotMatch(applyPosts[0].body, /version=/);
});

test('目录没有有效新场址时停在可继续办理的状态并说明缺哪边', async (context) => {
  const { call, clock } = await boot(context);
  await clock('update');
  await call('/api/session', {
    amendment: { ...amendment, auditDay: '2027-03-01', alternativeSite: 'E-9' },
  });
  const inspected = await call('/api/inspect');
  assert.equal(inspected.payload.result.ok, false);
  const state = inspected.payload.state;
  assert.equal(state.stage, 'blocked');
  assert.equal(state.blocked[0].side, 'add');
  assert.match(state.blocked[0].message, /没有在 2027-03-01/);

  const reviewed = await call('/api/review');
  assert.equal(reviewed.payload.result.ok, false);
  assert.equal(reviewed.payload.state.stage, 'blocked');
});

test('未迁移工序不能被顺手注销，门户提出时停止提交', async (context) => {
  const { call, calls } = await boot(context);
  await call('/api/session', {
    amendment: { ...amendment, unaffectedOperation: '不存在工序' },
  });
  await call('/api/inspect');
  const reviewed = await call('/api/review');
  assert.equal(reviewed.payload.result.ok, true);
  assert.deepEqual(reviewed.payload.state.review.retained, [{ site: 'G-4', operation: '过秤' }]);
  await call('/api/approve', { approver: '钱经办' });
  await call('/api/submit');
  const posts = (await calls()).filter((entry) => entry.path === '/cases/A92/apply');
  assert.equal(posts.length, 1);
  // 门户的表单只有 both / add / end 三种动作，不能夹带“终止其他工序”的单独请求。
  const forms = (await calls()).filter((entry) => entry.path === '/cases/A92/review');
  assert.equal(forms.length, 2);
  assert.equal(forms.every((entry) => /action=both/.test(entry.body)), true);
});

test('回执记录的变更编号与原变更不一致时留下不一致记录', async (context) => {
  const { call } = await boot(context);
  await call('/api/session', { amendment });
  await call('/api/inspect');
  await call('/api/review');
  await call('/api/approve', { approver: '孙经办' });
  await call('/api/submit');
  const state = (await call('/api/receipt')).payload.state;
  assert.equal(state.receipt.displayedChange, 'C-112');
  assert.equal(state.audit.some((entry) => entry.kind === 'receipt-mismatch'), false);
});
