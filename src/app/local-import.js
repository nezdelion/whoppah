// Plugin mode: if the user has no settings on the server yet, but localStorage of the same origin holds
// standalone settings, offers to transfer them the same way as a file import (with permission checks).
import { SECTIONS } from '../storage/settings-store.js';
import { applySettings } from '../storage/settings-file.js';
import { importMessage } from './ui/settings-panel.js';

const USER_SECTIONS = ['job', 'presets'];

/** @returns {Promise<string|null>} a message for the log, or null if there is nothing to offer */
export async function offerLocalImport({ serverStore, localStore, flags, flagKey, confirm, needs }) {
  if (flags.getItem(flagKey)) return null;
  const sections = {};
  for (const key of SECTIONS) {
    const v = await localStore.load(key);
    if (v && typeof v === 'object') sections[key] = v;
  }
  if (!Object.keys(sections).length) return null;
  for (const key of USER_SECTIONS) if (await serverStore.load(key) !== null) return null;

  const ok = await confirm('В этом браузере найдены настройки standalone-версии. Перенести их на сервер OctoPrint?');
  flags.setItem(flagKey, '1');
  if (!ok) return null;
  const { applied, skipped } = await applySettings(serverStore, { sections }, undefined, { needs });
  return importMessage(applied, skipped);
}
