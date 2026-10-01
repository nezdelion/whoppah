// Side-effect import: pins the Russian UI language. Tests that check texts stay in Russian and do not depend
// on the default language (English); the dictionary and language choice checks are in tests/i18n.test.js.
import { setLocale } from '../../src/i18n/index.js';

setLocale('ru');
