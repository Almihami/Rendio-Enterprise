# El formato de WhatsApp — el idioma de la operación

**Esto no es un plan bonito para mostrar: es el canal.** La programación se le pasa
al jefe en este formato y él devuelve las vueltas armadas en el mismo formato. Todo
va y viene por WhatsApp, escrito a mano. Es temporal —hasta que la app estabilice—
pero mientras tanto **el algoritmo tiene que leer y escribir en este formato**: no
puede pedir un Excel ni que alguien abra la PWA.

Deducido de los mensajes reales del jefe (viernes 7 y domingo 9 de agosto de 2026),
que están en esta misma carpeta. `analizar-plan-jefe.mjs` los parsea.

---

## La gramática

Un mensaje es una lista de **bloques separados por línea en blanco**. Cada bloque es
una vuelta (un carro, un recorrido).

```
3:10 Isa rivera (Mota)          ← hora de recogida · persona · dónde vive
3:15 Karol L (Viverdi)
3:20 gloria (Cambulo)
3:20 YERLY (Guayacan)
Deben estar 3:40                ← hora de presentación en el aeropuerto (deadline)
```

### Las líneas

| forma | qué es |
|---|---|
| `3:20 gloria (Cambulo)` | **salida**: recoger a Gloria en Cámbulo a las 3:20 |
| `12:00 Jessica y Erika (av9563)` | **llegada**: aterriza el vuelo AV9563 a las 12:00 |
| `11:30 Lau idarraga (hotel)` | recogida **en el hotel** |
| `17:10 Pau londo (Terra)` + `Va a hotel` | casa → **hotel** (el aeropuerto ni se toca) |
| `16:00 kris (Aero)` | va al aeropuerto **sin vuelo asignado**; se trata igual que cualquier tripulante |
| `Deben estar 3:40` / `Debe estar 4:45` / `Estar 10:40` | deadline del bloque, las tres formas valen |
| `Estar 11:20 y hotel` | cumple el deadline en el aeropuerto **y después** deja en el hotel |
| `Hotel y aero` | pasa por el hotel y sigue al aeropuerto |

### Reglas de lectura

- **La hora de la izquierda cambia de significado según el tipo**: en salidas es la
  hora de **recogida en la casa**; en llegadas es la hora en que **aterriza el vuelo**.
- **Las llegadas no llevan deadline**, solo el vuelo.
- **Una línea puede ser varias personas**: `Erika, Jolene y Juanita (Olivar)` son 3,
  `Sánchez y Michel (Río vivo)` son 2. **Cuentan para el cupo.**
- **Viajan familiares sin perfil en el sistema**: `papa Melina (Cerezos)`,
  `guancha y papas`. Ocupan puesto, no tienen cuenta. (Asumido 10-ago-2026.)
- Los nombres son **apodos o solo el nombre de pila**: `rico` = Catalina Rico,
  `cano` = Camila Cano, `gallón` = Daniel Gallón, `David` = David Estrada.
  Hay que amarrarlos por coincidencia difusa contra `profiles.full_name`.
- **Está escrito a mano y tiene dedazos**: `Estar 18;35` (punto y coma), `13.45`
  (punto), mayúsculas irregulares (`YERLY`), tildes que faltan. El parser los tolera
  en silencio; no es error del jefe, es un mensaje de WhatsApp.
- Prefijos de vuelo: `AV` Avianca · `JA`/`JEC` JetSmart · `P5`/`P` Wingo. El tiempo
  de desembarque depende de la aerolínea y de si es nacional o internacional
  (migración 0058).

---

## Cómo arma el jefe una vuelta (medido contra los dos mensajes)

1. **El cupo son 4 personas, no 4 paradas.** Una parada con 3 personas cierra la vuelta.
2. **Entre paradas deja 5–10 minutos** (15–20 si el conjunto queda lejos). Coincide
   con OSRM dentro de ±3 min: en el paso entre casas el jefe y el sistema ya piensan igual.
3. **Última recogida + 20 min = "deben estar".** Un forfait plano, no calculado. Lo sube
   a 30–35 solo cuando el conjunto "queda lejos" (Marinilla, San Sebastián, Torres del
   Campo, Cantabria, Hábitat).
4. **Un solo deadline por vuelta**: unifica al grupo, no respeta la presentación
   individual de cada quien.
5. **Todo en múltiplos de 5**, salvo las llegadas, que copian la hora exacta del vuelo
   (13:01, 16:54, 23:36).
6. **No fusiona bloques separados por más de ~15 min** aunque haya carro libre.
7. **Agrupa llegadas de vuelos cercanos** en un mismo carro: 21:15 + 21:25 + 21:30.
8. **El criterio cambia según el día**: el viernes usó 20 min casi siempre; el domingo
   bajó a 15 desde Cámbulo y subió a 30–35 en los lejanos.

---

## Dónde no coincide con nuestro modelo

- **OSRM cree que en Rionegro se anda a 28 km/h.** El jefe hace Río Vivo→MDE (13,2 km)
  en 20 min = **40 km/h**. Por eso nuestros carros salen antes que los suyos, y por eso
  el solver dejaba 10 traslados "sin rutear" en un día que la operación mueve con 3 carros.
  Ensayar con `plan-del-dia.mjs --trafico=0.75`.
- **El hotel** ya tiene coordenada desde la migración 0059 (`app_settings.route_hotel_*`),
  pero el solver todavía no lo rutea: manda esa persona al aeropuerto. Meterlo como
  parada de paso cuesta **+0,2 min** — está sobre la vía.
- **`Estar HH:MM y hotel`**: manda el deadline del aeropuerto; el hotel va después.

---

## Lo que falta para cerrar el ciclo

- **Entrada**: mensaje de WhatsApp → reservas en dev (parser + amarre de apodos a personas).
- **Salida**: plan del algoritmo → **este mismo formato**, para copiar y pegar. Hoy
  `plan-del-dia.mjs` imprime formato de tablero, que por WhatsApp no le sirve a nadie.
