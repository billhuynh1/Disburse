import dotenv from 'dotenv';
import { register } from 'node:module';

dotenv.config({ path: '.env.local' });
dotenv.config();

register('./typescript-path-loader.mjs', import.meta.url);
