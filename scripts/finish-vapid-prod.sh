#!/bin/bash
# Completa VAPID en producción: genera el par, lo setea como secret en prod,
# imprime la pública, y re-despliega send-push para que tome las claves.
set -e
cd /Users/harold/Documents/Rendio-Drivers/Proyect/rendio-backend
set -a; source .env.main; set +a
echo "→ Generando VAPID + configurando secrets en prod..."
node scripts/setup-vapid-prod.mjs .env.main
echo ""
echo "→ Re-desplegando send-push (para que tome las claves)..."
supabase functions deploy send-push --project-ref "$SUPABASE_PROJECT_REF"
echo ""
echo "===== LISTO. Copia la línea 'VAPID_PUBLIC_KEY=...' de arriba y pégasela a Claude. ====="
