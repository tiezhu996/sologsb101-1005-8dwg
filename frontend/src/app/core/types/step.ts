import type { RowMeta } from './persistence';

/** 同步要求 */
export type SyncRequirement = 'sync' | 'cross' | 'single';

/** 步骤状态 */
export type StepState = 'idle' | 'lifting' | 'arrived';

export const SYNC_REQUIREMENT_LABEL: Record<SyncRequirement, string> = {
  sync: '同步',
  cross: '交叉',
  single: '单点',
};

export const STEP_STATE_LABEL: Record<StepState, string> = {
  idle: '未开始',
  lifting: '顶升中',
  arrived: '已到位',
};

export const SYNC_REQUIREMENTS: SyncRequirement[] = ['sync', 'cross', 'single'];
export const STEP_STATES: StepState[] = ['idle', 'lifting', 'arrived'];

/** 步骤状态流转 */
export const STEP_STATE_FLOW: Record<StepState, StepState[]> = {
  idle: ['lifting'],
  lifting: ['arrived'],
  arrived: [],
};

/** 顶升步骤 */
export interface Step extends RowMeta {
  id: string;
  /** 所属桥梁 */
  bridgeId: string;
  /** 序（从 1 开始，可调序） */
  seq: number;
  /** 目标顶升量（mm） */
  targetLiftMm: number;
  /** 同步要求 */
  syncRequirement: SyncRequirement;
  /** 限位值（mm） */
  limitMm: number;
  /** 负责人 */
  leader: string;
  /** 状态 */
  state: StepState;
}

/** 顶升步骤表单草稿 */
export interface StepDraft {
  bridgeId: string;
  targetLiftMm: number;
  syncRequirement: SyncRequirement;
  limitMm: number;
  leader: string;
}

/** 顶升步骤视图：含累计量与校验结论 */
export interface StepView extends Step {
  bridgeName: string;
  /** 本步及之前步骤的累计目标顶升量（mm） */
  cumulativeLiftMm: number;
  /** 累计顶升量与限位值的关系 */
  overLimit: boolean;
  /** 该步骤的测点读数条数 */
  readingCount: number;
  /** 同步偏差（mm），无读数为 null */
  syncDeviationMm: number | null;
  /** 校验结论文案 */
  validation: string;
  /** 复工接续核定：已完成量 / 接续量 / 未完成原因 */
  resumption: StepResumption;
}

/** 步骤排序 */
export function sortSteps<T extends { seq: number }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => a.seq - b.seq);
}

/** 重排序号：按给定 id 顺序重编号，返回新行 */
export function resequenceSteps<T extends { id: string; seq: number }>(rows: T[], orderedIds: string[]): T[] {
  return rows.map((row) => {
    const index = orderedIds.indexOf(row.id);
    return index >= 0 ? { ...row, seq: index + 1 } : row;
  });
}

/** 单级顶升量安全上限（mm）：超过 5mm 需分级 */
export const MAX_LIFT_PER_STEP_MM = 5;

/** 顶升量校验：返回提示文案 */
export function liftStepHint(targetLiftMm: number, limitMm: number): string {
  if (targetLiftMm > limitMm) return '目标顶升量已超过限位值，必须拆分为多级顶升';
  if (targetLiftMm > MAX_LIFT_PER_STEP_MM) {
    return `单级顶升量超过 ${MAX_LIFT_PER_STEP_MM} mm 建议值，宜分级顶升并加密监测`;
  }
  return '单级顶升量在建议范围内，可按同步要求执行';
}

/** 累计顶升量校验 */
export function cumulativeHint(cumulativeLiftMm: number, limitMm: number): string {
  if (cumulativeLiftMm > limitMm) return '累计顶升量超过限位值，立即停止并复核支撑体系';
  if (cumulativeLiftMm >= limitMm * 0.8) return '累计顶升量接近限位值，需连续监测位移';
  return '累计顶升量在限位范围内';
}

/** 同步要求对应的测点布置建议 */
export function syncLayoutHint(requirement: SyncRequirement): string {
  if (requirement === 'sync') return '同步顶升：四角同步，各测点偏差宜控制在 1.5mm 内';
  if (requirement === 'cross') return '交叉顶升：对角交替加力，注意换向时位移回弹';
  return '单点顶升：仅单点受力，须限制单级顶升量并实时观察相邻支座';
}

/* ============================ 复工接续核定 ============================ */

/** 接续核定所需的最小读数形状 */
export interface LiftReadingLike {
  stepId: string;
  displacementMm: number;
  recordedAt: string;
}

/** 接续核定未完成类别 */
export type ResumptionBlocker = 'none' | 'no-readings' | 'single-point' | 'limit-touched';

/** 步骤复工接续核定结果 */
export interface StepResumption {
  /** 是否已核定（false = 未完成，reason 写明原因） */
  settled: boolean;
  /** 未完成类别 */
  blocker: ResumptionBlocker;
  /** 已完成量（mm）：最新一组多测点读数的最大位移，未核定为 null */
  completedMm: number | null;
  /** 接续量（mm）：目标 − 已完成（下限 0），未核定为 null */
  continuationMm: number | null;
  /** 最新一组测点数 */
  latestPoints: number;
  /** 核定说明 / 未完成原因 */
  reason: string;
}

/** 状态推进放行检查结论 */
export interface AdvanceGate {
  /** 是否放行 */
  allowed: boolean;
  /** 已完成量基准（mm）：前序步骤实际/计划 + 本步已完成 */
  completedMm: number;
  /** 本步接续量（mm） */
  continuationMm: number;
  /** 后续未到位步骤剩余目标（mm） */
  remainingMm: number;
  /** 预计峰值（mm）= 已完成 + 接续量 + 剩余目标 */
  projectedMm: number;
  /** 限位值（mm） */
  limitMm: number;
  /** 超出限位的量（mm），未触限位为负值 */
  excessMm: number;
  /** 放行结论 / 拦截原因 */
  message: string;
}

/** 最新一组读数：同一记录时间视为一组，取记录时间最晚的一组 */
export function latestReadingRound<T extends { recordedAt: string }>(rows: T[]): T[] {
  if (rows.length === 0) return [];
  let latest = rows[0].recordedAt;
  for (const row of rows) {
    if (row.recordedAt > latest) latest = row.recordedAt;
  }
  return rows.filter((row) => row.recordedAt === latest);
}

/** 多点核定最少测点数：单点读数不能作为已完成量基准 */
export const MIN_POINTS_PER_ROUND = 2;

function round2(value: number): number {
  return Number(value.toFixed(2));
}

/**
 * 复工接续核定：已完成量以最新一组多测点最大位移为准，
 * 不按平均位移或计划目标估算；无读数 / 最新一组单点 / 位移触限位按未完成处理。
 */
export function resolveResumption(
  step: Pick<Step, 'targetLiftMm' | 'limitMm'>,
  rows: Array<Pick<LiftReadingLike, 'displacementMm' | 'recordedAt'>>,
): StepResumption {
  const round = latestReadingRound(rows);
  if (round.length === 0) {
    return {
      settled: false,
      blocker: 'no-readings',
      completedMm: null,
      continuationMm: null,
      latestPoints: 0,
      reason: '无测点读数，已完成量未核定',
    };
  }
  const maxMm = round2(Math.max(...round.map((row) => row.displacementMm)));
  const maxAbsMm = round2(Math.max(...round.map((row) => Math.abs(row.displacementMm))));
  if (round.length < MIN_POINTS_PER_ROUND) {
    return {
      settled: false,
      blocker: 'single-point',
      completedMm: null,
      continuationMm: null,
      latestPoints: round.length,
      reason: `最新一组仅 ${round.length} 个测点，单点读数不能作为已完成量基准`,
    };
  }
  if (maxAbsMm >= step.limitMm) {
    return {
      settled: false,
      blocker: 'limit-touched',
      completedMm: null,
      continuationMm: null,
      latestPoints: round.length,
      reason: `最新一组最大位移 ${maxMm} mm 已触限位 ${step.limitMm} mm，按未完成处理`,
    };
  }
  const continuationMm = round2(Math.max(0, step.targetLiftMm - maxMm));
  return {
    settled: true,
    blocker: 'none',
    completedMm: maxMm,
    continuationMm,
    latestPoints: round.length,
    reason: `已完成量取最新 ${round.length} 点最大值 ${maxMm} mm`,
  };
}

function blockedGate(limitMm: number, message: string): AdvanceGate {
  return {
    allowed: false,
    completedMm: 0,
    continuationMm: 0,
    remainingMm: 0,
    projectedMm: 0,
    limitMm,
    excessMm: 0,
    message,
  };
}

/**
 * 状态推进放行检查：顺着同桥步骤序列核定已完成量，
 * 接续量叠加剩余目标后触及限位则不放行，并写明超出多少。
 */
export function evaluateAdvanceGate(
  target: Step,
  next: StepState,
  steps: Step[],
  readings: LiftReadingLike[],
): AdvanceGate {
  const ordered = sortSteps(steps.filter((item) => item.bridgeId === target.bridgeId));
  const resumptionOf = (item: Step): StepResumption =>
    resolveResumption(item, readings.filter((row) => row.stepId === item.id));
  const self = resumptionOf(target);

  // 前序步骤：有核定读数按实际已完成量，否则按计划目标兜底
  let priorMm = 0;
  for (const item of ordered) {
    if (item.seq >= target.seq) break;
    const resumption = resumptionOf(item);
    if (resumption.blocker === 'limit-touched') {
      return blockedGate(target.limitMm, `前序步骤 #${item.seq} ${resumption.reason}，状态推进不放行`);
    }
    priorMm = round2(priorMm + (resumption.settled && resumption.completedMm !== null ? resumption.completedMm : item.targetLiftMm));
  }

  if (self.blocker === 'limit-touched') {
    return blockedGate(target.limitMm, `本步${self.reason}，状态推进不放行`);
  }
  if (next === 'arrived' && !self.settled) {
    return blockedGate(target.limitMm, `未完成：${self.reason}，不能判定到位`);
  }

  const completedMm = round2(priorMm + (self.completedMm ?? 0));
  const continuationMm = self.settled && self.continuationMm !== null ? self.continuationMm : target.targetLiftMm;
  const remainingMm = round2(
    ordered
      .filter((item) => item.seq > target.seq && item.state !== 'arrived')
      .reduce((sum, item) => sum + item.targetLiftMm, 0),
  );
  const projectedMm = round2(completedMm + continuationMm + remainingMm);
  const excessMm = round2(projectedMm - target.limitMm);
  const detail = `已完成 ${completedMm} mm + 接续量 ${continuationMm} mm + 剩余目标 ${remainingMm} mm = ${projectedMm} mm`;
  if (projectedMm >= target.limitMm) {
    return {
      allowed: false,
      completedMm,
      continuationMm,
      remainingMm,
      projectedMm,
      limitMm: target.limitMm,
      excessMm,
      message: `${detail}，触及限位 ${target.limitMm} mm（超出 ${excessMm} mm），状态推进不放行`,
    };
  }
  return {
    allowed: true,
    completedMm,
    continuationMm,
    remainingMm,
    projectedMm,
    limitMm: target.limitMm,
    excessMm,
    message: `${detail}，未触限位 ${target.limitMm} mm，放行`,
  };
}
