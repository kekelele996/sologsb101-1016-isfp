/**
 * 出卤单状态管理（调度端，Solid 原生能力）
 * 用 createStore 维护出卤单；排下一批出卤时按「池号 + 交接批次」与计量站对账，
 * 计量站收货且密度对得上才推进「已出卤」。
 */
import { createRoot, createSignal } from 'solid-js';
import { createStore } from 'solid-js/store';
import { liveQuery } from 'dexie';
import type { DischargeDraft, DischargeOrder, DischargeState } from '../types/discharge';
import {
  db,
  initDatabase,
  putDischargeOrder,
  reconcileDischargeOrder,
  refreshDischargeVerdicts,
  removeDischargeOrder,
  ROW_REVISION,
} from '../utils/db';
import { handoverMassTonnes } from '../utils/metering';
import { nowIso, uuid } from '../utils/id';
import { usePondStore } from './pondStore';

export interface DischargeFilters {
  keyword: string;
  seriesName: string | 'all';
  state: DischargeState | 'all';
  /** 只看对账被拦截 / 复测退回 / 升级单列的异常单 */
  issuesOnly: boolean;
}

const EMPTY_FILTERS: DischargeFilters = { keyword: '', seriesName: 'all', state: 'all', issuesOnly: false };

interface DischargeState_ {
  rows: DischargeOrder[];
  loading: boolean;
  error: string;
  lastMessage: string;
}

function createDischargeStore() {
  const [state, setState] = createStore<DischargeState_>({ rows: [], loading: true, error: '', lastMessage: '' });
  const [filters, setFilters] = createSignal<DischargeFilters>({ ...EMPTY_FILTERS });

  void initDatabase();

  liveQuery(async () => db.dischargeOrders.toArray()).subscribe({
    next: (list) => {
      setState(
        'rows',
        [...list].sort((a, b) => b.planDate.localeCompare(a.planDate) || a.handoverBatch.localeCompare(b.handoverBatch)),
      );
      setState('loading', false);
      setState('error', '');
    },
    error: (err: unknown) => {
      setState({ loading: false, error: err instanceof Error ? err.message : '读取出卤单失败' });
    },
  });

  function patchFilters(patch: Partial<DischargeFilters>): void {
    setFilters({ ...filters(), ...patch });
  }

  function resetFilters(): void {
    setFilters({ ...EMPTY_FILTERS });
  }

  function setMessage(message: string): void {
    setState('lastMessage', message);
  }

  async function createOrder(draft: DischargeDraft): Promise<DischargeOrder> {
    const stamp = nowIso();
    const row: DischargeOrder = {
      id: uuid('discharge'),
      pondId: draft.pondId,
      planDate: draft.planDate,
      handoverBatch: draft.handoverBatch.trim(),
      volumeM3: draft.volumeM3,
      densityGcm3: draft.densityGcm3,
      massTonnes: handoverMassTonnes(draft.volumeM3, draft.densityGcm3),
      operator: draft.operator.trim(),
      state: draft.state,
      reconcileVerdict: 'none',
      meteringTicketId: null,
      revisedAfterVoid: false,
      migratedFromSchedule: false,
      migrationIssue: '',
      createdAt: stamp,
      updatedAt: stamp,
      revision: ROW_REVISION,
    };
    await putDischargeOrder(row);
    setState('lastMessage', `已登记出卤单：批次 ${row.handoverBatch}，计划 ${row.planDate} 外送`);
    return row;
  }

  async function updateOrder(orderId: string, draft: DischargeDraft): Promise<void> {
    const existing = state.rows.find((row) => row.id === orderId);
    if (existing === undefined) return;
    // 编辑会改动批次/密度等对账要素：一律回到「待排」重新对账，避免与旧计量单脱钩。
    await putDischargeOrder({
      ...existing,
      pondId: draft.pondId,
      planDate: draft.planDate,
      handoverBatch: draft.handoverBatch.trim(),
      volumeM3: draft.volumeM3,
      densityGcm3: draft.densityGcm3,
      massTonnes: handoverMassTonnes(draft.volumeM3, draft.densityGcm3),
      operator: draft.operator.trim(),
      state: '待排',
      reconcileVerdict: 'none',
      meteringTicketId: null,
      revisedAfterVoid: false,
    });
    setState('lastMessage', '出卤单已更新，已回到「待排」，请重新对账');
  }

  async function deleteOrder(orderId: string): Promise<void> {
    await removeDischargeOrder(orderId);
    setState('lastMessage', '出卤单已删除');
  }

  /** 单张对账：计量站收货且密度对得上才推「已出卤」 */
  async function reconcile(orderId: string): Promise<boolean> {
    const result = await reconcileDischargeOrder(orderId);
    setState('lastMessage', result.message);
    if (result.ok) {
      const pondStore = usePondStore();
      await pondStore.refreshCounts();
    }
    return result.ok;
  }

  /** 排下一批前的批量预检：只刷新各「待排」单的对账结论，不推进状态 */
  async function precheck(): Promise<void> {
    const { matched, blocked } = await refreshDischargeVerdicts();
    setState('lastMessage', `批量对账预检完成：${matched} 张可推送，${blocked} 张被拦截（缺计量单 / 密度不符）`);
  }

  return {
    state,
    filters,
    patchFilters,
    resetFilters,
    setMessage,
    createOrder,
    updateOrder,
    deleteOrder,
    reconcile,
    precheck,
  };
}

const store = createRoot(createDischargeStore);

export function useDischargeStore() {
  return store;
}
