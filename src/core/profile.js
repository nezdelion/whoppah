// Settings schemas: machine profile, calibration, job parameters. A single source for the form, defaults and validation.
// Schema field: { key, label, type: 'number'|'bool'|'enum'|'paper'|'formats'|'text', unit, min, max, default, group, options?, hidden? }

const num = (key, label, def, extra = {}) => ({ key, label, type: 'number', default: def, ...extra });

export const PROFILE_SCHEMA = Object.freeze([
  num('penWidthMm', 'Ширина пера', 0.5, { unit: 'мм', min: 0.05, max: 5, group: 'Перо' }),
  num('zDownOffset', 'Рисует', -0.7, { unit: 'мм', min: -10, max: 10, group: 'Перо, Z от касания' }),
  num('zUpOffset', 'Поднято', 2, { unit: 'мм', min: 0, max: 50, group: 'Перо, Z от касания' }),
  num('zStartOffset', 'В начале', 7, { unit: 'мм', min: 0, max: 100, group: 'Перо, Z от касания' }),
  num('zEndOffset', 'В конце', 17, { unit: 'мм', min: 0, max: 100, group: 'Перо, Z от касания' }),
  num('zClearanceMm', 'Зазор рамки', 1, { unit: 'мм', min: 0, max: 20, group: 'Перо, Z от касания' }),
  num('fDraw', 'Рисование', 3000, { unit: 'мм/мин', min: 1, group: 'Скорости' }),
  num('fTravel', 'Переезд', 6000, { unit: 'мм/мин', min: 1, group: 'Скорости' }),
  num('fZUp', 'Z вверх', 1200, { unit: 'мм/мин', min: 1, group: 'Скорости' }),
  num('fZDown', 'Z вниз', 600, { unit: 'мм/мин', min: 1, group: 'Скорости' }),
  num('accelXY', 'Ускорение XY', 500, { unit: 'мм/с²', min: 1, group: 'Скорости' }),
  num('accelZ', 'Ускорение Z', 100, { unit: 'мм/с²', min: 1, group: 'Скорости' }),
  num('limX0', 'X мин', -4, { unit: 'мм', group: 'Пределы хода сопла' }),
  num('limX1', 'X макс', 234, { unit: 'мм', group: 'Пределы хода сопла' }),
  num('limY0', 'Y мин', 1, { unit: 'мм', group: 'Пределы хода сопла' }),
  num('limY1', 'Y макс', 231, { unit: 'мм', group: 'Пределы хода сопла' }),
  { key: 'home', label: 'Home (G28) в начале файла', type: 'bool', default: false, group: 'Файл',
    warn: 'Home опускает голову к столу, чтобы датчик замерил Z. Перо торчит ниже сопла и упрётся в стол или бумагу — '
      + 'можно сломать перо или держатель. Включайте, только если перо в этот момент поднято в держателе выше сопла. '
      + 'Обычно проще сделать Home кнопкой до установки пера, а потом снять калибровку.' },
  { key: 'motorsOff', label: 'M84 в конце', type: 'bool', default: true, group: 'Файл' },
  // the mesh fade (Z10 on the Neptune 3 Pro) turns off compensation above the pen touch; Z0 — compensation at any height, until the printer reboots
  { key: 'meshNoFade', label: 'Сетка стола на любой высоте (M420 S1 Z0)', type: 'bool', default: false, group: 'Файл',
    warn: 'После включения снимите касание заново: с компенсацией Z в углу листа сдвигается на поправку сетки в этой точке. '
      + 'Настройка действует до перезагрузки принтера; файл и кнопки пера отправляют её сами.' },
]);

export const CALIBRATION_SCHEMA = Object.freeze([
  num('cornerX', 'X', -5, { unit: 'мм', group: 'Угол бумаги (сопло, когда перо в углу листа)' }),
  num('cornerY', 'Y', 50, { unit: 'мм', group: 'Угол бумаги (сопло, когда перо в углу листа)' }),
  num('zTouch', 'Z касания бумаги', 8, { unit: 'мм', min: 0, max: 300, group: 'Высота' }),
  { key: 'updatedAt', label: 'Дата', type: 'text', default: null, hidden: true },
  // printer coordinate epochs at which a calibration part was captured, entered or confirmed (written by the plugin server)
  { key: 'epochXY', label: 'Версия угла', type: 'number', default: null, hidden: true },
  { key: 'epochZ', label: 'Версия касания', type: 'number', default: null, hidden: true },
]);

export const DEFAULT_CUSTOM_FORMATS = Object.freeze([{ id: 'work', name: 'Рабочее поле', w: 180, h: 180 }]);

export const JOB_SCHEMA = Object.freeze([
  { key: 'paperId', label: 'Формат бумаги', type: 'paper', default: 'work', group: 'Поле' },
  { key: 'orientation', label: 'Ориентация', type: 'enum', default: 'portrait', group: 'Поле',
    options: { portrait: 'книжная', landscape: 'альбомная' } },
  num('marginMm', 'Отступ', 5, { unit: 'мм', min: 0, group: 'Поле' }),
  { key: 'halign', label: 'По горизонтали', type: 'enum', default: 'center', group: 'Выравнивание',
    options: { left: 'слева', center: 'центр', right: 'справа' } },
  { key: 'valign', label: 'По вертикали', type: 'enum', default: 'center', group: 'Выравнивание',
    options: { top: 'сверху', center: 'центр', bottom: 'снизу' } },
  { key: 'rotate', label: 'Повернуть на 90°', type: 'bool', default: false, group: 'Выравнивание' },
  { key: 'asIs', label: 'Как есть в мм (без масштабирования)', type: 'bool', default: false, group: 'Выравнивание' },
  num('simplifyTolMm', 'Упрощение линий (допуск)', 0.05, { unit: 'мм', min: 0, group: 'Оптимизация' }),
  num('mergeTolMm', 'Слияние концов (допуск)', 0.05, { unit: 'мм', min: 0, group: 'Оптимизация' }),
  // hatching: adjacent parallel strokes are joined by a drawn transition — without lifting and lowering the pen (Z is slow)
  // the transition is visible on paper (at the hatching edge it almost merges with the outline); set near the hatching step, 0 — off
  num('linkTolMm', 'Соединять концы штрихом до', 0, { unit: 'мм', min: 0, group: 'Оптимизация' }),
  { key: 'customFormats', label: 'Свои форматы', type: 'formats', default: DEFAULT_CUSTOM_FORMATS, hidden: true },
]);

export const SCHEMAS = Object.freeze({ profile: PROFILE_SCHEMA, calibration: CALIBRATION_SCHEMA, job: JOB_SCHEMA });

const clone = (v) => (v === null || typeof v !== 'object' ? v : JSON.parse(JSON.stringify(v)));

export function defaultsOf(schema) {
  return Object.fromEntries(schema.map((f) => [f.key, clone(f.default)]));
}

function validField(f, v) {
  switch (f.type) {
    case 'number':
      return typeof v === 'number' && Number.isFinite(v) && (f.min === undefined || v >= f.min) && (f.max === undefined || v <= f.max);
    case 'bool': return typeof v === 'boolean';
    case 'enum': return typeof v === 'string' && Object.hasOwn(f.options, v);
    case 'paper': return typeof v === 'string' && v.length > 0;
    case 'formats':
      return Array.isArray(v) && v.every((x) => x && typeof x.id === 'string' && typeof x.name === 'string' && x.w > 0 && x.h > 0);
    default: return true;
  }
}

/** List of errors [{key, message}]; empty — the values are valid. */
export function validate(schema, values) {
  const errors = [];
  for (const f of schema) {
    if (f.hidden && f.type !== 'formats') continue;
    const v = values[f.key];
    if (validField(f, v)) continue;
    let message = 'недопустимое значение';
    if (f.type === 'number') {
      const lo = f.min !== undefined ? `от ${f.min} ` : '';
      const hi = f.max !== undefined ? `до ${f.max}` : '';
      message = `${f.label}: число ${lo}${hi}`.trim();
    }
    errors.push({ key: f.key, message });
  }
  return errors;
}

/** Defaults + saved ones; invalid fields are replaced by the default value. */
export function normalize(schema, values) {
  const out = defaultsOf(schema);
  for (const f of schema) {
    if (values && f.key in values && validField(f, values[f.key])) out[f.key] = clone(values[f.key]);
  }
  return out;
}

export const normalizeProfile = (v) => normalize(PROFILE_SCHEMA, v);
export const normalizeCalibration = (v) => normalize(CALIBRATION_SCHEMA, v);
export const normalizeJob = (v) => normalize(JOB_SCHEMA, v);

const round3 = (v) => Math.round(v * 1000) / 1000;

/** Absolute Z: the profile offsets from the touch from the calibration. */
export function absoluteZ(profile, calibration) {
  const t = calibration.zTouch;
  return {
    touch: t,
    down: round3(t + profile.zDownOffset),
    up: round3(t + profile.zUpOffset),
    start: round3(t + profile.zStartOffset),
    end: round3(t + profile.zEndOffset),
    clearance: round3(t + profile.zClearanceMm),
  };
}

export const axisLimits = (p) => ({ x0: p.limX0, x1: p.limX1, y0: p.limY0, y1: p.limY1 });
