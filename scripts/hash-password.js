#!/usr/bin/env node
/**
 * scripts/hash-password.js — CLI utility to generate scrypt password hashes.
 *
 * PRD §19.1:
 * - Format: scrypt:<N>:<r>:<p>:<saltB64>:<hashB64>
 * - No $ signs (safe for systemd EnvironmentFile and shell sourcing).
 *
 * Usage:
 *   node scripts/hash-password.js
 *   node scripts/hash-password.js <password>
 */

import readline from 'node:readline';
import { hashPassword } from '../src/auth.js';

async function main() {
  let password = process.argv[2];

  if (!password) {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    password = await new Promise((resolve) => {
      rl.question('Enter admin password to hash: ', (answer) => {
        rl.close();
        resolve(answer.trim());
      });
    });
  }

  if (!password) {
    console.error('Error: Password cannot be empty.');
    process.exit(1);
  }

  try {
    const hash = await hashPassword(password);
    console.log('\n--- Generated Hash ---');
    console.log(hash);
    console.log('\nAdd to /etc/yt-live-manager/env as:');
    console.log(`ADMIN_PASSWORD_HASH=${hash}\n`);
  } catch (err) {
    console.error('Failed to hash password:', err.message);
    process.exit(1);
  }
}

main();
