# Set de pruebas — Rendio Turnos (DEV)

App dev: https://rendio-turnos-dev.vercel.app
Conductor de prueba: **demo-conductor@rendio.test** / **DemoRendio2026!**

---

## A) Pruebas automáticas (backend, 1 comando)
```bash
cd rendio-backend/scripts && ./verify-all.sh
```
Crea conductores/vehículos desechables, ejerce los flujos con RLS real y limpia.
Esperado: **49/49 PASS** (Bugs 2/3/4 = 14 · Bug 5 = 14 · Cierre = 11 · Perfil/Strikes/Recompensas = 10).

---

## B) Pruebas manuales en el navegador (dev)

### Bug 3 — inicio de turno sin "duplicate key"
1. Login conductor → **Iniciar turno** → elige carro → inspección → fotos → km → confirmar.
2. ✅ Inicia sin error. Si pierdes señal y reintentas, **no** sale el duplicate key.

### Bug 5 — reserva dura (dos no toman el mismo carro)
1. Conductor A: elige un carro y toca **Continuar a inspección** (queda reservado).
2. Conductor B (otro login/incógnito): ese carro aparece **Reservado** y no lo puede elegir.

### Bug 2 — inspecciones en admin
1. Admin → **Inspecciones** → filtro **Todas**: aparecen también las inspecciones **limpias** (sin novedad).

### Bug 4 — vehículo bloqueado
1. Admin → **Ajustes → Vehículos**: un carro en mantenimiento/bloqueado muestra **Regresar a servicio** → vuelve a Disponible.

### Cierre de turno (Fase A)
1. Con un turno **activo**: la tarjeta verde muestra **cronómetro** + **Cerrar turno**.
2. Cerrar: km final (debe ser ≥ apertura), novedad (foto/video corto), comprobantes (foto + valor) → atestar → **Confirmar**.
3. ✅ Pantalla de éxito (km recorridos, duración).
4. Admin → **Inspecciones** → ese turno: aparece el **cierre** (km final, km recorridos, novedad) y los **comprobantes** (toca para ampliar).

### Perfil (Fase B)
1. Conductor → tab **Perfil**: foto (toca para subir la tuya), cédula, teléfono, licencia, base, vehículo del turno activo, cerrar sesión.

### Strikes (Fase C)
1. Admin asigna strikes al conductor (Personal). Conductor → Perfil → tarjeta de **Strikes**: escala ámbar→rojo; a 3 → suspensión la semana siguiente.

### Recompensas (Fase D)
1. Conductor → Perfil → **Recompensas**: km acumulado, niveles, carrusel (desbloqueo por km), **Redimir** → solicitud.
2. Admin → **Recompensas**: ve la solicitud, la marca **entregada**; puede crear/editar premios y ver **km por conductor**.

---
_Nota: todo esto está en DEV. Nada se ha promovido a producción (main) todavía._
