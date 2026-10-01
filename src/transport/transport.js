// Transport interface — only exchange with the print server, no UI, profile or calibration.
//
// Transport {
//   id, label,
//   configured(): boolean,
//   test({signal}?):                 Promise<{server, printer}>,  // signal — AbortSignal, optional
//   upload(name, gcode, {select, print}): Promise<void>,
//   job():                           Promise<{state, file, progress, timeLeft}>,
//   pause(on: boolean):              Promise<void>,
//   cancel():                        Promise<void>,
//   command(lines: string[]):        Promise<void>,
// }
// Errors are TransportError.
import { t } from '../i18n/index.js';

export class TransportError extends Error {
  /** kind: 'network' | 'aborted' | 'auth' | 'conflict' | 'http' | 'not-configured' */
  constructor(message, { kind = 'http', operation = '', status = null } = {}) {
    super(message);
    this.name = 'TransportError';
    this.kind = kind;
    this.operation = operation;
    this.status = status;
  }
}

/** The "nothing configured" transport: print functions are unavailable, everything else works. */
export class NullTransport {
  id = 'null';
  get label() { return t('transport.none'); }

  configured() { return false; }

  #fail(operation) {
    return Promise.reject(new TransportError(t('transport.notConfigured'), { kind: 'not-configured', operation }));
  }

  test() { return this.#fail('test'); }
  upload() { return this.#fail('upload'); }
  job() { return this.#fail('job'); }
  pause() { return this.#fail('pause'); }
  cancel() { return this.#fail('cancel'); }
  command() { return this.#fail('command'); }
}
