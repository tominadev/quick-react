import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import type { DatabaseAdapter, DatabaseStatement } from './index.mjs';

type SqliteValue = null | number | bigint | string | Uint8Array;

const sqliteValues = (values: unknown[]) => values.map((value) => {
	if (typeof value === 'boolean') return value ? 1 : 0;
	if (value === null || typeof value === 'number' || typeof value === 'bigint' || typeof value === 'string' || value instanceof Uint8Array) return value;
	// JSON 列按序列化后的文本入库，与 D1、MySQL 以及 PostgreSQL 的读取归一保持一致。
	if (typeof value === 'object') return JSON.stringify(value);
	throw new TypeError(`Unsupported SQLite parameter type: ${typeof value}`);
}) as SqliteValue[];

class SqliteStatement implements DatabaseStatement {
	private values: unknown[] = [];

	constructor(private readonly statement: StatementSync) {}

	bind(...values: unknown[]) {
		this.values = values;
		return this;
	}

	async first<T>() {
		return (this.statement.get(...sqliteValues(this.values)) as T | undefined) ?? null;
	}

	async all<T>() {
		return { results: this.statement.all(...sqliteValues(this.values)) as T[] };
	}

	async run() {
		const result = this.statement.run(...sqliteValues(this.values));
		return {
			success: true,
			meta: { changes: Number(result.changes), lastRowId: result.lastInsertRowid.toString() },
		};
	}
}

export type SqliteDatabaseAdapter = DatabaseAdapter & { close: () => void };

export const createSqliteAdapter = (filename: string, options: { readBigInts?: boolean } = {}): SqliteDatabaseAdapter => {
	mkdirSync(dirname(filename), { recursive: true });
	const database = new DatabaseSync(filename);
	/**
	 * **`busy_timeout` 不是调优，是这套部署能不能正常跑的前提。**
	 *
	 * SQLite 同时只允许一个写入者。不设这个值时，第二个写入者**当场**拿到
	 * `SQLITE_BUSY: database is locked`，而不是等前一个写完——而本项目在 PM2 cluster 下跑着
	 * 多个实例，两个请求同时写是**常态**，不是异常。
	 *
	 * 这个缺陷最早是在启动迁移上暴露的：两个实例同时 `BEGIN IMMEDIATE` 迁移默认库，输的那个
	 * 立刻抛错、整个迁移循环中断，于是新加的列一条都没落库，而服务照常起来了——数据库落后于
	 * 代码，且没有任何地方报错。设上超时之后，输的那个会等，等到之后再查
	 * `global_schema_migrations` 发现已经应用过，跳过即可。
	 *
	 * 5 秒：迁移和正常写入都远快于此；真等满 5 秒说明有别的东西长时间占着写锁，那时报错才
	 * 是对的——继续等下去只会把请求堆死。
	 */
	database.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
	const adapter: SqliteDatabaseAdapter = {
		dialect: 'sqlite',
		prepare: (query) => {
			const statement = database.prepare(query);
			if (options.readBigInts) statement.setReadBigInts(true);
			return new SqliteStatement(statement);
		},
		batch: async (statements) => {
			database.exec('BEGIN IMMEDIATE');
			try {
				const results = statements.map(({ query, values = [] }) => {
					const statement = database.prepare(query);
					if (options.readBigInts) statement.setReadBigInts(true);
					const result = statement.run(...sqliteValues(values));
					return { success: true, meta: { changes: Number(result.changes), lastRowId: result.lastInsertRowid.toString() } };
				});
				database.exec('COMMIT');
				return results;
			} catch (error) {
				database.exec('ROLLBACK');
				throw error;
			}
		},
		exec: async (query) => { database.exec(query); },
		transaction: async (callback) => {
			database.exec('BEGIN IMMEDIATE');
			try { const result = await callback(adapter); database.exec('COMMIT'); return result; }
			catch (error) { database.exec('ROLLBACK'); throw error; }
		},
		close: () => database.close(),
	};
	return adapter;
};
