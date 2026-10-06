/**
 * 导出工具：整库 JSON 存档、晒程进度 CSV、文本复制
 * 全部在浏览器本地完成，不经过任何服务端。
 */
import type { DatabaseSnapshot } from './db';
import { DB_NAME, DB_SCHEMA_VERSION } from './db';
import type { Pond } from '../types/pond';
import type { Observation } from '../types/observation';
import type { Assay } from '../types/assay';
import type { Schedule } from '../types/schedule';
import type { MeteringTicket } from '../types/metering';
import { brineMassT } from './metering';
import { effectiveVerdict, pondVolumeM3, round1 } from './brine';
import { stampSuffix } from './id';

/** 触发浏览器下载 */
export function download(filename: string, content: string, mime: string): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}

/** CSV 单元格转义 */
export function csvCell(value: string | number): string {
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** 导出整库 JSON 存档，返回文件名 */
export function exportSnapshotJson(snapshot: DatabaseSnapshot): string {
  const filename = `${DB_NAME}-backup-${stampSuffix()}.json`;
  download(filename, JSON.stringify(snapshot, null, 2), 'application/json;charset=utf-8');
  return filename;
}

export interface SnapshotParseResult {
  ok: boolean;
  message: string;
  snapshot: DatabaseSnapshot | null;
}

/** 解析并校验导入的 JSON 存档 */
export function parseSnapshot(text: string): SnapshotParseResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, message: 'JSON 解析失败，请确认文件内容完整。', snapshot: null };
  }
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, message: '存档格式不正确：顶层必须是对象。', snapshot: null };
  }
  const data = raw as Partial<DatabaseSnapshot>;
  if (data.name !== DB_NAME) {
    return { ok: false, message: `存档不属于本项目：期望 name = ${DB_NAME}，实际为 ${String(data.name)}。`, snapshot: null };
  }
  if (typeof data.schemaVersion !== 'number' || data.schemaVersion > DB_SCHEMA_VERSION) {
    return {
      ok: false,
      message: `存档数据结构版本不兼容：当前支持 ≤ v${DB_SCHEMA_VERSION}，实际为 v${String(data.schemaVersion)}。`,
      snapshot: null,
    };
  }
  const keys: Array<keyof DatabaseSnapshot> = ['ponds', 'gates', 'observations', 'assays', 'schedules'];
  for (const key of keys) {
    if (!Array.isArray(data[key])) {
      return { ok: false, message: `存档缺少 ${String(key)} 数组。`, snapshot: null };
    }
  }
  // v3 新增计量单：v2 存档没有该数组时按空数组处理，导入后由 v3 升级逻辑等价补齐
  const snapshot = data as DatabaseSnapshot;
  if (!Array.isArray(snapshot.meteringTickets)) snapshot.meteringTickets = [];
  return { ok: true, message: '存档校验通过。', snapshot };
}

/** 生成晒程进度汇总 CSV（含外送计量对账列） */
export function buildProgressCsv(
  ponds: Pond[],
  observations: Observation[],
  assays: Assay[],
  schedules: Schedule[],
  meteringTickets: MeteringTicket[] = [],
): string {
  const header = [
    '池号',
    '池系',
    '阶段',
    '状态',
    '面积(㎡)',
    '有效水深(cm)',
    '有效体积(m³)',
    '观测条数',
    '最近观测日期',
    '最近密度(g/cm³)',
    '最近蒸发量(mm/d)',
    '化验条数',
    '最近判定',
    '走水计划数',
    '已完成出卤数',
    '待核实计量单',
    '有效计量累计体积(m³)',
    '有效计量累计质量(t)',
  ];
  const lines: string[] = [header.map(csvCell).join(',')];
  ponds.forEach((pond) => {
    const pondObs = observations.filter((row) => row.pondId === pond.id).sort((a, b) => a.date.localeCompare(b.date));
    const latestObs = pondObs.length > 0 ? pondObs[pondObs.length - 1] : null;
    const pondAssays = assays.filter((row) => row.pondId === pond.id).sort((a, b) => a.date.localeCompare(b.date));
    const latestAssay = pondAssays.length > 0 ? pondAssays[pondAssays.length - 1] : null;
    const pondSchedules = schedules.filter((row) => row.pondId === pond.id);
    // 按池号聚合计量单：历史补号单在池号对得上现存池时也归并进来
    const pondTickets = meteringTickets.filter((ticket) => ticket.pondId === pond.id || ticket.pondCode === pond.code);
    const validTickets = pondTickets.filter((ticket) => ticket.status === '有效');
    const sumVolume = validTickets.reduce((acc, ticket) => acc + ticket.volumeM3, 0);
    const sumMass = validTickets.reduce((acc, ticket) => acc + brineMassT(ticket.densityGcm3, ticket.volumeM3), 0);
    const unmatchedCount = pondTickets.filter((ticket) => ticket.legacyFlag === 'unmatched').length;
    lines.push(
      [
        pond.code,
        pond.seriesName,
        pond.stage,
        pond.status,
        pond.areaM2,
        pond.depthCm,
        pondVolumeM3(pond.areaM2, pond.depthCm),
        pondObs.length,
        latestObs === null ? '—' : latestObs.date,
        latestObs === null ? 0 : latestObs.densityGcm3,
        latestObs === null ? 0 : latestObs.evapMm,
        pondAssays.length,
        latestAssay === null ? '—' : effectiveVerdict(latestAssay),
        pondSchedules.length,
        pondSchedules.filter((row) => row.state === '已出卤').length,
        unmatchedCount,
        Math.round(sumVolume * 10) / 10,
        Math.round(sumMass * 10) / 10,
      ]
        .map(csvCell)
        .join(','),
    );
  });
  return `\uFEFF${lines.join('\n')}`;
}

/** 导出晒程进度 CSV 文件 */
export function exportProgressCsvFile(
  ponds: Pond[],
  observations: Observation[],
  assays: Assay[],
  schedules: Schedule[],
  meteringTickets: MeteringTicket[] = [],
): string {
  const filename = `盐湖晒程进度汇总-${stampSuffix()}.csv`;
  download(filename, buildProgressCsv(ponds, observations, assays, schedules, meteringTickets), 'text/csv;charset=utf-8');
  return filename;
}

/** 外送计量台账 CSV 表头 */
const METERING_CSV_HEADER = [
  '交接批次号',
  '池号',
  '计量日期',
  '计量次数',
  '体积(m³)',
  '密度(g/cm³)',
  '质量(t)',
  '已收货',
  '状态',
  '单据性质',
  '已对出卤单',
  '旧数据标记',
  '备注',
];

/** 生成外送计量台账 CSV：作废单保留、复测链可追溯 */
export function buildMeteringCsv(tickets: MeteringTicket[], schedules: Schedule[]): string {
  const scheduleById = new Map(schedules.map((row) => [row.id, row]));
  const lines: string[] = [METERING_CSV_HEADER.map(csvCell).join(',')];
  [...tickets]
    .sort((a, b) => a.batchNo.localeCompare(b.batchNo) || a.measureRound - b.measureRound)
    .forEach((ticket) => {
      const linked = ticket.matchedScheduleId !== '' ? scheduleById.get(ticket.matchedScheduleId) : undefined;
      const nature =
        ticket.status === '作废' ? '已作废（复测替代）' : ticket.measureRound > 1 ? `复测第${ticket.measureRound}次` : '首测';
      lines.push(
        [
          ticket.batchNo,
          ticket.pondCode,
          ticket.measureDate,
          ticket.measureRound,
          ticket.volumeM3,
          ticket.densityGcm3,
          brineMassT(ticket.densityGcm3, ticket.volumeM3),
          ticket.received ? '是' : '否',
          ticket.status,
          nature,
          linked === undefined ? '—' : `${linked.planDate}/${linked.volumeM3}m³`,
          ticket.legacyFlag === 'unmatched' ? '待核实' : ticket.legacyFlag === 'backfilled' ? '升级补号' : '',
          ticket.note,
        ]
          .map(csvCell)
          .join(','),
      );
    });
  return `﻿${lines.join('\n')}`;
}

/** 导出外送计量台账 CSV */
export function exportMeteringCsvFile(tickets: MeteringTicket[], schedules: Schedule[]): string {
  const filename = `外送计量台账-${stampSuffix()}.csv`;
  download(filename, buildMeteringCsv(tickets, schedules), 'text/csv;charset=utf-8');
  return filename;
}

/** 复制文本到剪贴板 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    return false;
  }
  return false;
}

/** 生成晒程调度通报纯文本（含外送计量对账摘要） */
export function buildBriefingText(
  ponds: Pond[],
  observations: Observation[],
  assays: Assay[],
  schedules: Schedule[],
  meteringTickets: MeteringTicket[] = [],
): string {
  const lines: string[] = [`【盐湖晒程调度通报】共 ${ponds.length} 口蒸发池`];
  ponds.forEach((pond) => {
    const pondObs = observations.filter((row) => row.pondId === pond.id).sort((a, b) => a.date.localeCompare(b.date));
    const latest = pondObs.length > 0 ? pondObs[pondObs.length - 1] : null;
    const pondAssays = assays.filter((row) => row.pondId === pond.id).sort((a, b) => a.date.localeCompare(b.date));
    const lastAssay = pondAssays.length > 0 ? pondAssays[pondAssays.length - 1] : null;
    const pending = schedules.filter((row) => row.pondId === pond.id && row.state !== '已出卤').length;
    lines.push(
      `· ${pond.code}（${pond.seriesName} / ${pond.stage} / ${pond.status}）最近密度 ${
        latest === null ? '无观测' : `${latest.densityGcm3} g/cm³（${latest.date}）`
      }，蒸发量 ${latest === null ? '—' : `${round1(latest.evapMm)} mm/d`}，组分判定 ${
        lastAssay === null ? '未化验' : effectiveVerdict(lastAssay)
      }，待完成走水 ${pending} 条`,
    );
  });
  if (meteringTickets.length > 0) {
    const valid = meteringTickets.filter((ticket) => ticket.status === '有效');
    const waiting = valid.filter((ticket) => !ticket.received).length;
    const voided = meteringTickets.filter((ticket) => ticket.status === '作废').length;
    const unmatched = meteringTickets.filter((ticket) => ticket.legacyFlag === 'unmatched').length;
    const pendingReconcile = schedules.filter(
      (row) => row.state === '走水中' || (row.state === '待排' && row.batchNo !== null && row.batchNo !== ''),
    ).length;
    lines.push(
      `【外送计量】计量单 ${meteringTickets.length} 张（有效 ${valid.length} / 作废 ${voided}），待收货 ${waiting} 张，待对账出卤单 ${pendingReconcile} 张，待核实旧数据 ${unmatched} 张`,
    );
  }
  return lines.join('\n');
}
