import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Pool, QueryResultRow } from 'pg';
import { config } from './config';

export type Q = <R extends QueryResultRow = any>(text: string, params?: unknown[]) => Promise<R[]>;

@Injectable()
export class Db implements OnModuleDestroy {
  private pool = new Pool({ connectionString: config.databaseUrl, max: 10 });

  /** For tables that are not user-owned (users, sessions, boards, jobs). */
  query: Q = async (text, params) => (await this.pool.query(text, params as any[])).rows;

  /**
   * Runs fn in a transaction bound to one user. Row-level security restricts every
   * candidate-owned table to that user, so a missing WHERE clause cannot leak data.
   */
  async asUser<T>(userId: string, fn: (q: Q) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      await client.query("select set_config('app.user_id', $1, true)", [userId]);
      const result = await fn(async (text, params) => (await client.query(text, params as any[])).rows);
      await client.query('commit');
      return result;
    } catch (e) {
      await client.query('rollback').catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
  }

  async onModuleDestroy() {
    await this.pool.end();
  }
}

export function audit(q: Q, userId: string, type: string, entityId: string | null, data: object = {}) {
  return q('insert into audit_events (user_id, type, entity_id, data) values ($1, $2, $3, $4)', [
    userId,
    type,
    entityId,
    JSON.stringify(data),
  ]);
}
