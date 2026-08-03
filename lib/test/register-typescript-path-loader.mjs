import { register } from 'node:module';

process.env.POSTGRES_URL ??= 'postgres://test:test@127.0.0.1:1/disburse_unit_test';

register('./typescript-path-loader.mjs', import.meta.url);
