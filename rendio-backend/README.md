# rendio-backend

Backend del MVP **Rendio Enterprises** — Supabase (PostgreSQL 15 + Auth + Realtime + Storage + Edge Functions Deno).

## Estructura

```
rendio-backend/
├── supabase/
│   ├── migrations/         # SQL versionado (NNNN_descripcion.sql)
│   ├── functions/          # Edge Functions Deno
│   ├── seed.sql            # datos demo (no producción)
│   └── config.toml
├── scripts/                # utilidades locales
├── tests/                  # pg_prove tests RLS
├── docs/                   # ERD (Mermaid + DBML), notas
├── CLAUDE.md               # instrucciones Claude para este sub-repo
└── README.md
```

Detalle de comandos, convenciones y mapeo arquitectura ↔ migrations en `CLAUDE.md`.

## Setup rápido

```bash
# Pre-requisitos: Supabase CLI, Deno
# Cargar credenciales del .env.local.dev raíz
set -a; source ../.env.local.dev; set +a

supabase login
supabase link --project-ref $SUPABASE_PROJECT_REF
supabase db push          # aplica migrations a rendio-dev
```

## Documentación

- Arquitectura: `../Arquitectura` (raíz del workspace).
- Backlog operativo: `../Backlog_Rendio_MVP_ClickUp.xlsx` hoja "4. Backlog ClickUp".
- ERD visual: `docs/erd.mmd` (Mermaid, renderiza en GitHub) | `docs/erd.dbml` (pegar en https://dbdiagram.io).

## Estado

Entrega 1 — Fundación Técnica (en progreso). Próximas tareas: E1.04 a E1.09.
