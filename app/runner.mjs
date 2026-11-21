import { PortalError } from './errors.mjs';
import { compare, liveSnapshot } from './ledger.mjs';
import {
  buildPlan,
  confirmReview,
  directoryFingerprint,
  planKey,
  receiptOutstanding,
} from './rules.mjs';

const ACTION_LABEL = { both: '补加并终止', add: '仅补加', end: '仅终止' };

export class CaseRunner {
  constructor(portal, amendment) {
    this.portal = portal;
    this.amendment = amendment;
    this.sequence = 0;
    this.state = {
      stage: 'new',
      status: '待核对资料',
      message: '已载入企业提供的变更资料，等待核对门户。',
      directory: null,
      context: null,
      plan: null,
      review: null,
      live: null,
      approval: null,
      submission: null,
      receipt: null,
      remaining: null,
      continuationApproval: null,
      blocked: null,
      preexistingPartial: null,
      audit: [],
    };
  }

  get value() {
    return this.state;
  }

  set(patch) {
    this.state = { ...this.state, ...patch };
  }

  log(kind, detail = {}) {
    this.sequence += 1;
    this.state = { ...this.state, audit: [...this.state.audit, { seq: this.sequence, at: new Date().toISOString(), kind, detail }] };
  }

  // 每次重新核对都读门户当前页面，不沿用上一次读到的目录或申请状态。
  async readSources() {
    const { amendment } = this;
    const directory = await this.portal.readDirectory(amendment.directoryPath);
    const withFingerprint = { ...directory, fingerprint: directoryFingerprint(directory) };
    const caseData = await this.portal.readCase(amendment.casePath);
    const plan = buildPlan(amendment, caseData.context, withFingerprint);
    const progress = caseData.context.progress;
    const preexistingPartial = progress.addAccepted && !progress.settled
      ? { addAccepted: true, endPending: progress.endPending, version: caseData.context.version }
      : null;
    return { directory: withFingerprint, caseData, plan, preexistingPartial };
  }

  // 第一步：从目录页核新场址，从申请页读已受理范围，判断手上是否两边都有凭据。
  async inspect() {
    const { directory, caseData, plan, preexistingPartial } = await this.readSources();

    this.set({
      directory,
      context: { ...caseData, context: caseData.context },
      plan,
      review: null,
      live: null,
      approval: null,
      submission: null,
      receipt: null,
      remaining: null,
      continuationApproval: null,
      blocked: null,
      preexistingPartial,
      stage: 'inspected',
    });
    this.log('inspect', {
      directory: { url: directory.url, digest: directory.digest, at: directory.capturedAt },
      case: { url: caseData.url, digest: caseData.digest, version: caseData.context.version },
      resolution: plan.resolution,
      scope: planKey(plan),
      unconfirmed: plan.unconfirmed.map((item) => item.side),
    });

    if (!plan.additions.length) {
      const missing = plan.missing.map((item) => ({ ...item, from: 'directory' }));
      this.set({
        stage: 'blocked',
        status: '停在可继续办理的状态：缺新场址凭据',
        message: `目录页无法核定新场址，${plan.missing[0]?.message ?? ''}。补齐后可重新核对。`,
        blocked: missing,
      });
      return { ok: false, blocked: missing, plan };
    }

    this.set({
      status: '目录已核，可查看复核页',
      message: plan.unconfirmed.length
        ? '申请页未显示全部旧址受理范围，需以复核页显示的受理上下文确认另一边。'
        : '目录与申请受理范围可以配对，等待复核。',
    });
    return { ok: true, plan };
  }

  // 第二步：在门户打开复核页，读回门户当前版本与实际拆分范围。
  async openReview() {
    if (!this.state.plan) {
      const inspected = await this.inspect();
      if (inspected.blocked) return { ok: false, blocked: inspected.blocked, review: null };
    }
    // 复核前重读目录与申请页，保证批准绑定的是门户此刻的版本。
    const { directory, caseData, plan, preexistingPartial } = await this.readSources();
    this.set({ directory, context: { ...caseData, context: caseData.context }, plan, preexistingPartial });
    if (!plan.additions.length) {
      const blocked = plan.missing.map((item) => ({ ...item, from: 'directory' }));
      this.set({
        stage: 'blocked',
        status: '停在可继续办理的状态：缺新场址凭据',
        message: plan.missing[0]?.message ?? '目录页无法核定新场址。',
        blocked,
      });
      return { ok: false, blocked, review: null };
    }
    if (preexistingPartial && !this.state.submission) {
      return this.hydrateFromPortal();
    }
    const amendment = this.amendment;
    // 业务意图是对称的：补加新场址的同时终止旧址。门户是否接受两边，看复核页。
    const action = 'both';
    const site = plan.additions[0].site;

    let reviewPage = await this.portal.inspectReview({
      casePath: amendment.casePath,
      change: amendment.changeNumber,
      site,
      action,
    });
    let confirmation = confirmReview(plan, reviewPage.review, amendment);

    // 门户可能把录入的地址改写成另一个有效实体；以它的展示为准重开一次，让屏幕自洽。
    if (confirmation.ok && confirmation.additions.length && confirmation.additions[0].site !== site) {
      reviewPage = await this.portal.inspectReview({
        casePath: amendment.casePath,
        change: amendment.changeNumber,
        site: confirmation.additions[0].site,
        action,
      });
      confirmation = confirmReview(plan, reviewPage.review, amendment);
    }
    const confirmedPlan = {
      ...plan,
      additions: confirmation.additions,
      endings: confirmation.endings,
      retained: confirmation.retained,
    };
    this.set({ review: reviewPage, plan: confirmedPlan });
    this.log('review', {
      url: reviewPage.url,
      digest: reviewPage.digest,
      caseVersion: reviewPage.case.context.version,
      reviewVersion: reviewPage.review.version,
      requestedAction: ACTION_LABEL[action],
      proposedSite: reviewPage.review.proposedSite,
      shown: planKey(reviewPage.review),
      adopted: confirmation.adopted,
      ignored: confirmation.ignored,
      problems: confirmation.problems,
      warnings: confirmation.warnings,
      divergence: plan.resolution?.divergence ?? null,
    });

    if (!confirmation.ok) {
      const sides = confirmation.problems.map((text) => ({ side: text.includes('终') ? 'end' : 'add', message: text }));
      this.set({
        stage: 'blocked',
        status: '停在可继续办理的状态：复核范围不完整或越界',
        message: `${confirmation.problems.join('；')}。补齐凭据后可重新核对，不会先提交半边。`,
        blocked: sides,
        live: null,
        approval: null,
      });
      return { ok: false, blocked: sides, problems: confirmation.problems, review: reviewPage.review };
    }

    const live = liveSnapshot(reviewPage.case.context, this.state.directory, {
      ...reviewPage.review,
      additions: confirmedPlan.additions,
      endings: confirmedPlan.endings,
      retained: confirmedPlan.retained,
    });
    live.reviewDigest = reviewPage.digest;
    live.reviewUrl = reviewPage.url;
    live.action = action;
    this.set({
      live,
      approval: null,
      stage: 'reviewed',
      status: '待经办人复核',
      message: `复核页受理版本 ${reviewPage.review.version ?? reviewPage.case.context.version}，屏幕上是补加 ${confirmedPlan.additions.map((item) => item.site).join('、') || '无'}、终止 ${confirmedPlan.endings.map((item) => item.site).join('、') || '无'}。`,
      blocked: null,
    });
    return { ok: true, review: reviewPage.review, plan: confirmedPlan, ignored: confirmation.ignored };
  }

  // 门户已在本次会话之前受理了补加：不重开复核，直接从原申请读取剩余事项。
  async hydrateFromPortal() {
    let receipt;
    try {
      receipt = await this.portal.readReceipt(this.amendment.receiptPath, this.amendment.changeNumber);
    } catch (error) {
      this.set({
        stage: 'pending',
        status: '门户显示补加已受理，回执页暂不可读',
        message: '门户申请页显示补加已受理；回执页暂不可读，请稍后按申请号与变更编号再查。',
      });
      this.log('receipt-error', { message: error.message });
      return { ok: false, reused: true, outcome: 'unknown' };
    }

    const additions = receipt.accepted
      .filter((item) => item.kind === 'add')
      .map((item) => ({ site: item.site, operation: item.operation, evidence: 'receipt' }));
    const endings = receipt.outstanding
      .filter((item) => item.kind === 'end')
      .map((item) => ({ site: item.site, operation: item.operation, evidence: 'receipt' }));
    const retained = receipt.retained.map((item) => ({ ...item, evidence: 'receipt' }));
    const plan = { ...this.state.plan, additions, endings, retained };
    const outstanding = receiptOutstanding(receipt, [
      ...additions.map((item) => ({ ...item, kind: 'add' })),
      ...endings.map((item) => ({ ...item, kind: 'end' })),
    ]);
    const complete = receipt.complete && outstanding.length === 0;

    this.set({
      plan,
      review: null,
      live: null,
      approval: null,
      receipt: { receipt, expected: [...additions, ...endings], accepted: receipt.accepted, outstanding, complete, pending: receipt.pending },
      stage: complete ? 'settled' : 'partial',
      status: complete ? '已全部受理' : '门户已受理补加，终止仍待继续',
      message: complete
        ? '门户回执显示补加与终止均已受理，无需再提交。'
        : '门户申请页显示本次补加已被受理、终止仍待处理；不会整单再提，未完成的一边从原申请继续。',
    });
    this.log('reuse', {
      version: this.state.context?.context?.version,
      accepted: receipt.accepted,
      outstanding,
      retained: receipt.retained,
    });
    return { ok: complete, reused: true, outcome: complete ? 'settled' : 'partial', receipt };
  }

  // 第三步：经办人批准的是屏幕上这份内容，摘要绑定页面文字。
  approve(approver) {
    const { review, live } = this.state;
    if (!review || !live) throw new PortalError('not-approved', '还没有复核页可供批准');
    this.set({
      stage: 'approved',
      status: '已批准，可提交',
      message: `经办人 ${approver} 已批准受理版本 ${live.reviewVersion} 的屏幕范围。`,
      approval: {
        approver,
        at: new Date().toISOString(),
        snapshot: structuredClone(live),
        reviewDigest: review.digest,
        scope: structuredClone(live.scope),
        reviewUrl: review.url,
        caseUrl: review.case.url,
        directoryUrl: this.state.directory.url,
      },
    });
    this.log('approve', {
      approver,
      digest: review.digest,
      url: review.url,
      scope: live.scope,
      directoryDigest: live.directoryFingerprint,
    });
    return this.state.approval;
  }

  // 提交前重读资格目录与申请状态；任何一项变化都退回，不沿用原批准。
  async requireCurrentApproval() {
    const { approval } = this.state;
    if (!approval) throw new PortalError('not-approved', '经办人尚未批准复核页内容');
    if (approval.invalidated) throw new PortalError('stale-approval', '复核已失效，请重新核对并批准');

    const directory = await this.portal.readDirectory(this.amendment.directoryPath);
    const freshCase = await this.portal.readCase(this.amendment.casePath);
    const differences = [];
    if (directoryFingerprint(directory) !== approval.snapshot.directoryFingerprint) {
      differences.push('场址资格目录已改版');
    }
    differences.push(...compare(approval.snapshot, {
      ...approval.snapshot,
      caseVersion: freshCase.context.version,
      market: freshCase.context.market,
      auditDay: freshCase.context.auditDay,
    }));
    if (differences.length) {
      this.invalidate([...new Set(differences)]);
      throw new PortalError('stale-approval', `复核已失效：${[...new Set(differences)].join('；')}`);
    }
    return approval;
  }

  invalidate(differences) {
    this.set({
      stage: 'stale',
      status: '复核已失效，需重新确认',
      message: `复核已失效：${differences.join('；')}。请重新查看复核页并再次批准。`,
      approval: this.state.approval ? { ...this.state.approval, invalidated: true, differences } : null,
    });
    this.log('stale', { differences });
  }

  async submit() {
    if (this.state.submission) {
      throw new PortalError('already-submitted',
        '本次变更已经提交过，不能整单再提交；未完成部分请从原申请的剩余办理入口继续');
    }
    if (this.state.preexistingPartial) {
      throw new PortalError('already-partial',
        '门户已受理本次补加，不能整单再提交；未完成的终止请从原申请继续办理');
    }
    const approval = await this.requireCurrentApproval();
    const { amendment } = this;
    const { review, plan } = this.state;
    const site = plan.additions[0]?.site ?? amendment.alternativeSite;
    const submission = await this.portal.submitReview({
      casePath: amendment.casePath,
      change: amendment.changeNumber,
      site,
      action: approval.snapshot.action ?? 'both',
      expectedDigest: approval.reviewDigest,
    });
    this.set({
      submission,
      stage: 'submitted',
      status: '已提交，等待回执',
      message: '已提交，正在按申请号与门户显示的变更编号查询受理记录。',
    });
    this.log('submit', {
      status: submission.status,
      requestBody: submission.requestBody,
      submittedDigest: submission.submittedDigest,
      approvedDigest: approval.reviewDigest,
      reopenedReviewUrl: review.url,
    });
    return this.syncReceipt(submission);
  }

  async refreshReceipt() {
    if (!this.state.submission) throw new PortalError('not-submitted', '还没有可查询的提交');
    return this.syncReceipt(this.state.submission);
  }

  expectedOperations() {
    const { plan } = this.state;
    return [
      ...plan.additions.map((item) => ({ ...item, kind: 'add' })),
      ...plan.endings.map((item) => ({ ...item, kind: 'end' })),
    ];
  }

  // 第四步：按申请号与门户显示的变更编号查受理记录，不凭提交页猜结果。
  async syncReceipt(submission) {
    let receipt;
    try {
      receipt = await this.portal.readReceipt(this.amendment.receiptPath, this.amendment.changeNumber);
    } catch (error) {
      this.set({
        stage: this.state.stage === 'settled' ? 'settled' : 'pending',
        status: '已提交，回执页暂不可读',
        message: '提交已发出，但回执页暂不可读；请稍后按申请号与变更编号再查。',
        receipt: null,
      });
      this.log('receipt-error', { message: error.message });
      return { ok: false, outcome: 'unknown', message: '提交已发出，但回执页暂不可读，请稍后重试查询' };
    }

    if (receipt.displayedChange && receipt.displayedChange !== this.amendment.changeNumber) {
      this.log('receipt-mismatch', { expected: this.amendment.changeNumber, displayed: receipt.displayedChange });
    }
    // 已受理到哪一部分以门户回执列出的为准；补加若被门户换到另一有效实体，也从回执采纳。
    const acceptedAdds = receipt.accepted
      .filter((item) => item.kind === 'add')
      .map((item) => ({ site: item.site, operation: item.operation, evidence: 'receipt' }));
    const acceptedEnds = receipt.accepted
      .filter((item) => item.kind === 'end')
      .map((item) => ({ site: item.site, operation: item.operation, evidence: 'receipt' }));
    const receiptEnds = receipt.outstanding
      .filter((item) => item.kind === 'end')
      .map((item) => ({ site: item.site, operation: item.operation, evidence: 'receipt' }));
    if (acceptedAdds.length || acceptedEnds.length || receiptEnds.length) {
      const plan = { ...this.state.plan };
      if (acceptedAdds.length) plan.additions = acceptedAdds;
      if (acceptedEnds.length) plan.endings = acceptedEnds;
      if (receiptEnds.length) plan.endings = receiptEnds;
      if (receipt.retained.length) plan.retained = receipt.retained.map((item) => ({ ...item, evidence: 'receipt' }));
      this.set({ plan });
    }
    const outstanding = receiptOutstanding(receipt, this.expectedOperations());
    const complete = receipt.complete && outstanding.length === 0;
    const summary = {
      receipt,
      submission,
      expected: this.expectedOperations(),
      accepted: receipt.accepted,
      outstanding,
      complete,
      pending: receipt.pending || (!receipt.found && submission?.status >= 500),
    };
    this.set({ receipt: summary });

    if (complete) {
      this.set({ status: '已全部受理', stage: 'settled', message: '回执确认补加与终止均已被受理。' });
      this.log('receipt', { outcome: 'settled', accepted: receipt.accepted, retained: receipt.retained });
      return { ok: true, outcome: 'settled', summary };
    }
    if (summary.pending) {
      this.set({
        status: '已提交，等待受理中心回传回执',
        stage: 'pending',
        message: '门户记录仍是待确认状态，尚未显示本次回执；可按申请号与变更编号重查。',
      });
      this.log('receipt', { outcome: 'pending', displayedChange: receipt.displayedChange });
      return { ok: false, outcome: 'pending', summary };
    }

    this.set({
      status: '部分受理，可继续剩余事项',
      stage: 'partial',
      message: `门户只接收了一部分（已接收 ${receipt.accepted.length} 项），未完成部分须从原申请继续，不能整单重提。`,
    });
    this.log('receipt', {
      outcome: 'partial',
      accepted: receipt.accepted,
      outstanding,
      retained: receipt.retained,
    });
    return { ok: false, outcome: 'partial', summary };
  }

  // 部分受理后从原申请继续：只补未完成的一边，保留已受理范围和人工取消的意思。
  async prepareContinuation() {
    const receipt = this.state.receipt?.receipt;
    if (!receipt?.remaining) throw new PortalError('no-continuation', '回执页没有提供继续办理的入口');
    const remaining = await this.portal.readRemaining(receipt.remaining.href);
    const stillNeeded = (this.state.receipt.outstanding ?? [])
      .map((item) => `${item.site}/${item.operation}`)
      .sort();
    const offered = planKey(remaining);
    const offeredKeys = [...offered.endings, ...offered.additions];

    if (remaining.version && this.state.context?.context?.version === remaining.version) {
      this.log('continuation-note', { note: '继续页与申请页版本一致' });
    }
    const collateral = remaining.endings.filter((item) => item.operation !== this.amendment.operation);
    if (collateral.length) {
      throw new PortalError('collateral',
        `继续页包含未迁移工序 ${collateral.map((item) => item.operation).join('、')} 的终止，已停止`);
    }
    if (remaining.additions.length) {
      throw new PortalError('continuation-scope', '继续页包含新的补加动作，与本变更无关，已停止');
    }
    const changeField = remaining.fields.find((field) => field.name === 'change');
    if (changeField?.value && changeField.value !== this.amendment.changeNumber) {
      throw new PortalError('continuation-scope',
        `继续页变更编号 ${changeField.value} 与原变更 ${this.amendment.changeNumber} 不一致`);
    }
    const missing = stillNeeded.filter((key) => !offeredKeys.includes(key));

    this.set({
      remaining: { ...remaining, expected: stillNeeded, offered: offeredKeys, missing },
      continuationApproval: null,
      stage: 'continuation-ready',
      status: '剩余事项待经办人确认',
      message: missing.length
        ? `继续页未覆盖 ${missing.join('、')}，须人工核对后才能提交。`
        : '继续页只包含未完成的一边，已受理范围保持原样；请经办人确认后提交。',
    });
    this.log('continuation', { url: remaining.url, digest: remaining.digest, offered, stillNeeded, missing });
    return { ok: missing.length === 0, remaining, stillNeeded, missing };
  }

  async approveContinuation(approver) {
    const { remaining } = this.state;
    if (!remaining) throw new PortalError('no-continuation', '还没有读取剩余办理页');
    this.set({
      continuationApproval: {
        approver,
        at: new Date().toISOString(),
        digest: remaining.digest,
        url: remaining.url,
        scope: { additions: [], endings: remaining.offered, retained: [] },
        approvedAcceptedScope: this.state.receipt?.accepted ?? [],
        preservedCancellation: true,
      },
      status: '剩余事项已获确认，可提交',
      stage: 'continuation-approved',
      message: `已由 ${approver} 确认继续办理剩余终止；已受理范围与人工取消的意思保持原样。`,
    });
    this.log('continuation-approve', {
      approver,
      digest: remaining.digest,
      scope: remaining.offered,
      preservedAccepted: this.state.receipt?.accepted ?? [],
    });
    return this.state.continuationApproval;
  }

  async submitContinuation() {
    const { remaining, continuationApproval } = this.state;
    if (!remaining || !continuationApproval) throw new PortalError('not-approved', '剩余办理还没有经办人确认');
    if (continuationApproval.digest !== remaining.digest) {
      throw new PortalError('stale-approval', '剩余办理页已变化，请重新读取并确认');
    }

    let submission;
    try {
      submission = await this.portal.submitRemaining({
        url: remaining.url,
        expectedDigest: continuationApproval.digest,
      });
    } catch (error) {
      if (error.code !== 'remaining-unavailable') throw error;
      // 门户已不再提供剩余办理页：说明该部分可能已被处理，回到受理记录核对，不再重复提交。
      this.log('continuation-unavailable', { url: remaining.url, message: error.message });
      this.set({
        submission: this.state.submission,
        stage: 'continuation-pending',
        status: '剩余办理页已不可用，转到受理记录核对',
        message: '门户已不提供剩余办理页；按申请号与变更编号重新核对受理记录，不重复提交。',
      });
      return this.syncReceipt(this.state.submission);
    }

    this.log('continuation-submit', {
      status: submission.status,
      requestBody: submission.requestBody,
      approvedDigest: continuationApproval.digest,
    });
    this.set({ submission });
    if (submission.status >= 500 || /待回传|尚未反馈/.test(submission.text)) {
      this.set({
        stage: 'continuation-pending',
        status: '剩余事项已提交，等待回执',
        message: '剩余事项已提交，受理记录尚未回传；可按申请号与变更编号继续查询。',
      });
      return { ok: false, outcome: 'pending', submission };
    }
    return this.syncReceipt(submission);
  }

  report() {
    const { directory, context, review, live, approval, submission, receipt, remaining, continuationApproval, plan, blocked } = this.state;
    return {
      case: {
        caseNumber: this.amendment.caseNumber,
        changeNumber: this.amendment.changeNumber,
        market: this.amendment.market,
        auditDay: this.amendment.auditDay,
        operation: this.amendment.operation,
        retireSite: this.amendment.retireSite,
        alternativeSite: this.amendment.alternativeSite,
        preferredLabel: this.amendment.preferredLabel ?? null,
        unaffectedOperation: this.amendment.unaffectedOperation,
      },
      stage: this.state.stage,
      status: this.state.status,
      message: this.state.message,
      directory: directory ? {
        url: directory.url,
        capturedAt: directory.capturedAt,
        digest: directory.digest,
        matched: plan?.additions ?? [],
        resolution: plan?.resolution ?? null,
      } : null,
      caseContext: context ? {
        url: context.url,
        capturedAt: context.capturedAt,
        digest: context.digest,
        version: context.context.version,
        accepted: context.context.acceptedOperations,
        progress: context.context.progress,
        endings: plan?.endings ?? [],
        retained: plan?.retained ?? [],
        unconfirmed: plan?.unconfirmed ?? [],
      } : null,
      review: review ? {
        url: review.url,
        capturedAt: review.capturedAt,
        digest: review.digest,
        version: review.review.version,
        additions: review.review.additions,
        endings: review.review.endings,
        retained: review.review.retained,
        caseVersion: review.case.context.version,
      } : null,
      blocked: blocked ?? null,
      approval: approval ? {
        approver: approval.approver,
        at: approval.at,
        digest: approval.reviewDigest,
        scope: approval.scope,
        reviewUrl: approval.reviewUrl,
        invalidated: Boolean(approval.invalidated),
        differences: approval.differences ?? [],
      } : null,
      submission: submission ? {
        at: submission.at,
        status: submission.status,
        requestBody: submission.requestBody,
        approvedDigest: approval?.reviewDigest ?? null,
        submittedDigest: submission.submittedDigest ?? null,
      } : null,
      receipt: receipt ? {
        url: receipt.receipt.url,
        lookedUpAt: receipt.receipt.lookedUpAt,
        displayedChange: receipt.receipt.displayedChange,
        accepted: receipt.accepted,
        outstanding: receipt.outstanding,
        // 旧申请保留到哪一部分，以门户回执列出的为准。
        retained: receipt.receipt.retained,
        complete: receipt.complete,
        pending: receipt.pending,
      } : null,
      remaining: remaining ? {
        url: remaining.url,
        digest: remaining.digest,
        offered: remaining.offered,
        expected: remaining.expected,
        missing: remaining.missing,
        approvedBy: this.state.continuationApproval?.approver ?? null,
        approvalAt: this.state.continuationApproval?.at ?? null,
      } : null,
      verified: {
        directory: directory?.url ?? null,
        case: context?.url ?? null,
        review: live?.reviewUrl ?? review?.url ?? null,
        approvalDigest: approval?.reviewDigest ?? null,
        submissionReviewed: submission?.submittedDigest ?? null,
      },
      audit: this.state.audit,
    };
  }
}
