import type { DatabaseAdapter, DatabaseStatement } from './index.mjs';

type D1StatementLike = {
	bind: (...values: unknown[]) => D1StatementLike;
	first: <T>() => Promise<T | null>;
	all: <T>() => Promise<{ results: T[] }>;
	run: () => Promise<{ success?: boolean; meta?: Record<string, unknown> }>;
};

type D1RunResult = { success?: boolean; meta?: Record<string, unknown> };

const d1Values = (values: unknown[]) => values.map((value) =>
	value !== null && typeof value === 'object' && !(value instanceof Uint8Array) ? JSON.stringify(value) : value);

export type D1DatabaseLike = {
	prepare: (query: string) => D1StatementLike;
	batch?: (statements: D1StatementLike[]) => Promise<D1RunResult[]>;
	exec?: (query: string) => Promise<unknown>;
};

export const createD1Adapter = (database: D1DatabaseLike): DatabaseAdapter => ({
	dialect: 'sqlite',
	prepare: (query): DatabaseStatement => {
		const statement = database.prepare(query);
		return {
			bind: (...values) => { statement.bind(...d1Values(values)); return statement; },
			first: <T,>() => statement.first<T>(),
			all: <T,>() => statement.all<T>(),
			run: () => statement.run(),
		};
	},
	batch: database.batch ? async (statements) => database.batch?.(statements.map(({ query, values = [] }) => database.prepare(query).bind(...d1Values(values)))) ?? [] : undefined,
	exec: database.exec ? async (query) => { await database.exec?.(query); } : undefined,
});
