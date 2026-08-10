/**
 * postgres-Core 启动：bootstrap + 注册可选持久化探活
 * 连接失败时 soft-skip（仍挂 PostgresService），不阻断 Runtime。
 */
import PluginBase from '../../../src/infrastructure/plugins/plugin-base.js';
import { setRuntimeGlobal } from '../../../src/utils/runtime-globals.js';
import { normalizeError } from '../../../src/utils/normalize-error.js';
import { registerPersistenceProvider } from '../../../src/infrastructure/database/persistence-registry.js';
import * as PostgresService from '../lib/index.js';

export default class PostgresCoreInit extends PluginBase {
  constructor() {
    super({
      name: 'postgres-core-init',
      dsc: 'postgres-Core bootstrap',
      event: 'message',
      priority: 1,
    });
  }

  async init() {
    if (PostgresCoreInit._booted) return;
    PostgresCoreInit._booted = true;
    let skipReason = '';
    try {
      await PostgresService.bootstrap();
    } catch (err) {
      skipReason = normalizeError(err).message;
    }
    setRuntimeGlobal('PostgresService', PostgresService);
    registerPersistenceProvider({
      id: 'postgres',
      kind: 'relational',
      required: false,
      core: 'postgres-Core',
      ping: () => PostgresService.ping(),
      ...(skipReason ? { meta: { skipReason } } : {}),
    });
  }
}

PostgresCoreInit._booted = false;
