export function readiness(results: PromiseSettledResult<unknown>[]) {
  const value = (index: number): any => results[index]?.status === 'fulfilled' ? (results[index] as PromiseFulfilledResult<unknown>).value : undefined;
  const db = value(0);
  const dependencies = {
    database: Array.isArray(db?.rows) && db.rows.length === 1 && db.rows[0].version === 1,
    engine: value(1)?.ready === true,
    runner: value(2)?.ready === true,
  };
  return { ready: Object.values(dependencies).every(Boolean), dependencies };
}
