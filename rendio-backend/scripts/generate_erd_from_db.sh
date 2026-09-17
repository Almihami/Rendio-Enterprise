#!/usr/bin/env bash
# Genera docs/erd_from_db.mmd a partir del schema REAL aplicado en rendio-dev.
# Útil para verificar que el ERD diseñado (docs/erd.mmd) sigue coincidiendo con
# lo aplicado a la BD tras nuevas migrations.
#
# Requiere:
#   - psql (libpq instalado: brew install libpq)
#   - python3
#   - .env.local.dev raíz con SUPABASE_DB_* vars
#
# Uso: ./scripts/generate_erd_from_db.sh

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENV_FILE="$ROOT/.env.local.dev"
OUT_FILE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/docs/erd_from_db.mmd"

[ -f "$ENV_FILE" ] || { echo "ERROR: no existe $ENV_FILE" >&2; exit 1; }
set -a; source "$ENV_FILE"; set +a

PSQL="${PSQL:-/opt/homebrew/opt/libpq/bin/psql}"
[ -x "$PSQL" ] || PSQL="$(command -v psql || true)"
[ -n "$PSQL" ] || { echo "ERROR: psql no encontrado. brew install libpq" >&2; exit 1; }

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

CONN="host=$SUPABASE_DB_HOST port=$SUPABASE_DB_PORT user=$SUPABASE_DB_USER dbname=$SUPABASE_DB_NAME sslmode=require"

echo "→ Introspectando schema public..."

PGPASSWORD="$SUPABASE_DB_PASSWORD" "$PSQL" "$CONN" -t -A -F $'\t' -c "
SELECT c.table_name,
       col.column_name,
       col.data_type,
       col.udt_name,
       col.is_nullable,
       (col.column_name = ANY(
         SELECT kcu.column_name FROM information_schema.table_constraints tc
         JOIN information_schema.key_column_usage kcu USING (constraint_name, table_schema)
         WHERE tc.table_schema='public' AND tc.table_name=c.table_name AND tc.constraint_type='PRIMARY KEY'
       )) AS is_pk
FROM information_schema.tables c
JOIN information_schema.columns col USING (table_schema, table_name)
WHERE c.table_schema='public' AND c.table_type='BASE TABLE'
ORDER BY c.table_name, col.ordinal_position;
" > "$TMP_DIR/columns.tsv"

PGPASSWORD="$SUPABASE_DB_PASSWORD" "$PSQL" "$CONN" -t -A -F $'\t' -c "
SELECT tc.table_name AS from_table,
       kcu.column_name AS from_column,
       ccu.table_name AS to_table,
       ccu.column_name AS to_column
FROM information_schema.table_constraints tc
JOIN information_schema.key_column_usage kcu USING (constraint_name, table_schema)
JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name=tc.constraint_name AND ccu.table_schema=tc.table_schema
WHERE tc.table_schema='public' AND tc.constraint_type='FOREIGN KEY'
ORDER BY tc.table_name, kcu.ordinal_position;
" > "$TMP_DIR/fks.tsv"

echo "→ Renderizando Mermaid..."

python3 - "$TMP_DIR/columns.tsv" "$TMP_DIR/fks.tsv" > "$OUT_FILE" <<'PYEOF'
import sys, datetime
from collections import defaultdict

cols_path, fks_path = sys.argv[1], sys.argv[2]

cols_by_table = defaultdict(list)
with open(cols_path) as f:
    for line in f:
        line = line.rstrip('\n')
        if not line:
            continue
        parts = line.split('\t')
        if len(parts) < 6:
            continue
        table, name, dtype, udt, nullable, is_pk = parts
        type_map = {
            'character varying': 'text',
            'timestamp with time zone': 'timestamptz',
            'timestamp without time zone': 'timestamp',
            'double precision': 'double',
            'USER-DEFINED': udt,
            'integer': 'int',
            'bigint': 'bigint',
            'boolean': 'bool',
            'uuid': 'uuid',
            'jsonb': 'jsonb',
            'date': 'date',
            'real': 'real',
            'numeric': 'numeric',
            'text': 'text',
        }
        clean_type = type_map.get(dtype, dtype).replace(' ', '_')
        cols_by_table[table].append({
            'name': name,
            'type': clean_type,
            'nullable': nullable == 'YES',
            'is_pk': is_pk == 't',
        })

fks = []
fk_targets = set()
with open(fks_path) as f:
    for line in f:
        line = line.rstrip('\n')
        if not line:
            continue
        parts = line.split('\t')
        if len(parts) < 4:
            continue
        from_table, from_col, to_table, to_col = parts
        fks.append((from_table, from_col, to_table, to_col))
        fk_targets.add((from_table, from_col))

print('%% MER (Modelo Entidad-Relación) — generado por introspección desde rendio-dev')
print(f'%% Snapshot: {datetime.datetime.now().isoformat(timespec="seconds")}')
print('%% Refleja el estado REAL de la BD aplicada.')
print('%% Para regenerar: ./scripts/generate_erd_from_db.sh')
print('%% Renderizable en GitHub o https://mermaid.live')
print('')
print('erDiagram')

for from_t, from_c, to_t, to_c in fks:
    label = f"{from_c}__{to_c}"
    print(f'    {to_t} ||--o{{ {from_t} : "{label}"')
print('')

for table in sorted(cols_by_table.keys()):
    print(f'    {table} {{')
    for col in cols_by_table[table]:
        marks = []
        if col['is_pk']:
            marks.append('PK')
        if (table, col['name']) in fk_targets:
            marks.append('FK')
        marks_str = ' ' + ','.join(marks) if marks else ''
        comment = ' "NOT NULL"' if not col['nullable'] else ''
        print(f'        {col["type"]} {col["name"]}{marks_str}{comment}')
    print('    }')
PYEOF

echo "✓ ERD escrito en: $OUT_FILE"
echo "  $(wc -l < "$OUT_FILE") líneas"
