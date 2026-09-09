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

## 8. Una parada sola = el tramo final, sin colchón encima (8-sep-2026)

> *"Danna León debe estar 3:10 y la recoges 2:25… es la madrugada, no hay
> carros, más de 30 min."* (la profa, con razón)

Medido sobre **20 planes suyos / 310 vueltas de salida** (`_solo-por-franja.mjs`):
de la ÚLTIMA recogida al "deben estar" pone **20 min, mediana 20 en las SEIS
franjas**, sola o con varias paradas; máximo 30 de noche, 35 de día. Su tabla de
zona (40-60 "del primero al aeropuerto") **no la cumple ni una vez para una
persona sola**. El código la había generalizado a las vueltas de una parada, y
encima restaba `route_depart_cushion_min` (5) y redondeaba hacia abajo. Anatomía
de Danna: 25 real + 15 tabla + 10 buffer + 5 colchón = 2:25 para 3:20, con el
carro parado en el terminal media hora a las 3 a.m. De día no se veía porque los
carros están ocupados y la disponibilidad manda; de noche nada frena.

Cambios en `admin-rutas.js`: la tabla de zona solo programa vueltas de VARIAS
paradas; sin `CUSHION` al programar la salida (el único margen es
`route_airport_buffer_min`; **`route_depart_cushion_min` quedó sin uso**); el
techo de madrugada se mide contra la salida que de verdad se programa (tabla +
redondeo a 5), y el rescate lo comprueba a TODOS los de la vuelta.

Contra su corrección del 7-sep: sesgo de madrugada **+4,9 → −0,6 min**,
promedio 41,6 vs sus 42,2, **0 personas sobre 60** (antes 4), error 10,1 → 9,1,
vueltas iguales 10/17 sin cambio, sin carro 1 sin cambio.

## 9. La oleada vecina se toma por partes (9-sep-2026)

> *"En el primer turno un carro podía llevar a las 3 y dividiste eso en 2
> carros; más adelante no hay carros para responder a la demanda."* (la profa)

El solver agrupa por hora exacta de presentación y luego fusiona oleadas
vecinas, pero **absorbía la oleada vecina ENTERA o nada**. El 9-sep la de las
3:55 era Ana Lucía sola y la de las 4:00 traía 5 personas: 1 + 5 pasa del cupo,
no se probaba nada más, Ana Lucía salía sola, ese carro se gastaba en ella y a
las 4:30 Juanita, Jolene y Danna quedaban sin carro. Él toma PARTE de la
oleada: Sara Valencia + Ana Lucía + Carlos en un carro, Sara Jaramillo + Alfonso
en otro, y el tercero libre para Olivar y Llanogrande (3:45 → 4:20).

Cambio en `admin-rutas.js`: si la oleada vecina no cabe entera, se prueban sus
porterías una a una con las mismas cuatro pruebas (cupo, barrido, techo de
madrugada, económica) y las que no pasan siguen como oleada propia.

Medido en los **7 días con corrección suya** (19-23 ago, 7 y 9 sep): ninguno
empeora (20, 21, 23-ago y 7-sep idénticos; 19-ago 11,1 → 9,7 y tarde 1 → 0;
22-ago 8,9 → 8,6). **9-sep: sin carro 3 → 0, error 8,5 → 7,7, y la vuelta de
las 4:30 sale idéntica a la suya.**

Lo que todavía no calca: **quién va con quién en el primer carro**. Su tríada
Sara Valencia + Ana Lucía + Carlos la hace 3:00 → 3:40 (40 min); nuestro
recorrido desde *Marinilla vereda* da 52 y el techo la rechaza con 70. Ponemos
Sara Valencia + Ana Lucía y mandamos a Carlos con Sara Jaramillo y Alfonso: en
carros da lo mismo. Ver abierto #6.

Diagnósticos nuevos en `plan-desde-formulario.mjs`: `--por-que-rescate` y
`--por-que-techo` imprimen por qué se rechaza cada rescate / cada fusión.
El auditor (`_auditar-plan.mjs`) mide desde entonces **la hora impresa**
(redondeada a 5 como el mensaje), no el minuto interno: Leslie 10:44 daba "61"
con el mensaje diciendo 10:45.

## Lo que sigue abierto

**0. El colchón real son 20 minutos, no 10** (dato del 23-ago, `_colchon-real.mjs`).
Sobre las **70 vueltas de salida** del 19 al 23 de agosto, su "deben estar" cae a
una mediana de **20 min antes de la presentación** (promedio 17,8; rango −20 a
+50; medianas por día 10 · 22 · 20 · 20 · 20). Nuestro solver apunta siempre a
10. No es contradicción con su frase de "por más tardar debe llegar 15:45": 10 es
el **límite**, 20 es la **puntería**. Cambiarlo suelto empeora todo (ver arriba);
hay que cambiarlo junto con las duraciones, y eso todavía no cuadra.

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

**6. Marinilla sigue 12 min más lenta que él (9-sep).** Sara Valencia está en
el catálogo en *Marinilla vereda* (42,9 min OSRM, coordenada DMS "de la lista");
Camila Vélez en *Marinilla centro* (37,6). Él escribe "Marinilla" a secas para
las dos y hace Marinilla → Planté → Manzanillos → MDE en 40. **Preguntar dónde
vive Sara Valencia** antes de tocar tiempos.

**7. Danna = "Llanogrande" según él (9-sep).** Con `--plan-jefe=todos` cayó en
el sitio *Llanogrande* del catálogo, que es el pin de Jairo García (16,8 min);
antes estaba en Río Vivo (20). Tres minutos, pero es el pin de otro. Preguntar.

**8. El colchón de día NO es una perilla (9-sep).** Entrega 20-35 min antes de
la presentación de día (Wilson 30, Ana Upegui 30, Lina 25, Camila 35); nosotros
10. Probado `--buffer=15/20/25` en 9-sep y 7-sep: a 15 el 9-sep baja a 6,4 de
error (18/31 dentro de ±5) pero el 7-sep pasa de 1 a **5 sin carro**; a 20 y 25
peor. Él entrega antes solo cuando el carro está libre de todos modos → sería un
colchón ELÁSTICO por holgura, no un número. Decisión de diseño.

**9. Llegadas: los del MISMO VUELO van en el mismo carro (9-sep).** Dayana y
Fernando (JA5473) juntos y Lina (23:10) aparte; nosotros llenamos por ventana y
dejamos a Dayana sola. También unificó Gloria y Melina (9322/9332, dedazo del
formulario). Es la agrupación de llegadas en la app; sin medir.

**10. Hay DOS hoteles (7-sep): Río Verde y Movich.** El modelo tiene una
coordenada (0059) y el solver no lo rutea. `¿ES UNA RESERVA?` = SI → hotel, 7 de
7 el 7-sep y 2 de 2 el 9-sep ("Hotel Rioverde R", "Hotel R"); lo que el
formulario no dice es cuál.

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
| 23-ago | su corrección | **9,4** · 25 de 31 emparejadas |
| 7-sep | su corrección | **10,1** → 9,1 (sección 8) · 10 de 17 vueltas iguales · sesgo madrugada +4,9 → −0,6 |
| 9-sep | su corrección | **8,5** → 7,7 (sección 9) · 12 de 18 vueltas iguales · sin carro 3 → 0 |

Medido el 23-ago sobre los cinco días con formulario (19 al 23), el error medio
está clavado en **~10 min** y **ninguna perilla lo baja**:

| variante | 19 | 20 | 21 | 22 | 23 | media |
|---|---|---|---|---|---|---|
| como está hoy | 10,8 | 11,2 | 10,3 | 8,4 | 9,4 | **10,0** |
| sin tabla de zona | 12,2 | 13,0 | 10,7 | 8,6 | **7,6** | 10,4 |
| colchón de zona siempre | 10,2 | 12,0 | 10,8 | 8,3 | 8,8 | 10,0 |
| entregar 20 min antes | 11,0 | 15,8 | 12,8 | 13,6 | 15,3 | 13,7 |
| 20 min antes + sin tabla | 11,3 | 14,1 | 11,8 | 12,6 | 12,7 | 12,5 |

**No mover nada.** Lo que se ve bien en un día se cae en otros dos: "sin tabla"
gana el 23 y pierde el 19 y el 20. Es la trampa de calibrar contra la última
corrección.

**Y explica por qué el modelo acierta: por compensación.** Sus vueltas duran
menos que las nuestras (en la madrugada del 23, 20-30 min contra nuestros 35-50)
pero él entrega mucho antes de la presentación. Las dos cuentas se cancelan.
Arreglar una sola **empeora** el resultado, y por eso subir el colchón a 20 sale
peor que dejarlo en 10 aunque 20 sea su número real.
