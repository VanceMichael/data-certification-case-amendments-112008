import { PortalError } from './errors.mjs';

const DAY = /^\d{4}-\d{2}-\d{2}$/;

const FIELDS = {
  case: 'caseNumber',
  change: 'changeNumber',
  caseNumber: 'caseNumber',
  changeNumber: 'changeNumber',
  market: 'market',
  auditDay: 'auditDay',
  retireSite: 'retireSite',
  operation: 'operation',
  preferredLabel: 'preferredLabel',
  alternativeSite: 'alternativeSite',
  unaffectedOperation: 'unaffectedOperation',
  directoryPath: 'directoryPath',
  casePath: 'casePath',
  receiptPath: 'receiptPath',
};

const REQUIRED = ['caseNumber', 'changeNumber', 'market', 'auditDay', 'retireSite', 'operation', 'alternativeSite'];

export function normalizeAmendment(raw) {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new PortalError('amendment-shape', '变更资料必须是单个对象');
  }
  const errors = [];
  const value = {};
  for (const [key, item] of Object.entries(raw)) {
    const field = FIELDS[key];
    if (!field) {
      errors.push(`无法识别的字段 ${key}`);
      continue;
    }
    if (item === null || item === '' || item === undefined) continue;
    if (typeof item !== 'string') {
      errors.push(`字段 ${key} 必须是字符串`);
      continue;
    }
    if (key in value && value[key] !== item.trim()) errors.push(`字段 ${key} 出现冲突取值`);
    value[field] = item.trim();
  }
  for (const field of REQUIRED) if (!value[field]) errors.push(`缺少字段 ${field}`);
  if (value.auditDay && !DAY.test(value.auditDay)) errors.push('auditDay 必须是 YYYY-MM-DD');
  if (errors.length) throw new PortalError('amendment-invalid', errors.join('；'));

  return {
    ...value,
    directoryPath: value.directoryPath ?? '/directory',
    casePath: value.casePath ?? `/cases/${value.caseNumber}`,
    receiptPath: value.receiptPath ?? `/receipts/${value.caseNumber}`,
  };
}
