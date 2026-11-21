import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { chromium } from 'playwright';
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
  const browser = await chromium.launch();
  context.after(() => browser.close());
  return {
    base: `http://127.0.0.1:${app.address().port}`,
    sourceUrl,
    browser,
    clock: async (step) => {
      const response = await fetch(`${sourceUrl}/_source_clock?step=${step}`, { method: 'PUT' });
      assert.equal(response.status, 200);
    },
  };
}

test('经办人在本地页面看到核自哪页、批准了什么、门户收了哪部分', async (context) => {
  const { base, browser, clock } = await boot(context);
  const page = await browser.newPage();
  await page.goto(base + '/');
  await page.getByRole('heading', { name: '场址补报代办台' }).waitFor();

  await page.getByRole('button', { name: '载入资料' }).click();
  await page.getByRole('button', { name: '核对目录与申请' }).click();
  await page.getByText('地址目录页').waitFor();
  await page.getByText('申请详情页').waitFor();

  await page.getByRole('button', { name: '查看复核页' }).click();
  await page.getByText('门户复核页').waitFor();
  const reviewTable = await page.locator('#evidence').innerText();
  assert.match(reviewTable, /B-7/);
  assert.match(reviewTable, /G-4/);
  assert.match(reviewTable, /过秤/);

  await page.getByLabel('经办人', { exact: true }).fill('周经办');
  await page.getByRole('button', { name: '按当前屏幕内容批准' }).click();
  await page.getByText('周经办').first().waitFor();
  const approvalText = await page.locator('#approval').innerText();
  assert.match(approvalText, /批准/);
  assert.match(approvalText, /B-7/);

  await page.getByRole('button', { name: '提交本次补报' }).click();
  await page.getByText('按申请号查回执').waitFor();
  const receiptText = await page.locator('#receipt').innerText();
  assert.match(receiptText, /尚未反馈|待确认|受理记录/);

  await clock('partial');
  await page.getByRole('button', { name: '按申请号查回执' }).click();
  await page.getByText('部分受理，可继续剩余事项').waitFor();
  const partialText = await page.locator('#receipt').innerText();
  assert.match(partialText, /D-5/);
  assert.match(partialText, /G-4/);

  await page.getByRole('button', { name: '读取剩余办理' }).click();
  await page.getByText('剩余事项待经办人确认').waitFor();
  const remainingText = await page.locator('#remaining').innerText();
  assert.match(remainingText, /G-4/);
  assert.match(remainingText, /尚未确认/);

  await page.getByLabel('确认经办人', { exact: true }).fill('吴经办');
  await page.getByRole('button', { name: '确认剩余事项' }).click();
  await page.locator('#remaining').getByText('吴经办').waitFor();
  const confirmed = await page.locator('#remaining').innerText();
  assert.match(confirmed, /吴经办/);
  assert.match(confirmed, /已受理范围与人工取消的意思随原申请保留/);

  const auditText = await page.locator('#audit').innerText();
  assert.match(auditText, /核对目录与申请/);
  assert.match(auditText, /经办人批准/);
  assert.match(auditText, /提交本次补报/);
  assert.match(auditText, /确认剩余事项/);

  assert.equal(await page.locator('html').getAttribute('lang'), 'zh-CN');
});

test('批准后目录改版时页面退回复核并禁用沿用原批准的提交', async (context) => {
  const { base, browser, clock } = await boot(context);
  const page = await browser.newPage();
  await page.goto(base + '/');
  await page.getByRole('button', { name: '载入资料' }).click();
  await page.getByRole('button', { name: '核对目录与申请' }).click();
  await page.getByRole('button', { name: '查看复核页' }).click();
  await page.getByLabel('经办人', { exact: true }).fill('郑经办');
  await page.getByRole('button', { name: '按当前屏幕内容批准' }).click();
  await page.getByRole('button', { name: '提交本次补报' }).waitFor();

  await clock('update');
  await page.getByRole('button', { name: '提交本次补报' }).click();
  await page.getByText('复核已失效，需重新确认').waitFor();
  const approvalText = await page.locator('#approval').innerText();
  assert.match(approvalText, /该批准已失效/);
  assert.match(approvalText, /受理版本/);
  assert.equal(await page.getByRole('button', { name: '提交本次补报' }).count(), 0);
  await page.getByRole('button', { name: '查看复核页' }).waitFor();
});
