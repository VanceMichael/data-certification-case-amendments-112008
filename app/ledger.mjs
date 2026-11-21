export function compare(approved, live) {
  if (!live) return ['当前复核页不可读'];
  const differences = [];
  if (approved.caseVersion !== live.caseVersion) {
    differences.push(`申请受理版本由 ${approved.caseVersion} 变为 ${live.caseVersion}`);
  }
  if (approved.reviewVersion !== live.reviewVersion) {
    differences.push(`复核页受理版本由 ${approved.reviewVersion} 变为 ${live.reviewVersion}`);
  }
  if (approved.market !== live.market) differences.push('关联市场发生变化');
  if (approved.auditDay !== live.auditDay) differences.push('审核日发生变化');
  if (approved.directoryFingerprint !== live.directoryFingerprint) {
    differences.push('场址资格目录已改版');
  }
  if (JSON.stringify(approved.scope) !== JSON.stringify(live.scope)) {
    differences.push('拆分范围与批准时不同');
  }
  return differences;
}

export function liveSnapshot(context, directory, review) {
  return {
    caseVersion: context.version,
    reviewVersion: review.version ?? context.version,
    market: context.market,
    auditDay: context.auditDay,
    directoryFingerprint: directory.fingerprint,
    scope: {
      additions: review.additions.map((item) => `${item.site}/${item.operation}`).sort(),
      endings: review.endings.map((item) => `${item.site}/${item.operation}`).sort(),
      retained: review.retained.map((item) => `${item.site}/${item.operation}`).sort(),
    },
    capturedAt: new Date().toISOString(),
  };
}
