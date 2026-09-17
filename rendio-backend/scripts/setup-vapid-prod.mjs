#!/usr/bin/env node
// Genera un par VAPID nuevo y lo setea como secrets en el proyecto Supabase.
// Imprime SOLO la clave PÚBLICA (va en config.js). La PRIVADA nunca se imprime
// ni queda en disco: va directo al secret vía un env-file temporal que se borra.
//
// Uso:
//   node scripts/setup-vapid-prod.mjs .env.main
//
// Requiere en el .env: SUPABASE_PROJECT_REF y SUPABASE_ACCESS_TOKEN.

import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function loadEnv(file) {
  const t = readFileSync(file, 'utf8');
  const g = (k) => {
    const m = t.match(new RegExp('^' + k + '=(.*)$', 'm'));
    return m ? m[1].replace(/^"|"$/g, '').trim() : null;
  };
  const ref = g('SUPABASE_PROJECT_REF');
  const token = g('SUPABASE_ACCESS_TOKEN');
  if (!ref || !token) throw new Error(`Faltan SUPABASE_PROJECT_REF o SUPABASE_ACCESS_TOKEN en ${file}`);
  return { ref, token };
}

function genVapid() {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const pub = publicKey.export({ format: 'jwk' });
  const priv = privateKey.export({ format: 'jwk' });
  const b = (s) => Buffer.from(s, 'base64url');
  const pubRaw = Buffer.concat([Buffer.from([4]), b(pub.x), b(pub.y)]);
  return { publicKey: pubRaw.toString('base64url'), privateKey: priv.d };
}

function main() {
  const envFile = process.argv[2];
  if (!envFile) {
    console.error('Uso: node scripts/setup-vapid-prod.mjs <.env.dev|.env.main>');
    process.exit(1);
  }
  const { ref, token } = loadEnv(envFile);
  const { publicKey, privateKey } = genVapid();

  // env-file temporal (modo 600) con los secrets; se borra en finally.
  const tmp = join(tmpdir(), `vapid-${randomUUID()}.env`);
  writeFileSync(
    tmp,
    `VAPID_PUBLIC_KEY=${publicKey}\nVAPID_PRIVATE_KEY=${privateKey}\nVAPID_SUBJECT=mailto:admin@rendio.co\n`,
    { mode: 0o600 },
  );
  try {
    execFileSync('supabase', ['secrets', 'set', '--env-file', tmp, '--project-ref', ref], {
      env: { ...process.env, SUPABASE_ACCESS_TOKEN: token },
      stdio: ['ignore', 'inherit', 'inherit'],
    });
  } finally {
    try { unlinkSync(tmp); } catch { /* ignore */ }
  }

  console.log('\n===== VAPID configurado en prod. Copia SOLO esta línea para Claude: =====');
  console.log('VAPID_PUBLIC_KEY=' + publicKey);
  console.log('===== (la clave privada ya quedó como secret; NO la compartas) =====');
}

main();
