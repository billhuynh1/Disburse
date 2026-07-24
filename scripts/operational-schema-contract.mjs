export const EXPECTED_SCHEMA_VERSION = 35;

export const EXPECTED_MIGRATIONS = [
  ['0000_soft_the_anarchist','5a710a65173f1c510ebe80d425fbaa0696bdc850f77be850e3bff22e5bcc5ebb'],
  ['0001_right_callisto','a4b769d0ea51539f2a12c7b7da764b5c00dd848495205dd0fa7fef445fc67a28'],
  ['0002_thankful_johnny_blaze','e05cc639c411e8642016f819b18341f37ea45e4d2e3578cef6df34d2349fd349'],
  ['0003_solid_whirlwind','a4907bd81f3974e2eea4a2272aac6b172e9efaf93de3005b8263617f7b0ee32b'],
  ['0004_short_lily_hollister','e5ca6540eb1042438b92b47e95e8b9caf1342a55aea48da7ee45e3bdda06ac05'],
  ['0005_brave_mac_gargan','7e60b24ccda9d08d942a0e1b8b3a3e28be1030ce487f4c6ca5f5973cf01af03a'],
  ['0006_tan_captain_marvel','0b369ab21394e89527f33a5127b4618ba78ddcd6de3dd309db4df135d87668c7'],
  ['0007_organic_killraven','ecef88f006de6288f8dd89917136da0380856971443fe1948aacb5ee4240633e'],
  ['0008_aromatic_carnage','ce99c86d5a6660b26f84d06c6f144d9c7b7f4cbd9f713901d0bed2de5a172262'],
  ['0009_temporary_media_retention','e2a652e6eb335d72670122ebeeb93a8d48cb4b8a4ee5b0bc02eb752c536deea2'],
  ['0010_temporary_project_retention','920f6e17b8a042f37ce8a999047f6aeac932564d66a25604160cb57798501c6f'],
  ['0011_early_union_jack','1a83da33841b9a23cc9c9d91a7aa8fc6a58682933ba3e98c400f39a64c92d15c'],
  ['0012_mute_lila_cheney','b56d8a6aea4f3b4ba9e16ef64f428b9c3a77f1c6b4a7438ac6376dd446573881'],
  ['0013_quiet_rocket_raccoon','4e069794d9f30d837347d78dcaf8882ecd7a6c058585f5f158ee057b4b246489'],
  ['0014_jazzy_misty_knight','85b5edc81c81050238930af48f40d63c80ea0daf238e5e229a8eff94cdd9d61a'],
  ['0015_quick_molten_man','adf5b9231b96779724a387655473794c1a3bb94ddfa3f2443cbc3a435a7ce591'],
  ['0016_equal_korg','4166bd0532fd5335e31d272022e28c06abce8aef3dc24dd55c1037138fd81c87'],
  ['0017_clip_edit_configs','a8b4e7407d2d937dbd563f0aa6602670efa9af434b80a5c47db0456b4e38bb6d'],
  ['0018_pipeline_generation_runs','ad1db6b9ebf5d6d31c652ab0de5dbc3a4859b298718de9d7bda711db92121760'],
  ['0019_facecam_debug_reason','be8b065e26d675ea75f6b9809f931cd1422633363c2f491832efbab01c3a7c07'],
  ['0021_facecam_generation_run_backfill','6fb0855723329751209948029d3de4bb43898f59940f29aaa2ef823b6e234b82'],
  ['0023_video_facecam_segments','c37051aa168e35b4f3966b95dc751ba9ad047dd780ae9af8790a7256c4444ab7'],
  ['0024_brand_templates','ced9645bae163b772c772adc5d5c8e8949d291f25b6085dd49fc608094b5e972'],
  ['0025_clip_render_configs','ca274446a26678ae764d58ea268b960fe6d5bf4c42dfdeca8bb0539c2e2cfa8c'],
  ['0026_brand_template_caption_style','cf792a801463616a1a3a30e267d97215dafe741c0a378103fe23242961a73303'],
  ['0027_source_multipart_uploads','e86214ea27581038dc6587e5e800baaae76d46b42519ae6419d79317ed2855c1'],
  ['0028_candidate_facecam_detection_runs','3af97723ca4bb0488179be80d5fb796981c6e88e534b74c1361551dab94d8350'],
  ['0029_durable_job_leases','5ac62c3652f4a08e7cdce455ef70d90e2f876cc15c4bbbf82d2314c7286e571b'],
  ['0030_lifecycle_intent','f1350995fee36fbcc7c65caf458a153b152d3a0d93cbb23384f651056b9bff64'],
  ['0031_monotonic_deletion_intent','ed2693b5e4012dbdeb00f58aec9541866fab4e7d06342ed1c031d035685411f2'],
  ['0032_pipeline_scheduler_state','ef9028fd9ec0bb3b605d1a822493c1ae06f63b77d2099e889b28b10867ac351e'],
  ['0033_durable_job_recovery','2f8302f1a333b51cecffdad9d28bc7e63d6470b573167dd4b8c2ea49ee87203a'],
  ['0034_operational_verification','583ee24d0eb061a09ca6d8d40ecc0f3878d53071e8ae04a7d92c4f75e243ed78'],
  ['0035_operational_verification_remediation','fcb566955897c3d876fe797f533bf4f0cfb143086e8deb726c30754a98960ab0'],
];

export const EXPECTED_JOURNAL_TIMESTAMPS = new Map([
  ['0033_durable_job_recovery', 1784508809302],
  ['0034_operational_verification', 1784508809303],
  ['0035_operational_verification_remediation', 1784508809304],
]);

const c = (table, column, dataType, udtName, nullable, defaultValue = null, characterMaximumLength = null) =>
  ({ table_name: table, column_name: column, data_type: dataType, udt_name: udtName, is_nullable: nullable ? 'YES' : 'NO', column_default: defaultValue, character_maximum_length: characterMaximumLength });

export const EXPECTED_COLUMNS = [
  c('operational_invocations','id','integer','int4',false,'serial'),
  c('operational_invocations','invocation_id','character varying','varchar',false,null,36),
  c('operational_invocations','origin','character varying','varchar',false,null,20),
  c('operational_invocations','status','character varying','varchar',false,null,20),
  c('operational_invocations','stop_reason','character varying','varchar',true,null,40),
  c('operational_invocations','failure_class','character varying','varchar',true,null,30),
  c('operational_invocations','failure_code','character varying','varchar',true,null,80),
  c('operational_invocations','processed_jobs','integer','int4',false,'0'),
  c('operational_invocations','recovered_jobs','integer','int4',false,'0'),
  c('operational_invocations','reconciled_projects','integer','int4',false,'0'),
  c('operational_invocations','reconciliation_cycle','bigint','int8',true),
  c('operational_invocations','follow_up_triggered','boolean','bool',false,'false'),
  c('operational_invocations','duration_ms','integer','int4',true),
  c('operational_invocations','started_at','timestamp without time zone','timestamp',false,'now()'),
  c('operational_invocations','completed_at','timestamp without time zone','timestamp',true),
  c('operational_invocations','created_at','timestamp without time zone','timestamp',false,'now()'),
  c('operational_signals','id','integer','int4',false,'serial'),
  c('operational_signals','signal_type','character varying','varchar',false,null,40),
  c('operational_signals','provider','character varying','varchar',true,null,20),
  c('operational_signals','failure_class','character varying','varchar',true,null,30),
  c('operational_signals','created_at','timestamp without time zone','timestamp',false,'now()'),
  c('pipeline_scheduler_state','reconciliation_progress_at','timestamp without time zone','timestamp',true),
  c('pipeline_scheduler_state','reconciliation_progress_count','bigint','int8',false,'0'),
];

export const EXPECTED_CONSTRAINTS = {
  operational_invocations_origin_check: { tableName: 'operational_invocations', type: 'c', validated: true, definition: "CHECK (((origin)::text = ANY ((ARRAY['internal'::character varying, 'cron'::character varying])::text[])))" },
  operational_invocations_status_check: { tableName: 'operational_invocations', type: 'c', validated: true, definition: "CHECK (((status)::text = ANY ((ARRAY['running'::character varying, 'completed'::character varying, 'failed'::character varying])::text[])))" },
  operational_invocations_counts_check: { tableName: 'operational_invocations', type: 'c', validated: true, definition: 'CHECK (((processed_jobs >= 0) AND (recovered_jobs >= 0) AND (reconciled_projects >= 0)))' },
  operational_signals_type_check: { tableName: 'operational_signals', type: 'c', validated: true, definition: "CHECK (((signal_type)::text = ANY ((ARRAY['internal_trigger_failure'::character varying, 'provider_failure'::character varying, 'capacity_blocked'::character varying, 'unknown_failure'::character varying])::text[])))" },
  operational_signals_provider_check: { tableName: 'operational_signals', type: 'c', validated: true, definition: "CHECK (((provider IS NULL) OR ((provider)::text = ANY ((ARRAY['openai'::character varying, 's3'::character varying, 'media'::character varying, 'render'::character varying, 'facecam'::character varying])::text[]))))" },
  operational_signals_failure_class_check: { tableName: 'operational_signals', type: 'c', validated: true, definition: "CHECK (((failure_class IS NULL) OR ((failure_class)::text = ANY ((ARRAY['transient'::character varying, 'safe_retry'::character varying, 'permanent'::character varying, 'ambiguous_external_effect'::character varying, 'cancellation'::character varying, 'unknown'::character varying])::text[]))))" },
};

export const EXPECTED_INDEXES = {
  operational_invocations_invocation_id_idx: { unique: true, method: 'btree', expressions: ['invocation_id'], predicate: null },
  operational_invocations_origin_started_idx: { unique: false, method: 'btree', expressions: ['origin','started_at'], predicate: null },
  operational_invocations_status_started_idx: { unique: false, method: 'btree', expressions: ['status','started_at'], predicate: null },
  operational_signals_type_created_idx: { unique: false, method: 'btree', expressions: ['signal_type','created_at'], predicate: null },
};

const normalizeDefault = (value) => value == null ? null
  : /^nextval\(/.test(value) ? 'serial' : value.replaceAll('::boolean','').trim();
const normalizeConstraintDefinition = (value) => value.trim().replace(/\s+/g, ' ');
const normalizeExpression = (value) => value == null ? null : value.replaceAll('"','').replace(/^\w+\./,'').trim();

export function validateMigrationJournal(rows) {
  const actual = rows.map(row => [row.tag ?? null, row.hash]);
  return actual.length === EXPECTED_MIGRATIONS.length && actual.every((row, index) =>
    row[0] === EXPECTED_MIGRATIONS[index][0] && row[1] === EXPECTED_MIGRATIONS[index][1])
    ? [] : ['database migration journal is not the exact ordered Phase-6 journal'];
}

export function validateLocalMigrationJournal(entries) {
  const failures = [];
  if (!Array.isArray(entries)) return ['local migration journal entries must be an array'];
  if (entries.length !== EXPECTED_MIGRATIONS.length) failures.push('local migration journal is missing expected entries');
  const seenTags = new Set();
  const seenTimestamps = new Set();
  let previousTimestamp = null;
  for (const [index, entry] of entries.entries()) {
    const expectedTag = EXPECTED_MIGRATIONS[index]?.[0];
    if (entry?.idx !== index) failures.push(`local migration journal idx is inconsistent at ${entry?.tag ?? index}`);
    if (entry?.version !== '7') failures.push(`local migration journal version is incompatible at ${entry?.tag ?? index}`);
    if (entry?.breakpoints !== true) failures.push(`local migration journal breakpoint flag is incompatible at ${entry?.tag ?? index}`);
    if (entry?.tag !== expectedTag) failures.push(`local migration journal tag is out of order at index ${index}`);
    if (typeof entry?.when !== 'number' || !Number.isSafeInteger(entry.when)) {
      failures.push(`local migration journal timestamp is missing at ${entry?.tag ?? index}`);
    } else {
      if (previousTimestamp !== null && entry.when <= previousTimestamp) {
        failures.push(`local migration journal timestamp must increase at ${entry.tag}`);
      }
      if (seenTimestamps.has(entry.when)) failures.push(`local migration journal timestamp is duplicated at ${entry.tag}`);
      const expectedTimestamp = EXPECTED_JOURNAL_TIMESTAMPS.get(entry.tag);
      if (expectedTimestamp !== undefined && entry.when !== expectedTimestamp) {
        failures.push(`local migration journal timestamp is not deterministic for ${entry.tag}`);
      }
      seenTimestamps.add(entry.when);
      previousTimestamp = entry.when;
    }
    if (seenTags.has(entry?.tag)) failures.push(`local migration journal tag is duplicated at ${entry.tag}`);
    seenTags.add(entry?.tag);
  }
  return failures;
}

export function validateOperationalCatalog({ schemaName, columns, constraints, indexes }) {
  const failures = [];
  const columnByKey = new Map(columns.map(column => [`${column.table_name}.${column.column_name}`, column]));
  for (const expected of EXPECTED_COLUMNS) {
    const key = `${expected.table_name}.${expected.column_name}`;
    const actual = columnByKey.get(key);
    if (!actual || actual.data_type !== expected.data_type || actual.udt_name !== expected.udt_name ||
      actual.is_nullable !== expected.is_nullable || normalizeDefault(actual.column_default) !== expected.column_default ||
      (actual.character_maximum_length ?? null) !== expected.character_maximum_length) {
      failures.push(`database column is incompatible: ${key}`);
    }
  }
  for (const table of ['operational_invocations','operational_signals']) {
    const expected = new Set(EXPECTED_COLUMNS.filter(column => column.table_name === table).map(column => column.column_name));
    for (const actual of columns.filter(column => column.table_name === table)) {
      if (!expected.has(actual.column_name)) failures.push(`database has unexpected operational column: ${table}.${actual.column_name}`);
    }
  }
  for (const [name, expected] of Object.entries(EXPECTED_CONSTRAINTS)) {
    const matches = constraints.filter(constraint => constraint.conname === name);
    if (matches.length === 0) { failures.push(`database is missing constraint ${name}`); continue; }
    const actual = matches[0];
    if (matches.length !== 1 ||
      actual.conname !== name ||
      actual.schema_name !== schemaName || actual.table_name !== expected.tableName || actual.contype !== expected.type ||
      actual.convalidated !== expected.validated || normalizeConstraintDefinition(actual.definition) !== normalizeConstraintDefinition(expected.definition)) {
      failures.push(`database constraint is incompatible: ${name}`);
    }
  }
  const indexByName = new Map(indexes.map(index => [index.indexname, index]));
  for (const [name, expected] of Object.entries(EXPECTED_INDEXES)) {
    const actual = indexByName.get(name);
    const expressions = actual?.expressions?.map(normalizeExpression);
    if (!actual || actual.unique !== expected.unique || actual.method !== expected.method ||
      JSON.stringify(expressions) !== JSON.stringify(expected.expressions) || normalizeExpression(actual.predicate) !== expected.predicate) {
      failures.push(`database index is incompatible: ${name}`);
    }
  }
  return failures;
}
