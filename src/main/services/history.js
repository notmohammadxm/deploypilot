import crypto from 'node:crypto';
import { addHistory, getHistory, getHistoryEntry } from './profileStore.js';

export function recordHistory(data) {
  return addHistory({
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    ...data
  });
}

export { getHistory, getHistoryEntry };
