// Private details (#160): the one switch that shows everything private on a course's Roster tab
// (comment counts, alerts, filters, copying emails, and the Needs attention, Test day and Mastery
// modes). A roster may be projected to a class, so it is off until the teacher turns it on, and the
// choice is remembered on this device for every course (one key). It replaced the roster's
// "PowerSchool alerts" toggle (`prism:roster:show-ps-alerts`, #117).
//
// Storage can be unavailable (private mode) or throw: a read that throws means off, and a write that
// throws keeps the choice in memory for this page. Every component using the hook sees the same value.
import { useSyncExternalStore } from 'react';

const KEY = 'prism:private-details';
let memory = null; // the choice, only while storage refuses to keep it
const listeners = new Set();

export function getPrivateDetails() {
  if (memory != null) return memory;
  try {
    return localStorage.getItem(KEY) === 'true';
  } catch {
    return false;
  }
}

export function setPrivateDetails(on) {
  try {
    localStorage.setItem(KEY, on ? 'true' : 'false');
    memory = null;
  } catch {
    memory = !!on;
  }
  listeners.forEach((l) => l());
}

function subscribe(listener) {
  listeners.add(listener);
  // Another tab of Prism turned it on or off.
  const onStorage = (e) => { if (e.key === KEY) listener(); };
  window.addEventListener('storage', onStorage);
  return () => { listeners.delete(listener); window.removeEventListener('storage', onStorage); };
}

// → [on, setOn(boolean)]
export function usePrivateDetails() {
  const on = useSyncExternalStore(subscribe, getPrivateDetails, () => false);
  return [on, setPrivateDetails];
}
