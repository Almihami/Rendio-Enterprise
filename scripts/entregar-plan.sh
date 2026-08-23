#!/usr/bin/env bash
# EL ÚNICO CAMINO PARA MANDARLE UN PLAN A JULIÁN.
#
# Existe porque el 23-ago-2026 él preguntó por qué seguía repitiendo errores que
# yo ya había "arreglado". La respuesta fue incómoda: la regla estaba en el
# código y validada contra SUS planes, pero nadie comprobaba nunca que MI plan
# la cumpliera. El techo de madrugada de 60 min llevaba dos días desplegado con
# once personas por encima, hasta 85. Un auditor que se corre cuando uno se
# acuerda no es un control; es una intención. Por eso el mensaje ya no se
# imprime si la auditoría falla.
#
#   ./scripts/entregar-plan.sh "<xlsx del Google Form>" YYYY-MM-DD [extras...]
set -euo pipefail
cd "$(dirname "$0")/.."
XLSX="${1:?falta el xlsx del formulario}"; DIA="${2:?falta la fecha YYYY-MM-DD}"; shift 2
set -a; source .env.dev; set +a
TMP=$(mktemp -d)

python3 scripts/_form-dump.py "$XLSX" "$TMP/form.json"

# --plan-jefe=todos NO es opcional: sin él las casas salen del catálogo y no de
# sus correcciones, y hay gente que se cae por nombre ambiguo (el 23-ago, dos).
node scripts/plan-desde-formulario.mjs "$TMP/form.json" "$DIA" \
     --carros=3 --hueco=20 --plan-jefe=todos "$@" --json="$TMP/plan.json"

echo
if ! node scripts/_auditar-plan.mjs "$TMP/plan.json" "$TMP/form.json" "$DIA"; then
  echo
  echo "✗ LA AUDITORÍA FALLÓ — este plan NO se manda. Arreglar arriba y repetir." >&2
  exit 1
fi

echo
echo "════════ mensaje para Julián ════════"
node scripts/plan-a-whatsapp.mjs "$TMP/plan.json" | tee "scripts/planes-jefe/generado-$DIA.txt"
