/**
 * Postgres-Core admin（对照 pgweb：结构/行/SQL/EXPLAIN/导出/可选写）
 */
import { HttpResponse } from '../../../src/utils/http-utils.js';
import { normalizeError } from '../../../src/utils/normalize-error.js';

function requirePool(res) {
  const svc = globalThis.PostgresService;
  if (!svc?.getPool) {
    HttpResponse.error(res, new Error('PostgresService 未初始化'), 503, 'postgres-core');
    return null;
  }
  return svc;
}

function quoteIdent(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

function assertTable(name) {
  return Boolean(name && /^[A-Za-z0-9_]+$/.test(name));
}

function classifySql(sql) {
  const s = sql.trim();
  if (/^\s*(SELECT|WITH|EXPLAIN|SHOW|VALUES)\b/i.test(s) && !/^\s*EXPLAIN\s+ANALYZE\b/i.test(s)) {
    return 'read';
  }
  return 'write';
}

export default {
  name: 'postgres-core-admin',
  dsc: 'Postgres-Core 健康检查与管理 API',
  priority: 90,

  routes: [
    {
      method: 'GET',
      path: '/api/postgres-core/health',
      systemAuth: false,
      handler: HttpResponse.asyncHandler(async (_req, res) => {
        let ok = false;
        let migration = { applied: [], pending: [] };
        let info = null;
        try {
          const svc = globalThis.PostgresService;
          if (svc?.ping) ok = await svc.ping();
          if (ok && svc?.getMigrationStatus) migration = await svc.getMigrationStatus();
          if (ok && svc?.getPool) {
            const r = await svc.getPool().query(
              `SELECT current_database() AS db, current_user AS role, version() AS version`
            );
            info = r.rows[0] || null;
          }
        } catch {
          ok = false;
        }
        HttpResponse.success(res, {
          status: ok ? 'operational' : 'down',
          postgres: ok ? 'connected' : 'disconnected',
          migrations: migration,
          info,
          timestamp: Date.now(),
        });
      }, 'postgres-core.health'),
    },
    {
      method: 'GET',
      path: '/api/postgres-core/tables',
      handler: HttpResponse.asyncHandler(async (_req, res) => {
        const svc = requirePool(res);
        if (!svc) return;
        HttpResponse.success(res, { tables: svc.listTables?.() ?? [] });
      }, 'postgres-core.tables'),
    },
    {
      method: 'GET',
      path: '/api/postgres-core/admin/stats',
      handler: HttpResponse.asyncHandler(async (_req, res) => {
        const svc = requirePool(res);
        if (!svc) return;
        const pool = svc.getPool();
        const registered = svc.listTables?.() ?? [];
        const stats = [];
        for (const entry of registered) {
          try {
            const countRes = await pool.query(`SELECT COUNT(*)::int AS count FROM ${quoteIdent(entry.name)}`);
            const idxRes = await pool.query(
              `SELECT COUNT(*)::int AS count FROM pg_indexes WHERE tablename = $1`,
              [entry.name]
            );
            stats.push({
              name: entry.name,
              owner: entry.owner,
              entity: entry.entity,
              count: countRes.rows[0]?.count ?? 0,
              indexes: idxRes.rows[0]?.count ?? 0,
            });
          } catch (err) {
            stats.push({ name: entry.name, error: err.message });
          }
        }
        HttpResponse.success(res, { stats });
      }, 'postgres-core.stats'),
    },
    {
      method: 'GET',
      path: '/api/postgres-core/schema',
      handler: HttpResponse.asyncHandler(async (req, res) => {
        const svc = requirePool(res);
        if (!svc) return;
        const name = String(req.query.name || '').trim();
        if (!assertTable(name)) return HttpResponse.validationError(res, '非法表名');
        const pool = svc.getPool();
        const [cols, indexes, constraints] = await Promise.all([
          pool.query(
            `SELECT column_name, data_type, is_nullable, column_default
             FROM information_schema.columns
             WHERE table_name = $1
             ORDER BY ordinal_position`,
            [name]
          ),
          pool.query(
            `SELECT indexname, indexdef FROM pg_indexes WHERE tablename = $1 ORDER BY indexname`,
            [name]
          ),
          pool.query(
            `SELECT conname, pg_get_constraintdef(oid) AS def
             FROM pg_constraint
             WHERE conrelid = $1::regclass`,
            [name]
          ),
        ]);
        HttpResponse.success(res, {
          name,
          columns: cols.rows,
          indexes: indexes.rows,
          constraints: constraints.rows,
        });
      }, 'postgres-core.schema'),
    },
    {
      method: 'GET',
      path: '/api/postgres-core/rows',
      handler: HttpResponse.asyncHandler(async (req, res) => {
        const svc = requirePool(res);
        if (!svc) return;
        const name = String(req.query.name || '').trim();
        if (!assertTable(name)) return HttpResponse.validationError(res, '非法表名');
        const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
        const offset = Math.max(Number(req.query.offset) || 0, 0);
        const orderBy = String(req.query.orderBy || '').trim();
        const orderDir = String(req.query.orderDir || 'ASC').toUpperCase() === 'DESC' ? 'DESC' : 'ASC';
        const where = String(req.query.where || '').trim();
        const pool = svc.getPool();
        const ident = quoteIdent(name);

        let orderSql = '';
        if (orderBy && /^[A-Za-z0-9_]+$/.test(orderBy)) {
          orderSql = ` ORDER BY ${quoteIdent(orderBy)} ${orderDir}`;
        }
        // 简单 where：col=value（防注入：列名白名单式）
        const params = [];
        let whereSql = '';
        if (where) {
          const m = where.match(/^([A-Za-z0-9_]+)\s*=\s*(.+)$/);
          if (!m) return HttpResponse.validationError(res, 'where 仅支持 col=value');
          params.push(m[2]);
          whereSql = ` WHERE ${quoteIdent(m[1])} = $${params.length}`;
        }
        params.push(limit, offset);
        const countRes = await pool.query(
          `SELECT COUNT(*)::int AS count FROM ${ident}${whereSql}`,
          params.slice(0, -2)
        );
        const rowsRes = await pool.query(
          `SELECT * FROM ${ident}${whereSql}${orderSql} LIMIT $${params.length - 1} OFFSET $${params.length}`,
          params
        );
        HttpResponse.success(res, {
          name,
          count: countRes.rows[0]?.count ?? 0,
          limit,
          offset,
          columns: rowsRes.fields?.map((f) => f.name) ?? [],
          rows: rowsRes.rows,
        });
      }, 'postgres-core.rows'),
    },
    {
      method: 'POST',
      path: '/api/postgres-core/query',
      handler: HttpResponse.asyncHandler(async (req, res) => {
        const svc = requirePool(res);
        if (!svc) return;
        const sql = String(req.body?.sql || '').trim().replace(/;+\s*$/, '');
        if (!sql) return HttpResponse.validationError(res, 'SQL 不能为空');
        if (sql.includes(';')) return HttpResponse.forbidden(res, '仅允许单条语句');
        const kind = classifySql(sql);
        const allowWrite = req.body?.allowWrite === true;
        if (kind === 'write' && !allowWrite) {
          return HttpResponse.forbidden(res, '写 SQL 需 allowWrite:true（前端确认）');
        }
        const limit = Math.min(Math.max(Number(req.body?.limit) || 200, 1), 500);
        try {
          const result = await svc.getPool().query(sql);
          const rows = Array.isArray(result.rows) ? result.rows.slice(0, limit) : [];
          HttpResponse.success(res, {
            kind,
            columns: result.fields?.map((f) => f.name) ?? (rows[0] ? Object.keys(rows[0]) : []),
            rows,
            rowCount: result.rowCount ?? rows.length,
            truncated: Array.isArray(result.rows) && result.rows.length > limit,
          });
        } catch (err) {
          return HttpResponse.error(res, normalizeError(err), 400, 'postgres-core.query');
        }
      }, 'postgres-core.query'),
    },
    {
      method: 'POST',
      path: '/api/postgres-core/explain',
      handler: HttpResponse.asyncHandler(async (req, res) => {
        const svc = requirePool(res);
        if (!svc) return;
        let sql = String(req.body?.sql || '').trim().replace(/;+\s*$/, '');
        if (!sql) return HttpResponse.validationError(res, 'SQL 不能为空');
        if (sql.includes(';')) return HttpResponse.forbidden(res, '仅允许单条语句');
        if (!/^\s*(SELECT|WITH|UPDATE|DELETE|INSERT)\b/i.test(sql)) {
          return HttpResponse.forbidden(res, 'EXPLAIN 仅支持 DML/SELECT');
        }
        const analyze = req.body?.analyze === true;
        const prefix = analyze ? 'EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)' : 'EXPLAIN (FORMAT JSON)';
        try {
          const result = await svc.getPool().query(`${prefix} ${sql}`);
          HttpResponse.success(res, { plan: result.rows?.[0]?.['QUERY PLAN'] ?? result.rows });
        } catch (err) {
          return HttpResponse.error(res, normalizeError(err), 400, 'postgres-core.explain');
        }
      }, 'postgres-core.explain'),
    },
    {
      method: 'GET',
      path: '/api/postgres-core/export',
      handler: HttpResponse.asyncHandler(async (req, res) => {
        const svc = requirePool(res);
        if (!svc) return;
        const name = String(req.query.name || '').trim();
        if (!assertTable(name)) return HttpResponse.validationError(res, '非法表名');
        const limit = Math.min(Math.max(Number(req.query.limit) || 500, 1), 5000);
        const format = String(req.query.format || 'json').toLowerCase();
        const result = await svc.getPool().query(`SELECT * FROM ${quoteIdent(name)} LIMIT $1`, [limit]);
        const rows = result.rows;
        const columns = result.fields?.map((f) => f.name) ?? [];
        if (format === 'csv') {
          const esc = (v) => {
            if (v == null) return '';
            const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
            return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
          };
          const csv = [columns.join(','), ...rows.map((r) => columns.map((c) => esc(r[c])).join(','))].join(
            '\n'
          );
          res.setHeader('Content-Type', 'text/csv; charset=utf-8');
          res.setHeader('Content-Disposition', `attachment; filename="${name}.csv"`);
          return res.send(`${csv}\n`);
        }
        HttpResponse.success(res, { name, columns, rows, count: rows.length });
      }, 'postgres-core.export'),
    },
    {
      method: 'GET',
      path: '/api/postgres-core/activity',
      handler: HttpResponse.asyncHandler(async (_req, res) => {
        const svc = requirePool(res);
        if (!svc) return;
        const result = await svc.getPool().query(
          `SELECT pid, usename, state, wait_event_type, left(query, 200) AS query, query_start
           FROM pg_stat_activity
           WHERE datname = current_database()
           ORDER BY query_start DESC NULLS LAST
           LIMIT 50`
        );
        HttpResponse.success(res, { activity: result.rows });
      }, 'postgres-core.activity'),
    },
  ],
};
