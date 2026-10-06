import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import PATHS from '../src/lib/paths.js';

const stateFile = PATHS.streamState;
const data = JSON.parse(readFileSync(stateFile, 'utf8'));
data.desiredState = 'running';
writeFileSync(stateFile, JSON.stringify(data, null, 2), 'utf8');
console.log(`Updated ${stateFile}: desiredState = running`);
