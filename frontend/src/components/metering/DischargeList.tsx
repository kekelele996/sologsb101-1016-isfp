/**
 * 出卤单对账列表（调度端视图）
 * 按池号 + 交接批次与计量站对账；展示待排/已出卤、对账结论、复测退回与升级单列标记。
 * 纯展示 + 回调组件，状态动作由父级 /metering 页面通过 dischargeStore 发起。
 */
import { For, Show } from 'solid-js';
import StageTag from '../common/StageTag';
import type { DischargeOrder } from '../../types/discharge';
import type { Pond } from '../../types/pond';
import type { MeteringTicket } from '../../types/metering';
import { verdictLabel } from '../../utils/metering';

const VERDICT_STYLE: Record<DischargeOrder['reconcileVerdict'], string> = {
  none: 'border-slate-300 bg-slate-100 text-slate-600',
  matched: 'border-emerald-300 bg-emerald-50 text-emerald-700',
  noTicket: 'border-amber-300 bg-amber-50 text-amber-700',
  density: 'border-rose-300 bg-rose-50 text-rose-700',
};

export interface DischargeListProps {
  orders: DischargeOrder[];
  ponds: Pond[];
  tickets: MeteringTicket[];
  onReconcile: (orderId: string) => void;
  onEdit: (order: DischargeOrder) => void;
  onDelete: (order: DischargeOrder) => void;
}

export default function DischargeList(props: DischargeListProps) {
  const pondOf = (pondId: string): Pond | undefined => props.ponds.find((pond) => pond.id === pondId);
  const pondLabel = (pondId: string): string => {
    const pond = pondOf(pondId);
    return pond === undefined ? '（池已删除）' : `${pond.code} · ${pond.seriesName}`;
  };
  /** 出卤单当前对应的有效计量单（复测后可能已换成复测单） */
  const ticketOf = (order: DischargeOrder): MeteringTicket | undefined =>
    props.tickets.find(
      (ticket) =>
        ticket.status === '有效' && ticket.pondId === order.pondId && ticket.handoverBatch === order.handoverBatch,
    );

  return (
    <ul class="space-y-2">
      <For each={props.orders}>
        {(order) => {
          const ticket = (): MeteringTicket | undefined => ticketOf(order);
          return (
            <li
              class={`flex flex-wrap items-center gap-3 rounded-lg border bg-white px-3.5 py-3 ${
                order.migrationIssue !== '' ? 'border-rose-300 ring-1 ring-rose-200' : 'border-slate-200'
              }`}
            >
              <div class="min-w-[200px] flex-1">
                <p class="text-sm font-medium text-slate-800">
                  {pondLabel(order.pondId)}
                  <StageTag stage={pondOf(order.pondId)?.stage ?? null} size="sm" />
                </p>
                <p class="text-xs text-slate-500">
                  批次 <span class="font-medium text-slate-700">{order.handoverBatch}</span> · 计划外送 {order.planDate} ·
                  调度 {order.operator === '' ? '未填写' : order.operator}
                </p>
                <Show when={order.migratedFromSchedule}>
                  <p class="mt-0.5 text-[11px] text-slate-400">升级时由旧的「已出卤」走水计划按池号+日期补号生成</p>
                </Show>
                <Show when={order.migrationIssue !== ''}>
                  <p class="mt-0.5 text-[11px] font-medium text-rose-600">⚠ {order.migrationIssue}</p>
                </Show>
                <Show when={order.revisedAfterVoid}>
                  <p class="mt-0.5 text-[11px] font-medium text-amber-600">
                    原计量单复测作废，已退回「待排」并按新密度 {order.densityGcm3} 重算
                  </p>
                </Show>
              </div>

              <div class="text-xs text-slate-600">
                <p>
                  出卤密度 <span class="tabular-nums font-medium text-slate-800">{order.densityGcm3}</span> g/cm³
                </p>
                <p>
                  计量密度{' '}
                  <span class="tabular-nums font-medium text-brine-700">
                    {ticket() === undefined ? '—' : `${ticket()?.densityGcm3}（${ticket()?.round}）`}
                  </span>
                </p>
              </div>
              <div class="text-xs text-slate-600">
                <p>
                  体积 <span class="tabular-nums font-medium text-slate-800">{order.volumeM3}</span> m³
                </p>
                <p>
                  结算质量 <span class="tabular-nums font-medium text-slate-800">{order.massTonnes}</span> t
                </p>
              </div>

              <span class={`rounded border px-2 py-0.5 text-[11px] ${order.state === '已出卤' ? 'border-emerald-300 bg-emerald-50 text-emerald-700' : 'border-slate-300 bg-slate-100 text-slate-600'}`}>
                {order.state}
              </span>
              <span class={`rounded border px-2 py-0.5 text-[11px] ${VERDICT_STYLE[order.reconcileVerdict]}`}>
                {verdictLabel(order.reconcileVerdict)}
              </span>

              <div class="flex flex-wrap items-center gap-2">
                <button
                  class="rounded-md border border-brine-300 bg-brine-50 px-2.5 py-1 text-xs text-brine-700 transition hover:bg-brine-100 disabled:opacity-50"
                  disabled={order.state === '已出卤'}
                  onClick={() => props.onReconcile(order.id)}
                  title="按池号和交接批次对账：计量站收货且密度对得上才推到已出卤"
                >
                  对账并出卤
                </button>
                <button class="text-xs text-brine-700 hover:underline" onClick={() => props.onEdit(order)}>
                  编辑
                </button>
                <button class="text-xs text-rose-600 hover:underline" onClick={() => props.onDelete(order)}>
                  删除
                </button>
              </div>
            </li>
          );
        }}
      </For>
    </ul>
  );
}
