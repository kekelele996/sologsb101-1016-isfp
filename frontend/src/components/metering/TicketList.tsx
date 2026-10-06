/**
 * 外送计量单列表（计量站视图）
 * 按交接批次展示初测 / 复测计量单；已作废单保留留痕，有效单可录入复测。
 * 纯展示 + 回调组件，复测作废联动由 meteringStore + db 事务完成。
 */
import { For, Show } from 'solid-js';
import type { MeteringTicket } from '../../types/metering';
import type { Pond } from '../../types/pond';

export interface TicketListProps {
  tickets: MeteringTicket[];
  ponds: Pond[];
  onRemeasure: (ticket: MeteringTicket) => void;
  onDelete: (ticket: MeteringTicket) => void;
}

export default function TicketList(props: TicketListProps) {
  const pondLabel = (pondId: string): string => {
    const pond = props.ponds.find((item) => item.id === pondId);
    return pond === undefined ? '（池已删除）' : `${pond.code} · ${pond.seriesName}`;
  };

  return (
    <ul class="space-y-2">
      <For each={props.tickets}>
        {(ticket) => (
          <li
            class={`flex flex-wrap items-center gap-3 rounded-lg border bg-white px-3.5 py-3 ${
              ticket.status === '已作废' ? 'border-slate-200 bg-slate-50/70 opacity-75' : 'border-slate-200'
            }`}
          >
            <div class="min-w-[210px] flex-1">
              <p class="text-sm font-medium text-slate-800">{pondLabel(ticket.pondId)}</p>
              <p class="text-xs text-slate-500">
                批次 <span class="font-medium text-slate-700">{ticket.handoverBatch}</span> · 计量日期 {ticket.measureDate}
              </p>
              <Show when={ticket.backfilledBatch}>
                <p class="mt-0.5 text-[11px] text-slate-400">升级时按池号+日期补登记的交接批次号</p>
              </Show>
              <Show when={ticket.supersedesTicketId !== null}>
                <p class="mt-0.5 text-[11px] text-emerald-600">复测单，取代原计量单 {ticket.supersedesTicketId}</p>
              </Show>
              <Show when={ticket.status === '已作废'}>
                <p class="mt-0.5 text-[11px] font-medium text-rose-600">已作废：{ticket.voidReason}</p>
              </Show>
            </div>

            <div class="text-xs text-slate-600">
              <p>
                体积 <span class="tabular-nums font-medium text-slate-800">{ticket.volumeM3}</span> m³
              </p>
              <p>
                密度 <span class="tabular-nums font-medium text-slate-800">{ticket.densityGcm3}</span> g/cm³
              </p>
            </div>

            <span
              class={`rounded border px-2 py-0.5 text-[11px] ${
                ticket.round === '复测'
                  ? 'border-indigo-300 bg-indigo-50 text-indigo-700'
                  : 'border-sky-300 bg-sky-50 text-sky-700'
              }`}
            >
              {ticket.round}
            </span>
            <span
              class={`rounded border px-2 py-0.5 text-[11px] ${
                ticket.status === '有效'
                  ? 'border-emerald-300 bg-emerald-50 text-emerald-700'
                  : 'border-slate-300 bg-slate-100 text-slate-500 line-through'
              }`}
            >
              {ticket.status}
            </span>

            <div class="flex flex-wrap items-center gap-2">
              <button
                class="rounded-md border border-indigo-300 bg-indigo-50 px-2.5 py-1 text-xs text-indigo-700 transition hover:bg-indigo-100 disabled:opacity-50"
                disabled={ticket.status !== '有效'}
                onClick={() => props.onRemeasure(ticket)}
                title="复测后密度一变：本单作废、出具复测单，用过本单的出卤单退回待排重算"
              >
                录入复测
              </button>
              <button class="text-xs text-rose-600 hover:underline" onClick={() => props.onDelete(ticket)}>
                删除
              </button>
            </div>
          </li>
        )}
      </For>
    </ul>
  );
}
