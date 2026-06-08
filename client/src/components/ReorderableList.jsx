import { useRef, useState } from 'react';

// Generic keyboard- and pointer-accessible reorderable list.
// items: [{ id, label, content }] — label is the plain-text a11y name, content the node.
// onReorder(orderedIds) fires on every committed move; the parent owns persistence.
export default function ReorderableList({ items, onReorder }) {
  const dragFrom = useRef(null);
  const [overId, setOverId] = useState(null);
  const ids = items.map((i) => i.id);

  function dropMove(fromId, toId) {
    if (fromId == null || toId == null || fromId === toId) return;
    const fromIdx = ids.indexOf(fromId);
    const toIdx = ids.indexOf(toId);
    const next = ids.slice();
    next.splice(fromIdx, 1);
    let insertIdx = next.indexOf(toId);
    if (fromIdx < toIdx) insertIdx += 1;   // moving down → land AFTER the target
    next.splice(insertIdx, 0, fromId);
    if (next.every((id, i) => id === ids[i])) return;   // no-op guard: don't fire on unchanged order
    onReorder(next);
  }
  function nudge(id, dir) {
    const idx = ids.indexOf(id);
    const swap = idx + dir;
    if (swap < 0 || swap >= ids.length) return;
    const next = ids.slice();
    [next[idx], next[swap]] = [next[swap], next[idx]];
    onReorder(next);
  }

  return (
    <ul role="list" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
      {items.map((item) => (
        <li
          key={item.id}
          tabIndex={0}
          draggable
          onDragStart={() => { dragFrom.current = item.id; }}
          onDragOver={(e) => { e.preventDefault(); setOverId(item.id); }}
          onDragLeave={() => setOverId((o) => (o === item.id ? null : o))}
          onDrop={() => { dropMove(dragFrom.current, item.id); dragFrom.current = null; setOverId(null); }}
          onDragEnd={() => { dragFrom.current = null; setOverId(null); }}
          onKeyDown={(e) => {
            if (e.target !== e.currentTarget) return;   // ignore key events bubbling up from the ▲/▼ buttons
            if (e.key === 'ArrowUp') { e.preventDefault(); nudge(item.id, -1); }
            else if (e.key === 'ArrowDown') { e.preventDefault(); nudge(item.id, +1); }
          }}
          style={{
            display: 'flex', alignItems: 'center', gap: '0.5rem',
            padding: '0.35rem 0.5rem', marginBottom: '0.25rem',
            border: '1px solid var(--border)', borderRadius: 6, background: 'var(--card-bg)',
            boxShadow: overId === item.id ? 'inset 0 2px 0 0 var(--accent)' : 'none',
          }}
        >
          <span aria-hidden="true" style={{ cursor: 'grab', color: 'var(--text-muted)', userSelect: 'none' }}>⠿</span>
          <span style={{ flex: 1 }}>{item.content}</span>
          <span style={{ display: 'inline-flex', flexDirection: 'column', lineHeight: 0.7 }}>
            <button type="button" className="ghost" aria-label={`Move ${item.label} up`}
              style={{ padding: '0 5px', fontSize: '0.7rem' }} onClick={() => nudge(item.id, -1)}>▲</button>
            <button type="button" className="ghost" aria-label={`Move ${item.label} down`}
              style={{ padding: '0 5px', fontSize: '0.7rem' }} onClick={() => nudge(item.id, +1)}>▼</button>
          </span>
        </li>
      ))}
    </ul>
  );
}
