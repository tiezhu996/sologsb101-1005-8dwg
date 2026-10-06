/**
 * 停工再进场接续量计算（纯函数）
 *
 * 业务口径（顶升组停工后再进场）：
 * - 已完成量只认「最新一组多点读数」的最大位移，不按平均位移、也不按计划目标估算；
 * - 最新一组只有单点、没有读数、或位移已触 / 超限位时，一律按未完成处理并写清原因；
 * - 接续量 = 本步剩余目标 = 目标顶升量 − 已完成量；接续量叠加已完成量后碰到限位，
 *   不放行状态推进，并写明超出多少；
 * - 历史读数更正（补录 / 删除 / 整库导入）后由调用方按最新读数重新调用本函数，
 *   接续量与提示随之重算。
 */
import type { ReadingRow, StepRow } from './db';

/** 接续评估结论 */
export interface ContinuationAssessment {
  /** 最新一组的记录时间（无读数为 null） */
  latestRecordedAt: string | null;
  /** 最新一组读数条数（同一记录时间视为一组） */
  latestRoundCount: number;
  /** 已完成量（mm）：最新一组多点读数的最大位移；无法确认时为 null */
  completedMm: number | null;
  /** 接续量（mm）：剩余目标 = 目标 − 已完成量；无法确认时为 null */
  continuationMm: number | null;
  /** 接续后预测位移（mm）= 已完成量 + 接续量；无法确认时为 null */
  projectedMm: number | null;
  /** 接续后距限位余量（mm），无法确认或超限时为对应负值 / null */
  marginMm: number | null;
  /** 最新一组位移是否已触 / 超本步限位 */
  limitTouched: boolean;
  /** 接续后（或触限位时）超出限位多少 mm，未超为 0，无法判断为 null */
  overLimitMm: number | null;
  /** 未完成 / 不放行原因；可放行时为 null */
  incompleteReason: string | null;
  /** 是否放行推进到「已到位」 */
  canAdvance: boolean;
  /** 已完成量是否已达到本步目标（接续量为 0） */
  reached: boolean;
  /** 给班组看的完整提示文案 */
  hint: string;
}

const round2 = (value: number): number => Number(value.toFixed(2));

/** 取某步骤读数中时间最新的一组（同一 recordedAt 视为同组），按测点顺序返回 */
export function pickLatestRound(readings: ReadingRow[]): ReadingRow[] {
  if (readings.length === 0) return [];
  const latestAt = readings.reduce((max, item) => (item.recordedAt > max ? item.recordedAt : max), readings[0].recordedAt);
  return readings
    .filter((item) => item.recordedAt === latestAt)
    .sort((a, b) => a.pointCode.localeCompare(b.pointCode));
}

/** 接续量评估：按步骤与其全部测点读数计算 */
export function assessContinuation(
  step: Pick<StepRow, 'targetLiftMm' | 'limitMm' | 'state'>,
  readings: ReadingRow[],
): ContinuationAssessment {
  const target = round2(step.targetLiftMm);
  const limit = step.limitMm;
  const round = pickLatestRound(readings);

  const base: ContinuationAssessment = {
    latestRecordedAt: round[0]?.recordedAt ?? null,
    latestRoundCount: round.length,
    completedMm: null,
    continuationMm: null,
    projectedMm: null,
    marginMm: null,
    limitTouched: false,
    overLimitMm: null,
    incompleteReason: null,
    canAdvance: false,
    reached: false,
    hint: '',
  };

  // 情形一：一组读数都没有 —— 已完成量无法确认，按未完成
  if (round.length === 0) {
    const notStarted = step.state === 'idle';
    const reason = notStarted
      ? '步骤尚未开始顶升，无任何读数，已顶起位移无法确认'
      : '停工再进场后尚无读数，已顶起位移无法确认';
    return {
      ...base,
      incompleteReason: reason,
      hint: notStarted
        ? `未完成：${reason}，不按计划目标估算接续量；开始顶升后请先录入一组多点读数，再按多点最大位移重算接续量`
        : `复工未完成：${reason}，按未完成处理（不按计划目标估算接续量）；进场后先补测一组多点读数，再按多点最大位移重算接续量`,
    };
  }

  const singleValue = round2(round[0].displacementMm);
  const singleTouched = limit > 0 && singleValue >= limit;

  // 情形二：最新一组只有单点 —— 单点不能代表多点已完成量，按未完成
  if (round.length === 1) {
    const reason = singleTouched
      ? `最新一组仅 1 个测点（${round[0].pointCode}）读数，且该点位移 ${singleValue} mm 已触 / 超限位 ${limit} mm`
      : `最新一组仅 1 个测点（${round[0].pointCode}）读数，单点位移不能代表多点已完成量`;
    return {
      ...base,
      limitTouched: singleTouched,
      overLimitMm: singleTouched ? round2(Math.max(0, singleValue - limit)) : 0,
      incompleteReason: reason,
      hint: `复工未完成：${reason}，已完成量不采信、不按单点 / 平均位移 / 计划目标估算；请补测一组多点读数后重算接续量`,
    };
  }

  // 已完成量基准：最新一组多点读数的最大位移
  const completed = round2(Math.max(...round.map((item) => item.displacementMm)));
  const limitTouched = limit > 0 && completed >= limit;

  // 情形三：最新多点位移已触 / 超限位 —— 按未完成，禁止继续顶
  if (limitTouched) {
    const over = round2(Math.max(0, completed - limit));
    const reason = `最新一组多点最大位移 ${completed} mm 已触 / 超限位 ${limit} mm（超出 ${over.toFixed(2)} mm）`;
    return {
      ...base,
      completedMm: completed,
      limitTouched: true,
      overLimitMm: over,
      incompleteReason: reason,
      hint: `复工未完成：${reason}，按未完成处理：立即停止顶升并复核支撑体系与测点，严禁再按计划目标追加顶升`,
    };
  }

  const remaining = round2(target - completed);

  // 情形四：已完成量已达到 / 超过本步目标 —— 接续量 0，可签到位（超目标给提醒）
  if (remaining <= 0) {
    const overTarget = round2(completed - target);
    return {
      ...base,
      completedMm: completed,
      continuationMm: 0,
      projectedMm: completed,
      marginMm: limit > 0 ? round2(limit - completed) : null,
      overLimitMm: 0,
      canAdvance: true,
      reached: true,
      hint:
        overTarget > 0
          ? `已完成 ${completed} mm（最新 ${round.length} 点最大，${base.latestRecordedAt ?? ''}），已超本步目标 ${target} mm（多顶 ${overTarget.toFixed(2)} mm），接续量 0 mm；复核无异常后可签已到位`
          : `已完成 ${completed} mm（最新 ${round.length} 点最大）达到本步目标 ${target} mm，接续量 0 mm，可签已到位`,
    };
  }

  // 情形五：正常接续 —— 接续量即剩余目标，校验接续后是否碰限位
  const continuation = remaining;
  const projected = round2(completed + continuation);
  const overLimit = limit > 0 ? round2(Math.max(0, projected - limit)) : 0;
  if (limit > 0 && projected > limit) {
    const reason = `接续量 ${continuation} mm 叠加已完成 ${completed} mm 后为 ${projected} mm，超出本步限位 ${limit} mm（超 ${overLimit.toFixed(2)} mm）`;
    return {
      ...base,
      completedMm: completed,
      continuationMm: continuation,
      projectedMm: projected,
      marginMm: round2(limit - projected),
      overLimitMm: overLimit,
      incompleteReason: reason,
      hint: `复工未完成：${reason}，不放行状态推进；请减小本步顶升量或重新分级后再进场`,
    };
  }

  return {
    ...base,
    completedMm: completed,
    continuationMm: continuation,
    projectedMm: projected,
    marginMm: limit > 0 ? round2(limit - projected) : null,
    overLimitMm: 0,
    canAdvance: true,
    hint:
      `已完成 ${completed} mm（最新 ${round.length} 点最大，${base.latestRecordedAt ?? ''}），` +
      `本步接续量 ${continuation} mm（= 剩余目标，不按平均位移或计划目标估算）；` +
      `接续后 ${projected} mm` +
      (limit > 0 ? `，距限位还有 ${round2(limit - projected)} mm，可按接续量继续顶升` : '，可按接续量继续顶升'),
  };
}
