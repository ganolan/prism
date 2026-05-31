import { useState, useEffect, useMemo } from 'react';
import TriCheckbox from './TriCheckbox.jsx';
import { groupByYearAndSemester } from '../lib/courseDisplay.js';

// The grouped, tri-state-selectable discovery list (#71). `sections` are the
// not-yet-imported archived sections. Coded sections (those with a course code)
// form the bulk-select universe for "Select all" / per-year select / "Import
// all"; no-code sections are individually tickable but excluded from bulk.
// onImport(sectionIds) fires for both "Import all (year)" and "Import N selected".
export default function ArchivedImportList({ sections, busy, onImport }) {
  const [selected, setSelected] = useState(() => new Set());

  // Prune selection when sections change (imported ones fall out; failed stay).
  useEffect(() => {
    const present = new Set(sections.map((s) => s.sectionId));
    setSelected((prev) => {
      const next = new Set([...prev].filter((id) => present.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [sections]);

  const groups = useMemo(() => groupByYearAndSemester(sections, (s) => s.gradingPeriod), [sections]);
  const codedIds = useMemo(() => sections.filter((s) => !s.noCourseCode).map((s) => s.sectionId), [sections]);

  const toggle = (id) => setSelected((prev) => {
    const next = new Set(prev);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });
  const setMany = (ids, on) => setSelected((prev) => {
    const next = new Set(prev);
    ids.forEach((id) => (on ? next.add(id) : next.delete(id)));
    return next;
  });
  const triState = (ids) => {
    const on = ids.filter((id) => selected.has(id)).length;
    return { checked: ids.length > 0 && on === ids.length, indeterminate: on > 0 && on < ids.length };
  };
  const codedInYear = (group) =>
    group.semesters.flatMap((s) => s.courses).filter((c) => !c.noCourseCode).map((c) => c.sectionId);

  const allState = triState(codedIds);

  return (
    <div className="archived-import-groups">
      <div className="archived-import-bulkbar">
        <label className="archived-import-selectall">
          <TriCheckbox
            aria-label="Select all"
            checked={allState.checked}
            indeterminate={allState.indeterminate}
            disabled={busy || codedIds.length === 0}
            onChange={() => setMany(codedIds, !allState.checked)}
          />
          <span>Select all</span>
        </label>
        <button
          type="button"
          className="primary"
          disabled={busy || selected.size === 0}
          onClick={() => onImport([...selected])}
        >
          Import {selected.size} selected
        </button>
      </div>

      {groups.map((group) => {
        const yearCoded = codedInYear(group);
        const yearState = triState(yearCoded);
        return (
          <div className="archived-import-year" key={group.year}>
            <div className="archived-import-year-head">
              {yearCoded.length > 0 ? (
                <label className="archived-import-year-select">
                  <TriCheckbox
                    aria-label={`Select all ${group.year}`}
                    checked={yearState.checked}
                    indeterminate={yearState.indeterminate}
                    disabled={busy}
                    onChange={() => setMany(yearCoded, !yearState.checked)}
                  />
                  <span className="archived-import-year-label">{group.year}</span>
                </label>
              ) : (
                <span className="archived-import-year-label">{group.year}</span>
              )}
              {yearCoded.length > 0 && (
                <button type="button" className="secondary" disabled={busy} onClick={() => onImport(yearCoded)}>
                  Import all ({yearCoded.length})
                </button>
              )}
            </div>

            {group.semesters.map((sem) => (
              <div className="archived-import-semester" key={sem.semester}>
                <div className="archived-import-semester-label">{sem.semester}</div>
                {sem.courses.map((c) => (
                  <label className="archived-import-checkrow" key={c.sectionId}>
                    <input
                      type="checkbox"
                      aria-label={c.courseTitle}
                      checked={selected.has(c.sectionId)}
                      disabled={busy}
                      onChange={() => toggle(c.sectionId)}
                    />
                    <span>
                      {c.courseTitle}
                      {c.noCourseCode && <span className="badge badge-gray"> no course code</span>}
                    </span>
                  </label>
                ))}
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}
