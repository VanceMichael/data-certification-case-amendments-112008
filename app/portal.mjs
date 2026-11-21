import { createHash } from 'node:crypto';
import { chromium } from 'playwright';
import { PortalError } from './errors.mjs';

const clean = (value) => value.replace(/\r/g, '').trim();
const linesOf = (text) => clean(text).split('\n').map((line) => line.trim()).filter(Boolean);

export function digestText(text) {
  return createHash('sha256').update(clean(text).replace(/\s+/g, ' ')).digest('hex').slice(0, 16);
}

export function parseDirectoryRows(rows) {
  return rows.map(([name, site, market, operations, period]) => {
    const match = /^(\d{4}-\d{2}-\d{2})\s*至\s*(\d{4}-\d{2}-\d{2})$/.exec((period ?? '').trim());
    if (!match) throw new PortalError('directory-layout', `地址 ${site ?? '?'} 的生效区间无法识别`);
    return {
      name: name.trim(),
      site: site.trim(),
      market: market.trim(),
      operations: operations.split(/[、，,]/).map((item) => item.trim()).filter(Boolean),
      from: match[1],
      to: match[2],
      toExclusive: true,
    };
  });
}

export function parseCaseText(text) {
  const lines = linesOf(text);
  const body = lines.join('\n');
  const version = /受理版本\s*(V\d+)/.exec(body)?.[1];
  const marketMatch = /关联市场\s*([^\s，,]+)[，,]\s*审核日\s*(\d{4}-\d{2}-\d{2})/.exec(body);
  if (!version) throw new PortalError('case-layout', '申请页没有显示受理版本');
  if (!marketMatch) throw new PortalError('case-layout', '申请页没有显示关联市场与审核日');

  const acceptedOperations = [];
  const oldScope = /旧址\s*([A-Za-z0-9-]+)\s*已受理\s*([^\n。；;]+)/.exec(body);
  if (oldScope) {
    for (const operation of oldScope[2].split(/[、，,和及]/)) {
      const value = operation.replace(/[^一-鿿]/g, '').trim();
      if (value) acceptedOperations.push({ site: oldScope[1], operation: value });
    }
  }

  return {
    heading: lines[0] ?? '',
    version,
    market: marketMatch[1],
    auditDay: marketMatch[2],
    acceptedOperations,
    progress: {
      addAccepted: /补加[^\n。；;]*?(?:已收|已接收|已受理)/.test(body),
      endPending: /终止[^\n。；;]*?(?:仍待处理|待处理|尚未接收|未接收|未受理)/.test(body),
      settled: /补加[^\n。；;]*?终止[^\n。；;]*?均已(?:受理|接收)/.test(body),
    },
    reissuedDirectory: /(?:场址)?资格目录已改版|目录\s*已改版/.test(body),
    text: body,
  };
}

export function parseReviewText(text) {
  const lines = linesOf(text);
  const body = lines.join('\n');
  const correlation = /申请\s*([A-Za-z0-9-]+)\s*[，,]\s*变更\s*([A-Za-z0-9-]+)/.exec(body);
  if (!correlation) throw new PortalError('review-layout', '复核页没有列出申请号与变更编号');
  const proposed = /拟选场址\s*([^\n，,]*?)\s*[，,]\s*动作\s*([^\s，,。]+)/.exec(body);
  return {
    caseNumber: correlation[1],
    change: correlation[2],
    version: /受理版本\s*(V\d+)/.exec(body)?.[1] ?? null,
    proposedSite: proposed?.[1] || null,
    proposedAction: proposed?.[2] ?? null,
    additions: [...body.matchAll(/补加\s*([A-Za-z0-9-]+)\s*的\s*([^\s，,。]+)/g)]
      .map((match) => ({ site: match[1], operation: match[2] })),
    endings: [...body.matchAll(/终止\s*([A-Za-z0-9-]+)\s*的\s*([^\s，,。]+)/g)]
      .map((match) => ({ site: match[1], operation: match[2] })),
    retained: [...body.matchAll(/([^\s，,。]+?)\s*继续在\s*([A-Za-z0-9-]+)\s*审核/g)]
      .map((match) => ({ operation: match[1], site: match[2] })),
    text: body,
  };
}

export function parseReceiptText(text, change) {
  const lines = linesOf(text);
  const body = lines.join('\n');
  const items = [];
  for (const line of lines) {
    if (!line.startsWith(change)) continue;
    const negative = /尚未|未接收|未受理|待处理|待接收|待确认|退回|拒收/.test(line);
    const accepted = !negative && /已接收|已受理|已收/.test(line);
    const addition = /补加\s*([A-Za-z0-9-]+)\s*([^\s，,。]*)/.exec(line);
    const ending = /([A-Za-z0-9-]+)\s*([^\s，,。]*?)终止/.exec(line);
    if (addition) items.push({ line, accepted, kind: 'add', site: addition[1], operation: addition[2] });
    else if (ending) items.push({ line, accepted, kind: 'end', site: ending[1], operation: ending[2] });
    else items.push({ line, accepted, kind: 'other' });
  }
  const accepted = items.filter((item) => item.accepted && item.kind !== 'other');
  const outstanding = items.filter((item) => !item.accepted && item.kind !== 'other');
  return {
    change,
    displayedChange: /([A-Z]-\d+)/.exec(body)?.[1] ?? null,
    found: items.length > 0,
    pending: /尚未反馈|尚未回传|待确认|待反馈|处理中/.test(body) && !items.length,
    items,
    accepted,
    outstanding,
    retained: [...body.matchAll(/([A-Za-z0-9-]+)\s+([^\s，,。]+?)原受理仍有效/g)]
      .map((match) => ({ site: match[1], operation: match[2] })),
    complete: outstanding.length === 0
      && ['add', 'end'].every((kind) => accepted.some((item) => item.kind === kind)),
    text: body,
  };
}

export function parseRemainingText(text) {
  const lines = linesOf(text);
  const body = lines.join('\n');
  const ending = /仅终止\s*([A-Za-z0-9-]+)\s*([^\s，,。]+)/.exec(body);
  return {
    heading: lines[0] ?? '',
    version: /受理版本\s*(V\d+)/.exec(body)?.[1] ?? null,
    endings: ending ? [{ site: ending[1], operation: ending[2] }] : [],
    additions: [],
    text: body,
  };
}

export class Portal {
  constructor(sourceUrl) {
    this.sourceUrl = sourceUrl.replace(/\/$/, '');
    this.browser = null;
  }

  async launch() {
    if (!this.browser) this.browser = await chromium.launch();
    return this;
  }

  async close() {
    await this.browser?.close().catch(() => {});
    this.browser = null;
  }

  url(path) {
    return new URL(path, `${this.sourceUrl}/`).href;
  }

  async withPage(run) {
    await this.launch();
    const context = await this.browser.newContext();
    const page = await context.newPage();
    page.setDefaultTimeout(10_000);
    try {
      return await run(page);
    } finally {
      await context.close().catch(() => {});
    }
  }

  mainText(page) {
    return page.locator('main').innerText();
  }

  async readDirectory(path) {
    return this.withPage(async (page) => {
      const response = await page.goto(this.url(path), { waitUntil: 'domcontentloaded' });
      if (response?.status() !== 200) {
        throw new PortalError('directory-unavailable', `目录页返回 ${response?.status() ?? '无响应'}`);
      }
      const rows = await page.locator('table tbody tr').evaluateAll((elements) =>
        elements.map((row) => [...row.querySelectorAll('td')].map((cell) => cell.innerText.trim())));
      if (!rows.length) throw new PortalError('directory-layout', '地址目录页没有数据行');
      const text = await this.mainText(page);
      return {
        url: page.url(),
        capturedAt: new Date().toISOString(),
        entries: parseDirectoryRows(rows),
        text,
        digest: digestText(text),
      };
    });
  }

  async readCase(path) {
    return this.withPage(async (page) => {
      const response = await page.goto(this.url(path), { waitUntil: 'domcontentloaded' });
      if (response?.status() !== 200) {
        throw new PortalError('case-unavailable', `申请页返回 ${response?.status() ?? '无响应'}`);
      }
      const text = await this.mainText(page);
      return { url: page.url(), capturedAt: new Date().toISOString(), text, digest: digestText(text), context: parseCaseText(text) };
    });
  }

  async readReceipt(path, change) {
    return this.withPage(async (page) => {
      const response = await page.goto(this.url(path), { waitUntil: 'domcontentloaded' });
      if (response?.status() !== 200) {
        throw new PortalError('receipt-unavailable', `回执页返回 ${response?.status() ?? '无响应'}`);
      }
      const text = await this.mainText(page);
      const links = await page.locator('a[href]').evaluateAll((anchors) =>
        anchors.map((anchor) => ({ text: anchor.innerText.trim(), href: anchor.href })));
      return {
        url: page.url(),
        lookedUpAt: new Date().toISOString(),
        ...parseReceiptText(text, change),
        remaining: links.find((link) => /剩余|继续/.test(link.text)) ?? null,
      };
    });
  }

  async inspectReview({ casePath, change, site, action = 'both' }) {
    return this.withPage((page) => this.fillReview(page, { casePath, change, site, action }));
  }

  async fillReview(page, { casePath, change, site, action }) {
    const response = await page.goto(this.url(casePath), { waitUntil: 'domcontentloaded' });
    if (response?.status() !== 200) {
      throw new PortalError('case-unavailable', `申请页返回 ${response?.status() ?? '无响应'}`);
    }
    const caseText = await this.mainText(page);
    const caseData = {
      url: page.url(),
      capturedAt: new Date().toISOString(),
      text: caseText,
      digest: digestText(caseText),
      context: parseCaseText(caseText),
    };
    const form = page.locator('main form').first();
    if (!(await form.count())) throw new PortalError('review-form', '申请页没有复核表单');
    await page.locator('main form input[name="change"]').fill(change);
    await page.locator('main form input[name="site"]').fill(site);
    await page.locator('main form select[name="action"]').selectOption(action);
    const wait = page.waitForResponse((item) => item.request().method() === 'POST' && item.url().includes('/review'));
    await page.getByRole('button', { name: '查看复核页', exact: true }).click();
    const posted = await wait;
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    if (posted.status() !== 200) {
      throw new PortalError('review-unavailable', `复核页返回 ${posted.status()}`);
    }
    const text = await this.mainText(page);
    return {
      url: page.url(),
      capturedAt: new Date().toISOString(),
      case: caseData,
      review: parseReviewText(text),
      text,
      digest: digestText(text),
    };
  }

  // 提交前重新打开复核页，确认屏幕内容仍与批准时逐字一致，才点击提交。
  async submitReview({ casePath, change, site, action, expectedDigest, buttonName = '提交本次补报' }) {
    return this.withPage(async (page) => {
      const fresh = await this.fillReview(page, { casePath, change, site, action });
      if (expectedDigest && fresh.digest !== expectedDigest) {
        throw new PortalError('review-changed', '复核页内容与批准时不一致，已停止提交',
          { expectedDigest, actualDigest: fresh.digest, review: fresh.review });
      }
      const responsePromise = page.waitForResponse((item) => item.request().method() === 'POST');
      await page.getByRole('button', { name: buttonName, exact: true }).click();
      const response = await responsePromise;
      await page.waitForLoadState('domcontentloaded').catch(() => {});
      return {
        status: response.status(),
        url: page.url(),
        text: await page.locator('body').innerText(),
        requestBody: response.request().postData() ?? '',
        submittedReview: fresh.review,
        submittedDigest: fresh.digest,
        at: new Date().toISOString(),
      };
    });
  }

  async readRemaining(url) {
    return this.withPage(async (page) => {
      const response = await page.goto(url, { waitUntil: 'domcontentloaded' });
      if (response?.status() !== 200) {
        throw new PortalError('remaining-unavailable', `剩余办理页返回 ${response?.status() ?? '无响应'}`);
      }
      const text = await this.mainText(page);
      const fields = await page.locator('main form').first().evaluate((form) =>
        [...form.elements].filter((element) => element.name).map((element) => ({
          name: element.name,
          value: element.value,
          type: element.type,
        })));
      return {
        url: page.url(),
        capturedAt: new Date().toISOString(),
        ...parseRemainingText(text),
        fields,
        text,
        digest: digestText(text),
      };
    });
  }

  async submitRemaining({ url, expectedDigest, buttonName = '提交剩余终止' }) {
    return this.withPage(async (page) => {
      const response = await page.goto(url, { waitUntil: 'domcontentloaded' });
      if (response?.status() !== 200) {
        throw new PortalError('remaining-unavailable', `剩余办理页返回 ${response?.status() ?? '无响应'}`);
      }
      const text = await this.mainText(page);
      const digest = digestText(text);
      if (expectedDigest && digest !== expectedDigest) {
        throw new PortalError('remaining-changed', '剩余办理页与批准时不一致，已停止提交',
          { expectedDigest, actualDigest: digest });
      }
      const responsePromise = page.waitForResponse((item) => item.request().method() === 'POST');
      await page.getByRole('button', { name: buttonName, exact: true }).click();
      const posted = await responsePromise;
      await page.waitForLoadState('domcontentloaded').catch(() => {});
      return {
        status: posted.status(),
        url: page.url(),
        text: await page.locator('body').innerText(),
        requestBody: posted.request().postData() ?? '',
        submittedDigest: digest,
        at: new Date().toISOString(),
      };
    });
  }
}
