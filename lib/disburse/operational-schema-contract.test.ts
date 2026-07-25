import assert from 'node:assert/strict';
import test from 'node:test';

import { EXPECTED_COLUMNS, EXPECTED_CONSTRAINTS, EXPECTED_INDEXES, EXPECTED_JOURNAL_TIMESTAMPS, EXPECTED_MIGRATIONS,
  EXPECTED_SNAPSHOT_TAGS, validateLocalMigrationJournal, validateMigrationFiles, validateMigrationJournal, validateOperationalCatalog, validateSnapshotChain } from '../../scripts/operational-schema-contract.mjs';

function validCatalog(): {
  schemaName: string;
  columns: Array<Record<string, unknown>>;
  constraints: Array<Record<string, unknown> & { conname: string; definition: string }>;
  indexes: Array<Record<string, unknown> & { indexname: string }>;
} {
  const schemaName = 'phase6_contract';
  const columns = structuredClone(EXPECTED_COLUMNS).map((column: Record<string, unknown>) => ({
    ...column,
    column_default: column.column_default === 'serial' ? `nextval('isolated_id_seq'::regclass)` : column.column_default,
  }));
  const constraints = Object.entries(EXPECTED_CONSTRAINTS).map(([conname, value]) => ({
    conname, schema_name: schemaName, table_name: value.tableName, contype: value.type,
    convalidated: value.validated, definition: value.definition,
  }));
  const indexes = Object.entries(EXPECTED_INDEXES).map(([indexname, value]) => ({ indexname, ...(value as object) }));
  return { schemaName, columns, constraints, indexes };
}

test('authoritative operational schema contract accepts only the exact catalog', () => {
  assert.deepEqual(validateOperationalCatalog(validCatalog()), []);
});

test('schema contract rejects wrong columns, constraint identity metadata, and indexes', () => {
  for (const mutate of [
    (catalog: ReturnType<typeof validCatalog>) => { catalog.columns[1].data_type = 'text'; },
    (catalog: ReturnType<typeof validCatalog>) => { catalog.columns[1].is_nullable = 'YES'; },
    (catalog: ReturnType<typeof validCatalog>) => { catalog.columns[7].column_default = '1'; },
    (catalog: ReturnType<typeof validCatalog>) => { catalog.constraints[0].conname = 'renamed_constraint'; },
    (catalog: ReturnType<typeof validCatalog>) => { catalog.constraints[0].schema_name = 'copied_schema'; },
    (catalog: ReturnType<typeof validCatalog>) => { catalog.constraints[0].table_name = 'operational_signals'; },
    (catalog: ReturnType<typeof validCatalog>) => { catalog.constraints[0].contype = 'u'; },
    (catalog: ReturnType<typeof validCatalog>) => { catalog.constraints[0].convalidated = false; },
    (catalog: ReturnType<typeof validCatalog>) => { catalog.indexes[0].unique = false; },
    (catalog: ReturnType<typeof validCatalog>) => { catalog.indexes[3].predicate = 'signal_type is not null'; },
  ]) {
    const catalog = validCatalog();
    mutate(catalog);
    assert.ok(validateOperationalCatalog(catalog).length > 0);
  }
});

test('constraint comparison normalizes whitespace only', () => {
  const catalog = validCatalog();
  catalog.constraints[0].definition = `  ${catalog.constraints[0].definition.replaceAll(' ', '   \n ')}  `;
  assert.deepEqual(validateOperationalCatalog(catalog), []);
});

test('exact canonical constraint definitions reject every semantic mutation', () => {
  const mutateDefinition = (name: string, mutate: (definition: string) => string) => {
    const catalog = validCatalog();
    const constraint = catalog.constraints.find(item => item.conname === name)!;
    constraint.definition = mutate(constraint.definition);
    assert.deepEqual(validateOperationalCatalog(catalog), [`database constraint is incompatible: ${name}`]);
  };
  mutateDefinition('operational_invocations_origin_check', definition => definition.replace('= ANY', '<> ALL'));
  mutateDefinition('operational_invocations_counts_check', definition => definition.replace('processed_jobs >= 0', 'processed_jobs > 0'));
  mutateDefinition('operational_invocations_counts_check', definition => definition.replace(' AND ', ' OR '));
  mutateDefinition('operational_invocations_counts_check', () => 'CHECK (((processed_jobs >= 0) AND ((recovered_jobs >= 0) OR (reconciled_projects >= 0))))');
  mutateDefinition('operational_signals_provider_check', definition => definition.replace('(provider IS NULL) OR ', ''));
  mutateDefinition('operational_signals_type_check', definition => definition.replace("'unknown_failure'::character varying", "'unknown_failure'::character varying, 'extra'::character varying"));
  mutateDefinition('operational_invocations_status_check', definition => definition.replace("'running'::character varying", "'running'::text"));
  mutateDefinition('operational_invocations_counts_check', definition => definition.replace('reconciled_projects >= 0', 'reconciled_projects >= 1'));
});

test('copied hashes cannot bless incompatible objects and journal order is exact', () => {
  const journal = EXPECTED_MIGRATIONS.map(
    ([tag, hash]) => ({ tag, hash, created_at: String(EXPECTED_JOURNAL_TIMESTAMPS.get(tag)) })
  );
  assert.deepEqual(validateMigrationJournal(journal), []);
  const incompatible = validCatalog();
  incompatible.constraints[0].definition = incompatible.constraints[0].definition.replace('= ANY', '<> ALL');
  assert.ok(validateOperationalCatalog(incompatible).length > 0);
  for (const candidate of [
    journal.slice(1),
    [journal[1], journal[0], ...journal.slice(2)],
    [...journal, { tag: '0036_unexpected', hash: '0'.repeat(64) }],
    journal.map((row, index) => index === 3 ? { ...row, hash: 'f'.repeat(64) } : row),
    journal.map((row, index) => index === 3 ? { ...row, created_at: `${row.created_at}1` } : row),
    journal.map((row, index) => index === 3 ? { ...row, created_at: `${row.created_at}.0` } : row),
  ]) assert.ok(validateMigrationJournal(candidate).length > 0);
});

test('migration file and snapshot contracts reject unexplained and disconnected history', () => {
  const entries = EXPECTED_MIGRATIONS.map(([tag], idx) => ({ tag, idx }));
  const files = new Set(entries.map(entry => `${entry.tag}.sql`));
  assert.deepEqual(validateMigrationFiles(entries, files), []);
  assert.ok(validateMigrationFiles(entries.slice(1), files).length > 0);
  assert.ok(validateMigrationFiles(entries, new Set([...files, '0036_unexplained.sql'])).length > 0);
  assert.ok(validateMigrationFiles([...entries, { ...entries[0], idx: entries.length }], files).length > 0);

  const snapshots = EXPECTED_SNAPSHOT_TAGS.map((tag, index) => ({
    tag, id: `id-${tag}`, prevId: index === 0 ? '00000000-0000-0000-0000-000000000000' : `id-${EXPECTED_SNAPSHOT_TAGS[index - 1]}`,
    version: '7', dialect: 'postgresql',
  }));
  assert.deepEqual(validateSnapshotChain(snapshots), []);
  for (const mutate of [
    (candidate: typeof snapshots) => { candidate[16].prevId = 'wrong'; },
    (candidate: typeof snapshots) => { candidate[17].id = candidate[16].id; },
    (candidate: typeof snapshots) => { candidate.splice(5, 1); },
  ]) {
    const candidate = structuredClone(snapshots);
    mutate(candidate);
    assert.ok(validateSnapshotChain(candidate).length > 0);
  }
});

test('local migration journal rejects timestamp and metadata regressions', () => {
  const journal = EXPECTED_MIGRATIONS.map(
    ([tag], index) => ({
      idx: index,
      version: '7',
      when: expectedTimestamp(tag),
      tag,
      breakpoints: true,
    })
  );
  assert.deepEqual(validateLocalMigrationJournal(journal), []);
  for (const mutate of [
    (candidate: typeof journal) => { candidate[32].when = 1784073098338; },
    (candidate: typeof journal) => { candidate[33].when = candidate[32].when; },
    (candidate: typeof journal) => { delete (candidate[33] as Partial<typeof journal[number]>).when; },
    (candidate: typeof journal) => { candidate[6].idx = 7; },
    (candidate: typeof journal) => { candidate[7].tag = candidate[6].tag; },
    (candidate: typeof journal) => { candidate.splice(10, 1); },
    (candidate: typeof journal) => { candidate[20].breakpoints = false; },
  ]) {
    const candidate = structuredClone(journal);
    mutate(candidate);
    assert.ok(validateLocalMigrationJournal(candidate).length > 0);
  }
});

function expectedTimestamp(tag: string) {
  const timestamp = EXPECTED_JOURNAL_TIMESTAMPS.get(tag);
  assert.notEqual(timestamp, undefined);
  return timestamp;
}
