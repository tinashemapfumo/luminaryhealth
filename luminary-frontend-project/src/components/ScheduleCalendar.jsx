import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Clock3, Video } from 'lucide-react';

/**
 * Clinical scheduling grid.
 *
 * Time runs down, resources run across — providers, rooms, or weekdays
 * depending on the view. Appointments are absolutely positioned so a 45-minute
 * visit is visibly longer than a 30-minute one, which is the whole point of a
 * calendar over a list: you can see where the gaps are.
 *
 * Drag an appointment onto another cell to reschedule. The parent decides
 * whether the move is allowed (see `onMove`) so conflict rules live with the
 * rest of the booking logic rather than in the view.
 */

const DAY_START = 8 * 60;   // 08:00
const DAY_END = 17 * 60;    // 17:00
const SLOT = 15;            // minutes per row
const SLOT_PX = 17;         // height of one row
const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export const timeToMinutes = (time) => {
  const [h, m] = String(time).split(':').map(Number);
  return h * 60 + (m || 0);
};

export const minutesToTime = (mins) => {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
};

const slots = [];
for (let m = DAY_START; m < DAY_END; m += SLOT) slots.push(m);

/**
 * Lays overlapping appointments side by side so neither is hidden.
 * Returns each appointment with a lane index and the total lane count.
 */
function assignLanes(items) {
  const sorted = [...items].sort((a, b) => timeToMinutes(a.time) - timeToMinutes(b.time));
  const lanes = [];
  const placed = sorted.map((item) => {
    const start = timeToMinutes(item.time);
    const end = start + (item.duration || 30);
    let lane = lanes.findIndex((laneEnd) => laneEnd <= start);
    if (lane === -1) {
      lanes.push(end);
      lane = lanes.length - 1;
    } else {
      lanes[lane] = end;
    }
    return { item, lane, start, end };
  });
  // Count only the lanes each appointment actually competes with.
  return placed.map((entry) => {
    const overlapping = placed.filter((other) => other.start < entry.end && other.end > entry.start);
    const laneCount = Math.max(...overlapping.map((o) => o.lane)) + 1;
    return { ...entry, laneCount };
  });
}

export default function ScheduleCalendar({
  appointments,
  providers,
  rooms,
  visitStatuses,
  selectedId,
  onSelect,
  onMove,
  onBookSlot,
  canSchedule,
  restrictToProvider,
  defaultView = 'Day',
}) {
  const [view, setView] = useState(defaultView);
  const [dayOffset, setDayOffset] = useState(0);
  const [dragging, setDragging] = useState(null);
  const [hoverCell, setHoverCell] = useState(null);
  const [now, setNow] = useState(() => new Date());
  const gridRef = useRef(null);

  // Move the "now" line with the clock rather than freezing at first render.
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 60000);
    return () => window.clearInterval(timer);
  }, []);

  const columns = useMemo(() => {
    if (view === 'Rooms') return rooms;
    if (view === 'Week') return WEEKDAYS;
    return restrictToProvider ? [restrictToProvider] : providers;
  }, [view, rooms, providers, restrictToProvider]);

  const columnKey = view === 'Rooms' ? 'room' : view === 'Week' ? 'day' : 'provider';

  const visible = useMemo(
    () =>
      appointments.filter((a) => {
        // A cancelled or no-show visit no longer holds its slot — leaving it
        // in the grid made the time look permanently occupied and blocked
        // rebooking it (see findConflict in the parent).
        if (['Cancelled', 'No-show'].includes(visitStatuses[a.id])) return false;
        if (restrictToProvider && a.provider !== restrictToProvider) return false;
        if (view === 'Week') return true;
        return (a.day ?? 0) === dayOffset;
      }),
    [appointments, view, dayOffset, restrictToProvider, visitStatuses]
  );

  const byColumn = useMemo(() => {
    const map = {};
    columns.forEach((col, index) => {
      const items = visible.filter((a) =>
        columnKey === 'day' ? (a.day ?? 0) === index : a[columnKey] === col
      );
      map[col] = assignLanes(items);
    });
    return map;
  }, [columns, visible, columnKey]);

  const todayLabel = useMemo(() => {
    const date = new Date();
    date.setDate(date.getDate() + dayOffset);
    return date.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
  }, [dayOffset]);

  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  const showNowLine = dayOffset === 0 && nowMinutes >= DAY_START && nowMinutes < DAY_END;

  const handleDrop = (column, startMinutes) => {
    if (!dragging || !canSchedule) return;
    const target = {
      time: minutesToTime(startMinutes),
      [columnKey === 'day' ? 'day' : columnKey]: columnKey === 'day' ? columns.indexOf(column) : column,
    };
    if (columnKey !== 'day') target.day = dayOffset;
    onMove(dragging, target);
    setDragging(null);
    setHoverCell(null);
  };

  return (
    <div className="rounded-lg border border-line bg-white/95 shadow-[0_16px_42px_-34px_rgba(11,21,36,0.55)]">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3">
        <div className="flex items-center gap-2">
          {view !== 'Week' && (
            <div className="flex items-center gap-0.5">
              <button
                type="button"
                onClick={() => setDayOffset((d) => d - 1)}
                aria-label="Previous day"
                className="rounded border border-edge p-1.5 text-muted transition hover:border-brand hover:text-ink"
              >
                <ChevronLeft size={14} />
              </button>
              <button
                type="button"
                onClick={() => setDayOffset((d) => d + 1)}
                aria-label="Next day"
                className="rounded border border-edge p-1.5 text-muted transition hover:border-brand hover:text-ink"
              >
                <ChevronRight size={14} />
              </button>
            </div>
          )}
          <div>
            <p className="text-md font-semibold text-ink">
              {view === 'Week' ? 'This week' : todayLabel}
            </p>
            <p className="text-xs text-muted">
              {visible.length} appointment{visible.length === 1 ? '' : 's'}
              {dayOffset !== 0 && view !== 'Week' && ' · not today'}
            </p>
          </div>
          {dayOffset !== 0 && view !== 'Week' && (
            <button type="button" onClick={() => setDayOffset(0)} className="ml-1 text-sm font-medium text-brand hover:underline">
              Back to today
            </button>
          )}
        </div>

        <div className="flex items-center gap-1 rounded-lg border border-edge bg-white/80 p-0.5">
          {['Day', 'Week', 'Rooms'].map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => setView(option)}
              className={`rounded px-3 py-1.5 text-sm font-medium transition ${
                view === option ? 'bg-brand text-white shadow-[0_8px_18px_-14px_rgba(8,114,222,0.55)]' : 'text-body hover:bg-surface'
              }`}
            >
              {option}
            </button>
          ))}
        </div>
      </div>

      {canSchedule && (
        <p className="border-b border-line bg-surface px-4 py-2 text-xs text-muted">
          Drag an appointment to reschedule it · click an empty slot to book
        </p>
      )}

      {/* Grid */}
      <div ref={gridRef} className="max-h-[620px] overflow-auto">
        <div className="min-w-[680px]">
          {/* Column headers */}
          <div
            className="sticky top-0 z-20 grid border-b border-line bg-white"
            style={{ gridTemplateColumns: `58px repeat(${columns.length}, minmax(0, 1fr))` }}
          >
            <div className="border-r border-line" />
            {columns.map((column) => {
              const count = byColumn[column]?.length || 0;
              return (
                <div key={column} className="border-r border-line px-2 py-2 text-center last:border-r-0">
                  <p className="truncate text-sm font-semibold text-ink">{column}</p>
                  <p className="text-2xs text-muted">{count} booked</p>
                </div>
              );
            })}
          </div>

          {/* Time rows + appointment layer */}
          <div
            className="relative grid"
            style={{ gridTemplateColumns: `58px repeat(${columns.length}, minmax(0, 1fr))` }}
          >
            {/* Time gutter */}
            <div className="border-r border-line">
              {slots.map((minutes) => (
                <div
                  key={minutes}
                  style={{ height: SLOT_PX }}
                  className={`relative ${minutes % 60 === 0 ? 'border-t border-line' : ''}`}
                >
                  {minutes % 60 === 0 && (
                    <span className="absolute -top-[7px] right-1.5 bg-white px-1 text-2xs text-muted">
                      {minutesToTime(minutes)}
                    </span>
                  )}
                </div>
              ))}
            </div>

            {/* Resource columns */}
            {columns.map((column) => (
              <div key={column} className="relative border-r border-line last:border-r-0">
                {/* Droppable / clickable background cells */}
                {slots.map((minutes) => {
                  const isHover = hoverCell === `${column}-${minutes}`;
                  return (
                    <div
                      key={minutes}
                      style={{ height: SLOT_PX }}
                      onDragOver={(e) => {
                        if (!dragging || !canSchedule) return;
                        e.preventDefault();
                        setHoverCell(`${column}-${minutes}`);
                      }}
                      onDragLeave={() => setHoverCell(null)}
                      onDrop={(e) => {
                        e.preventDefault();
                        handleDrop(column, minutes);
                      }}
                      onClick={() => {
                        if (!canSchedule) return;
                        onBookSlot({
                          time: minutesToTime(minutes),
                          provider: columnKey === 'provider' ? column : undefined,
                          room: columnKey === 'room' ? column : undefined,
                          day: columnKey === 'day' ? columns.indexOf(column) : dayOffset,
                        });
                      }}
                      className={`${minutes % 60 === 0 ? 'border-t border-line' : ''} ${
                        isHover ? 'bg-brand-soft' : canSchedule ? 'hover:bg-surface' : ''
                      } ${canSchedule ? 'cursor-pointer' : ''}`}
                    />
                  );
                })}

                {/* Appointments */}
                {(byColumn[column] || []).map(({ item, lane, laneCount, start }) => {
                  const duration = item.duration || 30;
                  const top = ((start - DAY_START) / SLOT) * SLOT_PX;
                  const height = Math.max((duration / SLOT) * SLOT_PX - 2, 20);
                  const status = visitStatuses[item.id] || 'Booked';
                  const isSelected = selectedId === item.id;
                  const width = `calc(${100 / laneCount}% - 4px)`;
                  const left = `calc(${(lane * 100) / laneCount}% + 2px)`;

                  const palette = {
                    Booked: 'bg-wash border-brand-edge text-ink',
                    'Checked in': 'bg-warning-wash border-warning-edge text-warning-deep',
                    'In consultation': 'bg-teal-soft border-teal-line text-teal-deep',
                    Completed: 'bg-success-soft border-success-edge text-success-deep',
                    'No-show': 'bg-danger-soft border-danger-edge text-danger-deep',
                    // Cancelled visits are filtered out of `visible` above and
                    // should never reach this point, but this keeps a cancelled
                    // appointment from ever being mistaken for an active Booked
                    // one if that filter is ever bypassed.
                    Cancelled: 'bg-surface border-edge text-faint line-through',
                  };

                  return (
                    <button
                      key={item.id}
                      type="button"
                      draggable={canSchedule}
                      onDragStart={() => setDragging(item.id)}
                      onDragEnd={() => { setDragging(null); setHoverCell(null); }}
                      onClick={(e) => { e.stopPropagation(); onSelect(item); }}
                      style={{ top, height, width, left }}
                      title={`${item.time} · ${item.patient} · ${item.type} · ${item.provider}`}
                      className={`absolute overflow-hidden rounded border px-1.5 py-1 text-left transition ${palette[status] || palette.Booked} ${
                        isSelected ? 'ring-2 ring-brand ring-offset-1' : ''
                      } ${dragging === item.id ? 'opacity-40' : ''} ${canSchedule ? 'cursor-grab active:cursor-grabbing' : ''}`}
                    >
                      <span className="flex items-center gap-1 text-2xs font-semibold leading-tight">
                        <Clock3 size={9} className="shrink-0" />
                        {item.time}
                        {item.mode === 'Telehealth' && <Video size={9} className="shrink-0" />}
                      </span>
                      <span className="block truncate text-xs font-medium leading-tight">{item.patient}</span>
                      {height > 40 && (
                        <span className="block truncate text-2xs leading-tight opacity-80">{item.type}</span>
                      )}
                    </button>
                  );
                })}
              </div>
            ))}

            {/* Current-time line */}
            {showNowLine && view !== 'Week' && (
              <div
                className="pointer-events-none absolute left-[58px] right-0 z-10 flex items-center"
                style={{ top: ((nowMinutes - DAY_START) / SLOT) * SLOT_PX }}
              >
                <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-danger" />
                <span className="h-px flex-1 bg-danger" />
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Legend */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 border-t border-line px-4 py-2.5">
        {[
          ['Booked', 'Booked', 'bg-wash border-brand-edge'],
          ['Checked in', 'Checked in', 'bg-warning-wash border-warning-edge'],
          ['In consultation', 'In consultation', 'bg-teal-soft border-teal-line'],
          ['Completed', 'Completed', 'bg-success-soft border-success-edge'],
          ['No-show', 'No show', 'bg-danger-soft border-danger-edge'],
        ].map(([value, label, className]) => (
          <span key={value} className="flex items-center gap-1.5">
            <span className={`h-2.5 w-2.5 rounded-sm border ${className}`} />
            <span className="text-xs text-muted">{label}</span>
          </span>
        ))}
      </div>
    </div>
  );
}
