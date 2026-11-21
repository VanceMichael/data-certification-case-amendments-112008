// 门户说明：日期范围结束日不包含在生效范围内。
export function effectiveOn(entry, auditDay) {
  return entry.from <= auditDay && auditDay < entry.to;
}

export function directoryFingerprint(directory) {
  return directory.entries
    .map((entry) => [entry.site, entry.name, entry.market, entry.operations.join('+'), entry.from, entry.to].join('|'))
    .sort()
    .join('\n');
}

export function catalogMatches(directory, { market, operation, auditDay }) {
  return directory.entries.filter((entry) =>
    entry.market === market && effectiveOn(entry, auditDay) && entry.operations.includes(operation));
}

function describe(entry) {
  return `${entry.name}（${entry.site}）${entry.from} 至 ${entry.to}`;
}

// 显示名可能对应多个证书实体；地址编号与显示名都要回目录核对，冲突时以复核页为准。
export function resolveNewSite(directory, amendment) {
  const candidates = catalogMatches(directory, amendment);
  const byLabel = amendment.preferredLabel
    ? candidates.filter((entry) => entry.name === amendment.preferredLabel)
    : [];
  const bySite = candidates.filter((entry) => entry.site === amendment.alternativeSite);

  const seen = new Set();
  const accepted = [];
  for (const entry of [...byLabel, ...bySite]) {
    if (seen.has(entry.site)) continue;
    seen.add(entry.site);
    accepted.push(entry);
  }

  if (!accepted.length) {
    const label = amendment.preferredLabel ? `“${amendment.preferredLabel}”或` : '';
    return {
      entry: null,
      accepted: [],
      basis: 'not-found',
      reason: `目录页没有在 ${amendment.auditDay}（含生效日、不含结束日）覆盖 ${amendment.market}／${amendment.operation} 的${label}地址 ${amendment.alternativeSite}`,
      candidateText: candidates.map(describe),
    };
  }
  if (byLabel.length > 1 && !bySite.length) {
    return {
      entry: null,
      accepted,
      basis: 'ambiguous-label',
      reason: `目录页的“${amendment.preferredLabel}”在 ${amendment.auditDay} 同时对应 ${byLabel.map(describe).join('、')}，需企业指明地址编号`,
      candidateText: byLabel.map(describe),
    };
  }

  const primary = byLabel.length === 1 ? byLabel[0] : bySite[0];
  const divergence = byLabel.length === 1 && bySite.length === 1 && byLabel[0].site !== bySite[0].site
    ? {
      labelSite: byLabel[0].site,
      numberSite: bySite[0].site,
      message: `企业给的显示名“${amendment.preferredLabel}”在目录中指向 ${byLabel[0].site}，给的地址编号是 ${bySite[0].site}；两者都是 ${amendment.operation} 的有效实体，以门户复核页为准`,
    }
    : null;

  return {
    entry: primary,
    accepted,
    basis: byLabel.length === 1 && bySite[0] === byLabel[0] ? 'label+site'
      : byLabel.length === 1 ? 'label' : 'site-number',
    divergence,
    candidateText: accepted.map(describe),
  };
}

export function planKey(plan) {
  return {
    additions: (plan.additions ?? []).map((item) => `${item.site}/${item.operation}`).sort(),
    endings: (plan.endings ?? []).map((item) => `${item.site}/${item.operation}`).sort(),
    retained: (plan.retained ?? []).map((item) => `${item.site}/${item.operation}`).sort(),
  };
}

// 申请页能给出多少受理上下文就核多少；缺的部分留给复核页确认，不自行猜测。
export function buildPlan(amendment, context, directory) {
  const resolution = resolveNewSite(directory, amendment);
  const end = context.acceptedOperations.find((item) =>
    item.site === amendment.retireSite && item.operation === amendment.operation) ?? null;
  const kept = context.acceptedOperations.find((item) =>
    item.site === amendment.retireSite && item.operation === amendment.unaffectedOperation) ?? null;

  const missing = [];
  if (!resolution.entry) {
    missing.push({ side: 'add', message: resolution.reason, candidates: resolution.candidates ?? [] });
  }
  const unconfirmed = [];
  if (!end) {
    unconfirmed.push({
      side: 'end',
      message: `申请页没有列出旧址 ${amendment.retireSite} 的 ${amendment.operation} 受理凭据，需以复核页显示的受理上下文确认`,
    });
  }
  if (!kept) {
    unconfirmed.push({
      side: 'retain',
      message: `申请页没有列出 ${amendment.retireSite} 的 ${amendment.unaffectedOperation} 受理凭据，需以复核页与回执确认是否保留`,
    });
  }

  return {
    additions: resolution.entry
      ? [{
        site: resolution.entry.site,
        name: resolution.entry.name,
        operation: amendment.operation,
        market: resolution.entry.market,
        from: resolution.entry.from,
        to: resolution.entry.to,
      }]
      : [],
    endings: end ? [{ site: end.site, operation: end.operation, evidence: 'case' }] : [],
    retained: kept ? [{ site: kept.site, operation: kept.operation, evidence: 'case' }] : [],
    resolution: {
      basis: resolution.basis,
      newSiteName: resolution.entry?.name ?? null,
      newSiteFrom: resolution.entry?.from ?? null,
      newSiteTo: resolution.entry?.to ?? null,
      label: amendment.preferredLabel ?? null,
      alternativeSite: amendment.alternativeSite,
      candidates: resolution.candidateText ?? [],
      acceptedSites: (resolution.accepted ?? []).map((entry) => entry.site),
      divergence: resolution.divergence ?? null,
    },
    missing,
    unconfirmed,
  };
}

// 用门户复核页确认拆分：只允许迁移工序的终止；未迁移工序必须保留，不能被顺手注销。
export function confirmReview(plan, review, amendment) {
  const problems = [];
  const warnings = [];
  const adopted = [];
  const ignored = [];
  const got = planKey(review);
  const need = planKey(plan);
  const acceptedSites = plan.resolution?.acceptedSites ?? [];

  if (!review.additions.length) {
    problems.push('复核页没有显示新场址的补加动作，缺少新场址凭据');
  } else if (review.additions.length > 1) {
    problems.push('复核页同时补加多个场址，超出了一次场址变更的范围');
  } else {
    const shown = review.additions[0];
    if (!acceptedSites.includes(shown.site)) {
      problems.push(`复核页补加 ${shown.site}，但目录页没有把它核定为 ${amendment.operation} 在 ${amendment.auditDay} 的有效实体（候选 ${acceptedSites.join('、') || '无'}）`);
    } else if (plan.additions.length && shown.site !== plan.additions[0].site) {
      warnings.push(`复核页补加 ${shown.site}，与首次核定 ${plan.additions[0].site} 不同；按复核页为准，批准内容将绑定该页`);
      adopted.push({ side: 'add', from: 'review', item: shown });
    }
    if (shown.operation !== amendment.operation) {
      problems.push(`复核页补加的是 ${shown.operation}，与变更单上的 ${amendment.operation} 不一致`);
    }
  }

  for (const item of review.endings) {
    if (item.operation !== amendment.operation) {
      problems.push(`复核页要求终止未迁移工序 ${item.operation}，会注销其他工序，已停止`);
    }
  }

  let endings;
  if (plan.endings.length) {
    endings = plan.endings;
    if (JSON.stringify(got.endings) !== JSON.stringify(need.endings)) {
      problems.push(`复核页终止范围 ${got.endings.join('、') || '为空'} 与申请受理范围 ${need.endings.join('、')} 不一致`);
    }
  } else {
    endings = review.endings.map((item) => ({ site: item.site, operation: item.operation, evidence: 'review' }));
    if (!endings.length) {
      problems.push(`复核页没有显示旧址 ${amendment.retireSite} 的 ${amendment.operation} 终止受理，缺少旧场址凭据`);
    } else if (endings.length > 1) {
      problems.push('复核页同时终止多个场址，超出了一次场址变更的范围');
    } else if (endings[0].site !== amendment.retireSite) {
      problems.push(`复核页终止的是 ${endings[0].site}，与变更单上的旧址 ${amendment.retireSite} 不一致`);
    } else {
      adopted.push({ side: 'end', from: 'review', item: endings[0] });
    }
  }

  let retained;
  if (plan.retained.length) {
    retained = plan.retained;
    if (!got.retained.includes(need.retained[0].split('/')[0] + '/' + need.retained[0].split('/')[1])) {
      warnings.push(`复核页未声明保留 ${need.retained[0]}，以回执列明的原受理范围为准`);
    }
  } else {
    retained = review.retained
      .filter((item) => !(item.site === amendment.retireSite && item.operation === amendment.operation))
      .map((item) => ({ site: item.site, operation: item.operation, evidence: 'review' }));
    if (!retained.length) {
      ignored.push(`复核页未声明未迁移工序 ${amendment.unaffectedOperation} 是否保留，以回执为准，且本次不得终止该工序`);
    } else {
      adopted.push({ side: 'retain', from: 'review', items: retained });
    }
  }

  if (review.caseNumber !== amendment.caseNumber) {
    problems.push(`复核页申请号 ${review.caseNumber} 与变更资料 ${amendment.caseNumber} 不一致`);
  }
  if (review.change !== amendment.changeNumber) {
    problems.push(`复核页变更编号 ${review.change} 与变更资料 ${amendment.changeNumber} 不一致`);
  }
  const additions = review.additions.map((item) => ({ ...item, evidence: 'review' }));
  if (review.proposedAction && additions.length && endings.length && review.proposedAction !== 'both') {
    ignored.push(`复核页动作原值为 ${review.proposedAction}`);
  }

  // 用户录入的编号/显示名只用于取候选；真正办哪两个场址，以复核页展示为准。
  return { ok: problems.length === 0, problems, warnings, additions, endings, retained, adopted, ignored };
}

export function receiptOutstanding(receipt, expected) {
  const accepted = new Set(receipt.accepted.map((item) => `${item.site}/${item.operation}`));
  const listed = new Set(receipt.outstanding.map((item) => `${item.site}/${item.operation}`));
  const missing = expected
    .map((item) => ({ key: `${item.site}/${item.operation}`, ...item }))
    .filter((item) => !accepted.has(item.key) && !listed.has(item.key))
    .map((item) => ({ site: item.site, operation: item.operation, kind: item.kind, line: '门户未列出' }));
  return [...receipt.outstanding, ...missing];
}
