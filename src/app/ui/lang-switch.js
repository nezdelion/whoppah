// The interface language switch in the page header (all tabs, both modes): Auto / English / Русский.
// The hint follows the button convention: the hover title, and a "?" on touch screens that shows the text under the control.
import { h, disclosure } from './dom.js';
import { t } from '../../i18n/index.js';

// language names are not translated: each one is written in its own language
export const LANG_CHOICES = Object.freeze([['auto', () => t('lang.auto')], ['en', () => 'English'], ['ru', () => 'Русский']]);

/**
 * @param language { get(): 'auto'|'en'|'ru', set(choice) } — set switches the language live (lang.js createLanguageControl)
 * @returns {{ element, select }}
 */
export function createLanguageSwitch(language) {
  const hint = t('lang.hint');
  const select = h('select', {
    class: 'lang-select', 'aria-label': t('lang.label'), title: hint,
    onchange: () => language.set(select.value),
  }, LANG_CHOICES.map(([value, name]) => h('option', { value, selected: value === language.get() }, name())));
  const { icon, text } = disclosure('?', hint);
  const element = h('span', { class: 'btn-wrap lang-switch' }, select, icon, text);
  return { element, select };
}
