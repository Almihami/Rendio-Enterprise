#!/usr/bin/env bash
# Set de pruebas E2E de Rendio Turnos contra DEV (ambiente de prueba).
# Crea/borra datos desechables; no toca data real. Cada bloque imprime PASS/FAIL.
# Uso:  cd rendio-backend/scripts && ./verify-all.sh
# (requiere red a supabase.co)
set -e
cd "$(dirname "$0")"
set -a; source ../.env.dev; set +a

SCRIPTS=(verify-bugs verify-bug5 verify-close verify-perfil)
fail=0
for s in "${SCRIPTS[@]}"; do
  echo ""
  echo "════════════════════════════════════════════════════"
  echo "  $s"
  echo "════════════════════════════════════════════════════"
  if ! node "$s.mjs"; then fail=1; fi
done

echo ""
echo "════════════════════════════════════════════════════"
if [ "$fail" = "0" ]; then echo "  ✅ TODOS LOS BLOQUES CORRIERON"; else echo "  ⚠️  ALGÚN BLOQUE FALLÓ — revisa arriba"; fi
echo "════════════════════════════════════════════════════"
