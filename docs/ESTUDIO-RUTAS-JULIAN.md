# Cómo despacha Julián — el estudio

Cómo arma la operación las rutas de tripulación, deducido de sus mensajes de
WhatsApp y medido contra el solver de la app. **Cada regla de aquí tiene una cita
suya y un número; si no los tiene, no es una regla, es una hipótesis.**

El ciclo: le pasamos el plan del algoritmo en su formato → él lo rehace a mano y lo
devuelve → medimos persona por persona dónde nos equivocamos → eso se vuelve regla.
Todo el corpus vive en `scripts/planes-jefe/`.

---

## 1. El barrido (2026-08-21, audio)

> *"Que hagan un barrido desde lo más lejano hasta el aeropuerto siempre... llega
> hasta donde Javier, desde ahí solo coja El Porvenir, Llanogrande o el aeropuerto."*

Cada vuelta de salida **arranca en la parada más lejana y de ahí solo se acerca.
Nunca se devuelve.** El "círculo / diámetro / circunferencia" del audio es él
buscando la palabra; lo que importa es la monotonía.

**La medida es MINUTOS DE CARRETERA, no kilómetros.** Su propio ejemplo lo prueba:

| conjunto | km al MDE | min al MDE |
|---|---|---|
| Ébano | 7,1 | **26** |
| Olivar (Fontibón) | 5,9 | **28** |

Por kilómetros, Ébano → Olivar es acercarse; por minutos, es devolverse. Nuestro
plan recogía a Javier en Ébano y después salía a Fontibón: exactamente lo que él
señaló.

**Sus "zonas" no son barrios, son anillos de distancia:**

```
Marinilla 43  →  Planté/Robledal/Ébano/Torres 26-33  →  FONTIBÓN 27-28
  →  PORVENIR 20-23  →  LLANOGRANDE 17  →  aeropuerto
```

**Saltar dentro de un anillo sí vale** (Cerezos 28 → Río Vivo 28; Piedemonte 27 →
Olivar 28). Empatar no es devolverse: tolerancia de 2 min (`route_sweep_tol_min`).

**Es restricción, no preferencia.** Antes de romper el barrido, saca otra vuelta
corta: deshizo tres de nuestras fusiones por esto, y armó 20 vueltas donde
nosotros armábamos 17.

**VALIDADO FUERA DE MUESTRA:** de los **32 bloques multiparada** de sus
correcciones del 18, 19, 20 y 21 de agosto, **cero rompen el barrido**.

**Y explica el "+20":** si la vuelta siempre cierra hacia adentro, la última parada
es la más cercana y el tramo final siempre mide ~20 min. Las dos reglas son la
misma vista por dos lados — cuando el barrido se rompe, el +20 deja de valer.

## 2. El tramo final: última recogida + 20

Forfait plano, no cálculo. Sobre las 19 vueltas de su plan oficial del 22-ago:
`[10, 15, 15, 20×12, 25×4]` — **mediana 20, y 14 de 19 son exactamente 20.**
Sube a 25-35 en los lejanos (Marinilla, San Sebastián, Cantabria, Hábitat), baja a
15 en los cercanos. Verificado antes sobre 99 vueltas: no depende de la distancia
ni de la hora del día.

## 3. El techo de madrugada: 60 minutos

Nadie se recoge más de **60 min antes de SU PROPIA presentación** por acompañar a
otro. En sus 20 vueltas del 22-ago la anticipación va de 20 a 60 y nunca pasa de
60. Las fusiones que deshizo pasaban: Erika quedaba 95 min antes de su
presentación por acompañar a Sara Villegas.

Se calcula **parada por parada**, no contra el arranque de la vuelta: el último del
barrido es el más cercano al aeropuerto y casi no madruga, y medirlo contra el
arranque rechaza fusiones que él sí hace.

**MEDIDO Y DESCARTADO:** el techo de espera del PRIMERO (`route_max_wait_min`)
como límite duro **empeora de 13,8 a 27,2 min** — bloquea fusiones buenas, satura
los carros y todo el mundo madruga. No volver a intentarlo.

## 4. Llenar antes que repartir

Llena un carro y saca el siguiente solo cuando el anterior no alcanza, porque **el
tercero es su propio carro o un Uber**. Medido con 3 carros: error 14,6 → 10,1
(20-ago) y 10,0 → 8,5 (21-ago), vueltas tarde 2 → 0.

Y **sus propios planes necesitan 3 carros simultáneos** (pico 11:35 el 20-ago,
16:00 el 21-ago): correr con 2 deja gente sin carro por construcción.

## 5. Adelantar antes de dejar sin carro

> *"30 minutos es lo máximo que acepto madrugar a alguien para montarlo con otro."*

A Melisa Arcila (presentación 13:20) la sacó 12:20 con "estar 12:40" en vez de
dejarla sin carro. Sin el tope, el rescate metía a alguien de las 13:00 en la
vuelta de las 3 de la mañana (error 8 → 104 min).

## 6. Reglas firmes (0 excepciones en 99 vueltas)

- **Cupo = 4 personas, no 4 paradas.** Una parada con 3 personas cierra la vuelta.
- **Una portería = una parada.** Dos personas de la misma puerta van en el mismo carro.
- **Horas en múltiplos de 5** (276/276), salvo las llegadas, que copian la hora exacta del vuelo.
- **Un solo deadline por vuelta**: unifica al grupo y sacrifica la presentación individual.
- Entre paradas 5-10 min (15-20 si el conjunto queda lejos). Ahí ya pensamos igual: coincide con OSRM ±3 min.

## 7. Los tiempos de viaje YA ESTÁN BIEN — no mover esas perillas

Sobre sus 134 vueltas, nuestro tramo final da **19,5 min contra sus 20,9**. La
discrepancia con OSRM era **solo el tramo al aeropuerto**, y se corrigió con
`route_airport_factor` = 0,80 (no con el factor de tráfico global, que dañaba los
pasos entre casas). La perilla que sí mueve el error es la **ventana de fusión**:
30 → 20 bajó el error de 16,3 a 10,7 min.

---

## Lo que sigue abierto

**1. El colchón del aeropuerto es decisión suya, no cálculo.** Nuestro solver exige
llegar `route_airport_buffer_min` = 10 min antes de la presentación, como límite
duro. Él no: sobre los 18 bloques de su plan oficial del 22-ago el colchón va de
**0 a 30 minutos**, y **dos veces es exactamente 0** (Paulina llega 3:30 para
presentarse 3:30; Angely y Jairo llegan 13:30 para presentarse 13:30). Nunca llega
después de la presentación, pero tampoco reserva los 10. Por eso el tablero marca
'late' ~90% de sus vueltas aunque los tiempos ya estén bien. **Pendiente de su OK.**

**2. Día normal vs día lento.** Su tabla de tiempos es de día normal; en festivo usa
la mitad (mediana 0,50). `route_holiday_shift_min` está mal planteado y sigue en 0
a propósito. Falta saber cómo sabe él, el día antes, que el día va a estar suave.

**3. Reserva → hotel es dato suyo, no derivable.** El 20-ago mandó 2 de 4 al hotel,
el 21-ago 3 de 5, el 22-ago 3 de 4. No hay señal en el formulario que lo prediga:
hace falta que el Google Form pregunte el destino.

**4. Casas.** `Carolina Londoño` sin ubicar. `Santiago Carmona` en conflicto: el
catálogo lo tiene en Séptima con pin, él escribió "Primera" el 21-ago. Faltan
también `Mota` y `Cantabria`.

**5. Gente que él programa y el formulario no trae:** Melisa Arcila, Santi Carmona,
Carolina Londoño, Kriss, Isa Rivera, Francisco.

---

## El pipeline

```bash
python3 scripts/_form-dump.py "<xlsx del Google Form>" /tmp/form.json
set -a; source .env.dev; set +a
node scripts/plan-desde-formulario.mjs /tmp/form.json YYYY-MM-DD --carros=3 --hueco=20 --json=/tmp/p.json
node scripts/plan-a-whatsapp.mjs /tmp/p.json      # el mensaje que se le manda
node scripts/_vs-jefe.mjs /tmp/p.json plan-YYYY-MM-DD-correccion-jefe.txt   # el medidor
```

`plan-desde-formulario.mjs` **no reimplementa nada**: recorta `admin-rutas.js` y
evalúa el solver real de la app. Si el solver cambia, el papel cambia con él.

Otros medidores: `reglas-jefe.mjs` (estadística de todas las reglas sobre todo el
corpus), `_diff-jefe.mjs` (tramo final vuelta por vuelta),
`comparar-con-jefe.mjs` (corre nuestro modelo sobre sus vueltas tal como él las armó).

## Historial de precisión

Error absoluto medio de la hora de recogida, persona por persona:

| día | contra qué | resultado |
|---|---|---|
| 20-ago | su corrección | 16,3 → **10,7** (ventana de fusión 30 → 20) |
| 21-ago | su corrección | **9,7** → 8,3 (día no usado para calibrar) |
| 22-ago | su corrección de salidas | 13,8 → **9,4** (barrido + techo de madrugada) |
| 22-ago | su **plan oficial** | 13,3 → **8,7** · 15 de 34 dentro de ±5 min · 3 con 20+ |
