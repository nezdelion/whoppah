// The OctoPrint connection fields (standalone only): shared by the settings panel and the setup wizard.
import { t } from '../../i18n/index.js';

export const connectionSchema = () => [
  { key: 'url', label: t('settings.connection.url'), type: 'text', group: 'OctoPrint', placeholder: 'http://localhost:5000' },
  { key: 'key', label: t('settings.connection.key'), type: 'password', group: 'OctoPrint' },
];
